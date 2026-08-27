const express = require("express");
const { randomUUID } = require("node:crypto");

const { callDestination, readJsonResponse, fetchCsrfToken } = require("./lib/destination");
const jobStore = require("./lib/joblog-store");
const { loadCompanyCustomers, assertCustomersInCompany, CompanyValidationError } = require("./lib/customer-company");

const app = express();
const port = process.env.PORT || 8080;

// [CABA_COMPANY_PRICING_S4_STORE]
const PRICING_CONFIG = {
  conditionTable: process.env.PRICING_CONDITION_TABLE || "905",
  conditionType: process.env.PRICING_CONDITION_TYPE || "Z901",
  country: process.env.PRICING_COUNTRY || "AR",
  companyCode: process.env.PRICING_COMPANY_CODE || "",
  customCompanyCodeField:
    process.env.PRICING_CUSTOM_COMPANY_FIELD || "YY1_COMPANYCODE_PCH",
  rateUnit: process.env.PRICING_RATE_UNIT || "%",
  taxCode: process.env.PRICING_TAX_CODE || "SD"
};

const BUSINESS_PARTNER_DESTINATION =
  process.env.S4_BUSINESS_PARTNER_DESTINATION || "S4HANA-BP";
const PRICING_DESTINATION =
  process.env.S4_PRICING_DESTINATION || "S4HANA-PRICING";

const BP_TAX_CONFIG = {
  customerTaxGroupingCode: "IB1",
  subjectedEndDate: "9999-12-31T00:00:00"
};

const JOB_PROGRESS_UPDATE_EVERY = 1;

app.use(express.json({ limit: "10mb" }));

function fetchPricingCsrfToken() {
  return fetchCsrfToken(PRICING_DESTINATION, "/sap/opu/odata/sap/API_SLSPRICINGCONDITIONRECORD_SRV/");
}

function fetchBpCsrfToken() {
  return fetchCsrfToken(BUSINESS_PARTNER_DESTINATION, "/sap/opu/odata/sap/API_BUSINESS_PARTNER/");
}

function escapeODataKey(value) {
  return String(value || "").replace(/'/g, "''");
}

function getCustomerTaxGroupingKeyPath(customer) {
  return "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_CustomerTaxGrouping(Customer='" +
    escapeODataKey(customer) +
    "',CustomerTaxGroupingCode='" +
    escapeODataKey(BP_TAX_CONFIG.customerTaxGroupingCode) +
    "')";
}

function getCustomerTaxGroupingNavigationPath(customer) {
  return "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_Customer('" +
    escapeODataKey(customer) +
    "')/to_CustomerTaxGrouping";
}

function toFiscalSubjectedStartDate(validFrom) {
  const parts = String(validFrom || "").split(".");

  if (parts.length === 3) {
    return parts[2] + "-" + parts[1] + "-" + parts[0] + "T00:00:00";
  }

  const isoMatch = String(validFrom || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return isoMatch[1] + "-" + isoMatch[2] + "-" + isoMatch[3] + "T00:00:00";
  }

  return toODataDateTime(validFrom);
}

function getCustomerTaxGroupingPayload(row) {
  return {
    CustTaxGroupSubjectedStartDate: toFiscalSubjectedStartDate(row.validFrom),
    CustTaxGroupSubjectedEndDate: BP_TAX_CONFIG.subjectedEndDate
  };
}

function isCustomerTaxGroupingAlreadyExistsError(errorText) {
  return String(errorText || "").indexOf("CVI_EI/015") !== -1 ||
    String(errorText || "").indexOf("already exists") !== -1 ||
    String(errorText || "").indexOf("ya existe") !== -1;
}

async function updateCustomerTaxGrouping(row, bpCsrfToken) {
  const payload = getCustomerTaxGroupingPayload(row);

  const response = await callDestination(BUSINESS_PARTNER_DESTINATION, getCustomerTaxGroupingKeyPath(row.customer), {
    method: "PATCH",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": bpCsrfToken.token,
      "Cookie": bpCsrfToken.cookie,
      "If-Match": "*"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status + " al actualizar categoria fiscal IB1: " + await response.text());
  }
}

async function createCustomerTaxGrouping(row, bpCsrfToken) {
  const payload = Object.assign(
    {
      CustomerTaxGroupingCode: BP_TAX_CONFIG.customerTaxGroupingCode
    },
    getCustomerTaxGroupingPayload(row)
  );

  const createResponse = await callDestination(BUSINESS_PARTNER_DESTINATION, getCustomerTaxGroupingNavigationPath(row.customer), {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": bpCsrfToken.token,
      "Cookie": bpCsrfToken.cookie
    },
    body: JSON.stringify(payload)
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();

    if (isCustomerTaxGroupingAlreadyExistsError(errorText)) {
      await updateCustomerTaxGrouping(row, bpCsrfToken);
      return;
    }

    throw new Error("HTTP " + createResponse.status + " al crear categoria fiscal IB1: " + errorText);
  }
}

async function ensureCustomerTaxGrouping(row, bpCsrfToken) {
  const customer = row.customer;

  if (!customer) {
    throw new Error("No se pudo actualizar categoria fiscal: el registro no tiene Customer.");
  }

  const keyPath = getCustomerTaxGroupingKeyPath(customer) + "?$format=json";

  const readResponse = await callDestination(BUSINESS_PARTNER_DESTINATION, keyPath, {
    headers: {
      "Accept": "application/json"
    }
  });

  if (readResponse.ok) {
    await updateCustomerTaxGrouping(row, bpCsrfToken);
    return;
  }

  if (readResponse.status === 404) {
    await createCustomerTaxGrouping(row, bpCsrfToken);
    return;
  }

  throw new Error("HTTP " + readResponse.status + " al consultar categoria fiscal IB1: " + await readResponse.text());
}

async function findPricingCondition(row) {
  const validFrom = toODataDateTime(row.validFrom);
  const validTo = toODataDateTime(row.validTo);
  const companyCode = String(
    row.companyCode || PRICING_CONFIG.companyCode || ""
  ).trim();

  if (!/^\d{4}$/.test(companyCode)) {
    throw new Error("No se recibió una sociedad válida para buscar la condición Z901.");
  }

  const filter = [
    "ConditionType eq '" + PRICING_CONFIG.conditionType + "'",
    "Country eq '" + PRICING_CONFIG.country + "'",
    "Customer eq '" + row.customer + "'",
    PRICING_CONFIG.customCompanyCodeField + " eq '" + companyCode + "'",
    "ConditionValidityStartDate eq datetime'" + validFrom + "'",
    "ConditionValidityEndDate eq datetime'" + validTo + "'"
  ].join(" and ");

  const path = "/sap/opu/odata/sap/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgCndnRecdValidity" +
    "?$select=ConditionRecord,ConditionValidityStartDate,ConditionValidityEndDate" +
    "&$filter=" + encodeURIComponent(filter) +
    "&$format=json";

  const response = await callDestination(PRICING_DESTINATION, path, {
    headers: { "Accept": "application/json" }
  });
  const data = await readJsonResponse(response, "al buscar condición Z901 por sociedad");
  const results = data && data.d && data.d.results ? data.d.results : [];

  return results[0] || null;
}

async function readPricingConditionRecord(conditionRecord) {
  const path = "/sap/opu/odata/sap/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgConditionRecord('" +
    encodeURIComponent(conditionRecord) +
    "')?$format=json";

  const response = await callDestination(PRICING_DESTINATION, path, {
    headers: { "Accept": "application/json" }
  });
  const data = await readJsonResponse(response, "al leer ETag de condicion");
  const etag = data && data.d && data.d.__metadata && data.d.__metadata.etag;

  if (!etag) {
    throw new Error("No se pudo obtener ETag de la condicion " + conditionRecord);
  }

  return etag;
}

async function createPricingCondition(row, csrfToken) {
  const companyCode = String(
    row.companyCode || PRICING_CONFIG.companyCode || ""
  ).trim();

  if (!/^\d{4}$/.test(companyCode)) {
    throw new Error("No se recibió una sociedad válida para crear la condición Z901.");
  }

  const validity = {
    ConditionValidityStartDate: toODataDateTime(row.validFrom),
    ConditionValidityEndDate: toODataDateTime(row.validTo),
    ConditionType: PRICING_CONFIG.conditionType,
    Country: PRICING_CONFIG.country,
    Customer: row.customer
  };

  validity[PRICING_CONFIG.customCompanyCodeField] = companyCode;

  const payload = {
    ConditionTable: PRICING_CONFIG.conditionTable,
    ConditionType: PRICING_CONFIG.conditionType,
    ConditionRateValue: normalizeRate(row.rate),
    ConditionRateValueUnit: PRICING_CONFIG.rateUnit,
    ConditionTaxCode: PRICING_CONFIG.taxCode,
    to_SlsPrcgCndnRecdValidity: [validity]
  };

  const response = await callDestination(PRICING_DESTINATION, "/sap/opu/odata/sap/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgConditionRecord", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken.token,
      "Cookie": csrfToken.cookie
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status + " al crear condicion: " + await response.text());
  }
}

async function updatePricingCondition(conditionRecord, row, csrfToken) {
  const etag = await readPricingConditionRecord(conditionRecord);
  const payload = {
    ConditionRateValue: normalizeRate(row.rate),
    ConditionRateValueUnit: PRICING_CONFIG.rateUnit,
    ConditionTaxCode: PRICING_CONFIG.taxCode
  };

  const path = "/sap/opu/odata/sap/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgConditionRecord('" +
    encodeURIComponent(conditionRecord) +
    "')";

  const response = await callDestination(PRICING_DESTINATION, path, {
    method: "PATCH",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken.token,
      "Cookie": csrfToken.cookie,
      "If-Match": etag
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status + " al actualizar condicion: " + await response.text());
  }
}

// Explicaciones en espanol para errores conocidos de S/4. El texto crudo de
// la respuesta HTTP queda solo en console.error (cf logs), nunca en pantalla.
const S4_ERROR_EXPLANATIONS = {
  "PRCG_CNDNRECORD_API/066": "la configuracion de precios en S/4 exige un campo que la API no permite informar (p. ej. Sociedad). Debe revisarlo el funcional SD",
  "PRCG_CNDNRECORD_API/023": "la condicion de precio no existe en S/4",
  "CVI_EI/015": "la categoria fiscal ya existe para este cliente"
};

function describeErrorStage(sMessage) {
  const s = String(sMessage || "");

  if (s.indexOf("al crear categoria fiscal") !== -1) return "Error al crear la categoria fiscal IB1";
  if (s.indexOf("al actualizar categoria fiscal") !== -1) return "Error al actualizar la categoria fiscal IB1";
  if (s.indexOf("al consultar categoria fiscal") !== -1) return "Error al consultar la categoria fiscal IB1";
  if (s.indexOf("al crear condicion") !== -1) return "Error al crear la condicion de precio";
  if (s.indexOf("al actualizar condicion") !== -1) return "Error al actualizar la condicion de precio";
  if (s.indexOf("al buscar condicion") !== -1) return "Error al buscar la condicion de precio";
  if (s.indexOf("ETag") !== -1) return "Error al leer la condicion de precio";
  if (s.indexOf("CSRF") !== -1) return "Error de autenticacion contra S/4";
  if (s.indexOf("Timeout") !== -1) return "S/4 no respondio a tiempo";
  return "Error al procesar el registro";
}

function humanizeError(error) {
  const sRaw = String((error && error.message) || error || "");
  const sStage = describeErrorStage(sRaw);
  let sCode = "";
  let sDetail = "";

  const iJson = sRaw.indexOf("{");

  if (iJson !== -1) {
    try {
      const oS4 = JSON.parse(sRaw.slice(iJson));
      sCode = (oS4 && oS4.error && oS4.error.code) || "";
      sDetail = (oS4 && oS4.error && oS4.error.message && oS4.error.message.value) || "";
    } catch (ignore) {
      // la respuesta no era JSON: se usa solo la etapa
    }
  }

  const sExplanation = S4_ERROR_EXPLANATIONS[sCode] || sDetail;
  let sMessage = sStage;

  if (sExplanation) {
    sMessage += ": " + sExplanation;
  }

  if (sCode) {
    sMessage += " [" + sCode + "]";
  }

  return sMessage;
}

async function updateJobProgress(jobId, message) {
  await jobStore.updateJob(jobId, { message: message });
}

// El log por linea nunca debe tirar abajo el procesamiento del job.
async function safeCreateLogEntry(jobId, entry) {
  try {
    await jobStore.createLogEntry(Object.assign(
      {
        ID: randomUUID(),
        job_ID: jobId,
        timestamp: new Date().toISOString()
      },
      entry
    ));
  } catch (error) {
    console.error("Job " + jobId + " no pudo registrar log entry", error.message || error);
  }
}

async function processJob(jobId, jobData) {
  let created = 0;
  let updated = 0;
  let failed = 0;

  try {
    const validRows = Array.isArray(jobData.rows) ? jobData.rows : [];
    const totalRows = Number(jobData.totalRows || validRows.length);

    console.log("Job " + jobId + " iniciado. Registros validos: " + validRows.length);
    await updateJobProgress(jobId, "Job iniciado. Registros validos: " + validRows.length + ".");

    console.log("Job " + jobId + " obteniendo CSRF token BP");
    const bpCsrfToken = await fetchBpCsrfToken();

    console.log("Job " + jobId + " obteniendo CSRF token Pricing");
    const csrfToken = await fetchPricingCsrfToken();

    for (let index = 0; index < validRows.length; index += 1) {
      const row = validRows[index];
      const rowNumber = index + 1;
      const rowLabel = rowNumber + "/" + validRows.length + " customer " + row.customer + " CUIT " + row.cuit;
      let rowAction = "SIN_CAMBIOS";

      try {
        console.log("Job " + jobId + " iniciando " + rowLabel);

        if (rowNumber % JOB_PROGRESS_UPDATE_EVERY === 0) {
          await updateJobProgress(jobId, "Procesando " + rowLabel + ".");
        }

        console.log("Job " + jobId + " creando/actualizando categoria fiscal IB1 para " + rowLabel);
        await ensureCustomerTaxGrouping(row, bpCsrfToken);
        console.log("Job " + jobId + " categoria fiscal IB1 OK para " + rowLabel);

        console.log("Job " + jobId + " buscando condicion existente para " + rowLabel);
        const existing = await findPricingCondition(row);
        console.log("Job " + jobId + " busqueda pricing OK para " + rowLabel + ". Existe: " + Boolean(existing));

        if (existing) {
          try {
            console.log("Job " + jobId + " actualizando condicion " + existing.ConditionRecord + " para " + rowLabel);
            await updatePricingCondition(existing.ConditionRecord, row, csrfToken);
            updated += 1;
            rowAction = "COND_ACTUALIZADA";
            console.log("Job " + jobId + " condicion actualizada para " + rowLabel);
          } catch (updateError) {
            if (isMissingConditionRecordError(updateError)) {
              console.log("Job " + jobId + " condicion inexistente al actualizar. Creando nueva para " + rowLabel);
              await createPricingCondition(row, csrfToken);
              created += 1;
              rowAction = "COND_CREADA";
              console.log("Job " + jobId + " condicion creada para " + rowLabel);
            } else {
              throw updateError;
            }
          }
        } else {
          console.log("Job " + jobId + " creando condicion nueva para " + rowLabel);
          await createPricingCondition(row, csrfToken);
          created += 1;
          rowAction = "COND_CREADA";
          console.log("Job " + jobId + " condicion creada para " + rowLabel);
        }

        await updateJobProgress(
          jobId,
          "Procesado " + rowLabel + ". Creadas: " + created + ". Actualizadas: " + updated + ". Errores: " + failed + "."
        );

        await safeCreateLogEntry(jobId, {
          numeroLinea: rowNumber,
          cuit: row.cuit,
          cliente: row.customer,
          razonSocial: row.razonSocial || "",
          accion: rowAction,
          resultado: "OK",
          mensaje: "Categoria IB1 y condicion procesadas."
        });
      } catch (error) {
        failed += 1;

        console.error("Job " + jobId + " error procesando " + rowLabel, error);

        await updateJobProgress(
          jobId,
          "Error en " + rowLabel + ". Creadas: " + created + ". Actualizadas: " + updated + ". Errores: " + failed + ". Ultimo error: " + humanizeError(error)
        );

        await safeCreateLogEntry(jobId, {
          numeroLinea: rowNumber,
          cuit: row.cuit,
          cliente: row.customer,
          razonSocial: row.razonSocial || "",
          accion: "ERROR",
          resultado: "ERROR",
          mensaje: humanizeError(error)
        });
      }
    }

    console.log("Job " + jobId + " finalizado. Creadas: " + created + ". Actualizadas: " + updated + ". Errores: " + failed + ".");

    await jobStore.updateJob(jobId, {
      status: failed ? "FINALIZADO_CON_ERRORES" : "FINALIZADO",
      startedAt: jobData.startedAt || null,
      finishedAt: new Date().toISOString(),
      totalRows: totalRows,
      validRows: validRows.length,
      createdCount: created,
      updatedCount: updated,
      errorCount: failed,
      message: "Proceso finalizado. Creadas: " + created + ". Actualizadas: " + updated + ". Errores: " + failed + "."
    });
  } catch (error) {
    console.error("Job " + jobId + " termino con error general", error);

    await jobStore.updateJob(jobId, {
      status: "ERROR",
      startedAt: jobData.startedAt || null,
      finishedAt: new Date().toISOString(),
      errorCount: 1,
      message: humanizeError(error)
    });
  }
}

function normalizeRate(value) {
  return String(value || "").replace("%", "").replace(",", ".").trim();
}

function toODataDateTime(value) {
  const parts = String(value || "").split(".");
  if (parts.length === 3) {
    return parts[2] + "-" + parts[1] + "-" + parts[0] + "T00:00:00";
  }
  return value + "T00:00:00";
}

function isMissingConditionRecordError(error) {
  const message = String(error && error.message ? error.message : error || "");
  return message.indexOf("PRCG_CNDNRECORD_API/023") !== -1 ||
    message.indexOf("no existe") !== -1;
}

// [CABA_COMPANY_JOB_S4_STORE]
app.get("/api/company-codes", async function (req, res, next) {
  try {
    const path =
      "/sap/opu/odata4/sap/zsb_pa_companycode_api/srvd_a2x/" +
      "sap/zsd_pa_companycode/0001/CompanyCodes" +
      "?$select=CompanyCode,CompanyCodeName&$orderby=CompanyCode";

    const response = await callDestination(BUSINESS_PARTNER_DESTINATION, path, {
      method: "GET",
      headers: {
        "Accept": "application/json"
      }
    });

    const data = await readJsonResponse(response, "al consultar sociedades");
    const values = data && Array.isArray(data.value) ? data.value : [];

    const companyCodes = values
      .map(function (item) {
        return {
          companyCode: String(item.CompanyCode || ""),
          companyCodeName: String(item.CompanyCodeName || "")
        };
      })
      .filter(function (item) {
        return /^\d{4}$/.test(item.companyCode);
      });

    res.json({
      source: "S4",
      companyCodes: companyCodes
    });
  } catch (error) {
    next(error);
  }
});

function sendCompanyValidationError(res, error) {
  const known = error instanceof CompanyValidationError;
  res.status(known ? error.statusCode : 503).json({
    code: known ? error.code : "COMPANY_VALIDATION_UNAVAILABLE",
    message: known ? error.message : "No se pudo validar la sociedad. No se inicio el procesamiento."
  });
}

// Solo lectura; no se reutiliza el indice entre preparaciones ni entre jobs.
app.get("/api/customer-company-index", async function (req, res) {
  res.set("Cache-Control", "no-store");
  try {
    const companyCode = String(req.query.companyCode || "").trim();
    const customers = await loadCompanyCustomers(BUSINESS_PARTNER_DESTINATION, companyCode);
    res.json({ companyCode: companyCode, customers: Array.from(customers) });
  } catch (error) {
    sendCompanyValidationError(res, error);
  }
});

app.get("/api/health", async function (req, res) {
  try {
    const store = await jobStore.ping();

    res.json({
      status: "OK",
      jobStore: store,
      pricing: {
        conditionTable: PRICING_CONFIG.conditionTable,
        conditionType: PRICING_CONFIG.conditionType,
        country: PRICING_CONFIG.country,
        companyCode: PRICING_CONFIG.companyCode,
        customCompanyCodeField: PRICING_CONFIG.customCompanyCodeField
      },
      destinations: {
        businessPartner: BUSINESS_PARTNER_DESTINATION,
        pricing: PRICING_DESTINATION
      }
    });
  } catch (error) {
    res.status(500).json({
      status: "ERROR",
      jobStoreMode: jobStore.mode,
      message: error.message
    });
  }
});

app.post("/api/jobs", async function (req, res) {
  const id = randomUUID();
  const startedAt = new Date();
  const fileName = req.body.fileName || "";
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const totalRows = Number(req.body.totalRows || rows.length);
  const companyCode = String(req.body.companyCode || PRICING_CONFIG.companyCode || "").trim();

  if (!rows.length) {
    res.status(400).json({
      message: "No se recibieron registros filtrados para procesar."
    });
    return;
  }

  if (!/^\d{4}$/.test(companyCode)) {
    res.status(400).json({
      message: "Debe seleccionar una sociedad válida."
    });
    return;
  }

  // Defensa de backend: una UI anterior o alterada no puede omitir este control.
  // Debe completarse antes de persistir el job o modificar categorias/condiciones.
  try {
    const customers = await loadCompanyCustomers(BUSINESS_PARTNER_DESTINATION, companyCode);
    assertCustomersInCompany(rows, customers, companyCode);
  } catch (error) {
    sendCompanyValidationError(res, error);
    return;
  }

  const jobRows = rows.map(function (row) {
    return Object.assign({}, row, {
      customer: row.customer.trim(),
      companyCode: companyCode
    });
  });

  await jobStore.createJob({
    ID: id,
    fileName: fileName,
    status: "EN_PROCESO",
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    totalRows: totalRows,
    validRows: jobRows.length,
    createdCount: 0,
    updatedCount: 0,
    errorCount: 0,
    message: "Job en proceso.",
    createdBy: null
  });

  setImmediate(function () {
    processJob(id, {
      totalRows: totalRows,
      companyCode: companyCode,
      startedAt: startedAt.toISOString(),
      rows: jobRows
    });
  });

  res.status(202).json({
    id: id,
    status: "EN_PROCESO",
    startedAt: startedAt.toISOString()
  });
});

app.get("/api/jobs", async function (req, res) {
  const jobs = await jobStore.listJobs(Number(req.query.limit) || 20);

  res.json(jobs.map(function (job) {
    return {
      id: job.ID,
      fileName: job.fileName,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      totalRows: job.totalRows,
      validRows: job.validRows,
      createdCount: job.createdCount,
      updatedCount: job.updatedCount,
      errorCount: job.errorCount,
      message: job.message
    };
  }));
});

app.get("/api/jobs/:id/logs", async function (req, res) {
  const logs = await jobStore.getLogEntriesByJobId(req.params.id);
  res.json(logs);
});

app.get("/api/jobs/:id", async function (req, res) {
  const job = await jobStore.getJobById(req.params.id);

  if (!job) {
    res.status(404).json({ message: "Job no encontrado." });
    return;
  }

  res.json({
    id: job.ID,
    fileName: job.fileName,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    TotalRows: job.totalRows,
    validRows: job.validRows,
    createdCount: job.createdCount,
    updatedCount: job.updatedCount,
    errorCount: job.errorCount,
    message: job.message
  });
});

app.listen(port, function () {
  console.log("padrones-tax-upload-api listening on port " + port + " (job store: " + jobStore.mode + ")");
});
