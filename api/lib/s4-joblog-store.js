"use strict";

/*
 * Persistencia de jobs del padron CABA en S/4 Public (tablas Z propias,
 * servicio OData v2 ZFI_PADRON_CABA_SRV, desarrollo ADT). Mismo patron que
 * zfi-padron-embargo, con los campos de CABA.
 *
 * El server.js trabaja con nombres internos en ingles (fileName, status...);
 * este store traduce a los alias en espanol que expone el servicio Z
 * (archivo, estado, iniciadoEn...) y viceversa.
 *
 * Todo configurable por variables de entorno:
 *   S4_JOBLOG_DESTINATION    (default S4HANA-BP: misma URL/credenciales)
 *   S4_JOBLOG_SERVICE_PATH   (default /sap/opu/odata/sap/ZFI_PADRON_CABA_SRV)
 *   S4_JOBLOG_JOBS_ENTITYSET (default JobsSet)
 *   S4_JOBLOG_LOGS_ENTITYSET (default JobLogEntriesSet)
 *   S4_JOBLOG_ID_KEY_TYPE    guid (default) | string
 */

const { callDestination, readJsonResponse, fetchCsrfToken } = require("./destination");
const { buildS4JoblogSchema } = require("./s4-joblog-schema");

const DESTINATION_NAME = process.env.S4_JOBLOG_DESTINATION || "S4HANA-BP";
const SERVICE_PATH = (process.env.S4_JOBLOG_SERVICE_PATH || "/sap/opu/odata/sap/ZFI_PADRON_CABA_SRV").replace(/\/$/, "");
const JOBS_ENTITY_SET = process.env.S4_JOBLOG_JOBS_ENTITYSET || "JobsSet";
const LOGS_ENTITY_SET = process.env.S4_JOBLOG_LOGS_ENTITYSET || "JobLogEntriesSet";
const ID_KEY_TYPE = (process.env.S4_JOBLOG_ID_KEY_TYPE || "guid").toLowerCase();

const MAX_RETRIES = (function () {
  const n = parseInt(process.env.S4_JOBLOG_MAX_RETRIES, 10);
  return isNaN(n) ? 2 : n;
})();
const RETRY_BASE_DELAY_MS = 500;

const JOB_FIELDS = [
  "fileName", "status", "startedAt", "finishedAt", "totalRows", "validRows",
  "createdCount", "updatedCount", "errorCount", "message", "createdBy"
];
const JOB_DATE_FIELDS = ["startedAt", "finishedAt"];
const JOB_COUNTER_FIELDS = ["totalRows", "validRows", "createdCount", "updatedCount", "errorCount"];
const JOB_FIELD_MAXLEN = {
  fileName: 255,
  status: 30,
  message: 500,
  createdBy: 100
};

// Campos del log tal como los expone el servicio Z (ya en espanol).
const LOG_FIELD_MAXLEN = {
  cuit: 13,
  cliente: 10,
  razonSocial: 100,
  accion: 30,
  resultado: 10,
  mensaje: 500
};

function truncStr(v, nMax) {
  const s = v === null || typeof v === "undefined" ? "" : String(v);
  return s.length > nMax ? s.slice(0, nMax) : s;
}

// OData v2 espera fechas como "/Date(ms)/".
function toS4Date(v) {
  if (!v) {
    return null;
  }

  const ms = new Date(v).getTime();
  return isNaN(ms) ? null : "/Date(" + ms + ")/";
}

function fromS4Date(v) {
  const match = /\/Date\((-?\d+)/.exec(String(v || ""));

  if (match) {
    return new Date(Number(match[1])).toISOString();
  }

  return v || null;
}

function mapJobFieldToS4(sField, v) {
  if (JOB_DATE_FIELDS.indexOf(sField) !== -1) {
    return toS4Date(v);
  }

  if (JOB_COUNTER_FIELDS.indexOf(sField) !== -1) {
    return Number(v) || 0;
  }

  if (Object.prototype.hasOwnProperty.call(JOB_FIELD_MAXLEN, sField)) {
    return truncStr(v, JOB_FIELD_MAXLEN[sField]);
  }

  return v;
}

// Mapeo COMPLETO: solo para createJob, donde el caller manda todos los campos.
function mapJobToS4(oJob, oSchema) {
  const oOut = {};
  oOut[oSchema.jobs.key.name] = oJob.ID;

  JOB_FIELDS.forEach(function (sField) {
    const oProperty = oSchema.jobs.fields[sField];
    if (oProperty) {
      oOut[oProperty.name] = mapJobFieldToS4(sField, oJob[sField]);
    }
  });

  return oOut;
}

// Mapeo PARCIAL: para updateJob. NO rellena campos ausentes con defaults,
// asi un PATCH de solo {message} no pisa contadores/fechas ya guardados
// (leccion aprendida del store de embargo).
function buildJobPatchPayload(oPatch, oSchema) {
  const oOut = {};

  JOB_FIELDS.forEach(function (sField) {
    if (!Object.prototype.hasOwnProperty.call(oPatch, sField)) {
      return;
    }

    const oProperty = oSchema.jobs.fields[sField];
    if (oProperty) {
      oOut[oProperty.name] = mapJobFieldToS4(sField, oPatch[sField]);
    }
  });

  return oOut;
}

function fieldValue(o, oProperty, vDefault) {
  return oProperty && Object.prototype.hasOwnProperty.call(o, oProperty.name)
    ? o[oProperty.name]
    : vDefault;
}

function normalizeJobFromS4(o, oSchema) {
  if (!o) {
    return null;
  }

  return {
    ID: o[oSchema.jobs.key.name],
    fileName: fieldValue(o, oSchema.jobs.fields.fileName, null),
    status: fieldValue(o, oSchema.jobs.fields.status, ""),
    startedAt: fromS4Date(fieldValue(o, oSchema.jobs.fields.startedAt, null)),
    finishedAt: fromS4Date(fieldValue(o, oSchema.jobs.fields.finishedAt, null)),
    totalRows: fieldValue(o, oSchema.jobs.fields.totalRows, 0) || 0,
    validRows: fieldValue(o, oSchema.jobs.fields.validRows, 0) || 0,
    createdCount: fieldValue(o, oSchema.jobs.fields.createdCount, 0) || 0,
    updatedCount: fieldValue(o, oSchema.jobs.fields.updatedCount, 0) || 0,
    errorCount: fieldValue(o, oSchema.jobs.fields.errorCount, 0) || 0,
    message: fieldValue(o, oSchema.jobs.fields.message, null),
    createdBy: fieldValue(o, oSchema.jobs.fields.createdBy, null)
  };
}

function setLogField(oOut, oSchema, sField, vValue) {
  const oProperty = oSchema.logs && oSchema.logs.fields[sField];
  if (oProperty) {
    oOut[oProperty.name] = vValue;
  }
}

function mapLogToS4(oEntry, oSchema) {
  if (!oSchema.logs || !oSchema.logs.key) {
    throw new Error("El servicio OData no expone " + LOGS_ENTITY_SET + ".");
  }

  const oOut = {};
  oOut[oSchema.logs.key.name] = oEntry.ID;
  setLogField(oOut, oSchema, "jobId", oEntry.job_ID);
  setLogField(oOut, oSchema, "lineNumber", Number(oEntry.numeroLinea) || 0);
  setLogField(oOut, oSchema, "cuit", truncStr(oEntry.cuit || "", LOG_FIELD_MAXLEN.cuit));
  setLogField(oOut, oSchema, "customer", truncStr(oEntry.cliente || "", LOG_FIELD_MAXLEN.cliente));
  setLogField(oOut, oSchema, "businessName", truncStr(oEntry.razonSocial || "", LOG_FIELD_MAXLEN.razonSocial));
  setLogField(oOut, oSchema, "action", truncStr(oEntry.accion || "", LOG_FIELD_MAXLEN.accion));
  setLogField(oOut, oSchema, "result", truncStr(oEntry.resultado || "", LOG_FIELD_MAXLEN.resultado));
  setLogField(oOut, oSchema, "message", truncStr(oEntry.mensaje || "", LOG_FIELD_MAXLEN.mensaje));
  setLogField(oOut, oSchema, "timestamp", toS4Date(oEntry.timestamp));
  return oOut;
}

function keyPredicate(sId, oKey) {
  const sEscaped = String(sId || "").replace(/'/g, "''");

  if (ID_KEY_TYPE === "guid" && (!oKey || oKey.type === "Edm.Guid")) {
    return "(guid'" + sEscaped + "')";
  }

  return "('" + sEscaped + "')";
}

function jobsPath() {
  return SERVICE_PATH + "/" + JOBS_ENTITY_SET;
}

function logsPath() {
  return SERVICE_PATH + "/" + LOGS_ENTITY_SET;
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// CSRF cacheado: se renueva solo cuando S/4 lo rechaza (403 csrf).
let csrfPromise = null;

function getCsrf(bForce) {
  if (bForce || !csrfPromise) {
    csrfPromise = fetchCsrfToken(DESTINATION_NAME, SERVICE_PATH + "/");
  }

  return csrfPromise;
}

function isCsrfError(response, sBody) {
  return response.status === 403 && String(sBody || "").toLowerCase().indexOf("csrf") !== -1;
}

async function writeRequest(sMethod, sPath, oPayload, sErrorContext) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const csrf = await getCsrf(attempt > 0);
      const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf.token,
        "Cookie": csrf.cookie
      };

      if (sMethod === "PATCH") {
        headers["If-Match"] = "*";
      }

      const response = await callDestination(DESTINATION_NAME, sPath, {
        method: sMethod,
        headers: headers,
        body: JSON.stringify(oPayload)
      });

      if (response.ok) {
        const text = await response.text();
        return text ? JSON.parse(text) : {};
      }

      const sBody = await response.text();

      if (isCsrfError(response, sBody)) {
        lastError = new Error("CSRF rechazado " + sErrorContext + ": " + sBody);
        continue;
      }

      if (response.status >= 500) {
        lastError = new Error("HTTP " + response.status + " " + sErrorContext + ": " + sBody);
        await delay(RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }

      throw new Error("HTTP " + response.status + " " + sErrorContext + ": " + sBody);
    } catch (error) {
      if (String(error && error.message).indexOf("HTTP 4") === 0) {
        throw error;
      }

      lastError = error;
      await delay(RETRY_BASE_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError || new Error("Fallo " + sErrorContext + " tras " + (MAX_RETRIES + 1) + " intentos.");
}

// Si S/4 autogenerara el ID en vez de aceptar el enviado, mapeamos nuestro
// ID -> ID real de S/4 para updates/lecturas del mismo proceso. (El servicio
// Z usa numbering externo, asi que en la practica no deberia activarse.)
const ID_ALIASES = new Map();
let schemaPromise = null;

async function getSchema() {
  if (!schemaPromise) {
    schemaPromise = (async function () {
      const oResponse = await callDestination(DESTINATION_NAME, SERVICE_PATH + "/$metadata", {
        headers: { "Accept": "application/xml" }
      });
      const sMetadata = await oResponse.text();

      if (!oResponse.ok) {
        throw new Error("No se pudo leer $metadata del servicio de jobs (HTTP " + oResponse.status + "): " + sMetadata);
      }

      return buildS4JoblogSchema(sMetadata, JOBS_ENTITY_SET, LOGS_ENTITY_SET);
    })().catch(function (oError) {
      schemaPromise = null;
      throw oError;
    });
  }

  return schemaPromise;
}

function resolveId(sId) {
  return ID_ALIASES.get(sId) || sId;
}

async function createJob(oJob) {
  const oSchema = await getSchema();
  const data = await writeRequest("POST", jobsPath(), mapJobToS4(oJob, oSchema), "al crear job en S/4");
  const created = data && data.d ? data.d : null;

  if (created && created.ID && String(created.ID).toLowerCase() !== String(oJob.ID).toLowerCase()) {
    ID_ALIASES.set(oJob.ID, created.ID);
    console.warn("S/4 asigno ID " + created.ID + " en lugar del enviado " + oJob.ID + ". Se usara el de S/4.");
  }

  return oJob.ID;
}

async function updateJob(sId, oPatch) {
  const oSchema = await getSchema();
  const oPayload = buildJobPatchPayload(oPatch, oSchema);

  if (!Object.keys(oPayload).length) {
    return;
  }

  await writeRequest("PATCH", jobsPath() + keyPredicate(resolveId(sId), oSchema.jobs.key), oPayload, "al actualizar job " + sId + " en S/4");
}

async function getJobById(sId) {
  const oSchema = await getSchema();
  const response = await callDestination(DESTINATION_NAME, jobsPath() + keyPredicate(resolveId(sId), oSchema.jobs.key) + "?$format=json", {
    headers: { "Accept": "application/json" }
  });

  if (response.status === 404) {
    return null;
  }

  const data = await readJsonResponse(response, "al consultar job " + sId + " en S/4");
  return normalizeJobFromS4(data && data.d ? data.d : null, oSchema);
}

async function listJobs(nTop) {
  const oSchema = await getSchema();
  const oOrderProperty = oSchema.jobs.fields.startedAt || oSchema.jobs.key;
  const sPath = jobsPath() +
    "?$orderby=" + encodeURIComponent(oOrderProperty.name + " desc") +
    "&$top=" + (Number(nTop) || 20) +
    "&$format=json";

  const response = await callDestination(DESTINATION_NAME, sPath, {
    headers: { "Accept": "application/json" }
  });

  const data = await readJsonResponse(response, "al listar jobs en S/4");
  const results = data && data.d && data.d.results ? data.d.results : [];

  return results.map(function (oJob) {
    return normalizeJobFromS4(oJob, oSchema);
  });
}

async function getLogEntriesByJobId(sJobId) {
  const oSchema = await getSchema();
  if (!oSchema.logs || !oSchema.logs.fields.jobId) {
    throw new Error("El servicio OData no expone la relación de " + LOGS_ENTITY_SET + " con el job.");
  }
  const sId = String(resolveId(sJobId)).replace(/'/g, "''");
  const oJobIdProperty = oSchema.logs.fields.jobId;
  const sFilter = oJobIdProperty.name + (oJobIdProperty.type === "Edm.Guid" ? " eq guid'" : " eq '") + sId + "'";
  const oLineProperty = oSchema.logs.fields.lineNumber || oSchema.logs.key;
  const sPath = logsPath() +
    "?$filter=" + encodeURIComponent(sFilter) +
    "&$orderby=" + encodeURIComponent(oLineProperty.name + " asc") +
    "&$format=json";

  const response = await callDestination(DESTINATION_NAME, sPath, {
    headers: { "Accept": "application/json" }
  });

  const data = await readJsonResponse(response, "al consultar logs del job " + sJobId);
  const results = data && data.d && data.d.results ? data.d.results : [];

  return results.map(function (o) {
    return {
      numeroLinea: fieldValue(o, oSchema.logs.fields.lineNumber, 0) || 0,
      cuit: fieldValue(o, oSchema.logs.fields.cuit, "") || "",
      cliente: fieldValue(o, oSchema.logs.fields.customer, "") || "",
      razonSocial: fieldValue(o, oSchema.logs.fields.businessName, "") || "",
      accion: fieldValue(o, oSchema.logs.fields.action, "") || "",
      resultado: fieldValue(o, oSchema.logs.fields.result, "") || "",
      mensaje: fieldValue(o, oSchema.logs.fields.message, "") || "",
      timestamp: fromS4Date(fieldValue(o, oSchema.logs.fields.timestamp, null))
    };
  });
}

async function createLogEntry(oEntry) {
  const oSchema = await getSchema();
  const oPayload = mapLogToS4(oEntry, oSchema);

  if (ID_ALIASES.has(oEntry.job_ID)) {
    setLogField(oPayload, oSchema, "jobId", ID_ALIASES.get(oEntry.job_ID));
  }

  await writeRequest("POST", logsPath(), oPayload, "al crear log entry en S/4");
}

async function ping() {
  const response = await callDestination(DESTINATION_NAME, SERVICE_PATH + "/?$format=json", {
    headers: { "Accept": "application/json" }
  });

  if (!response.ok) {
    throw new Error("Servicio Z de jobs no disponible (HTTP " + response.status + "): " + await response.text());
  }

  await getSchema();

  return { store: "s4", servicePath: SERVICE_PATH };
}

module.exports = {
  mode: "s4",
  createJob: createJob,
  updateJob: updateJob,
  getJobById: getJobById,
  listJobs: listJobs,
  createLogEntry: createLogEntry,
  getLogEntriesByJobId: getLogEntriesByJobId,
  ping: ping
};
