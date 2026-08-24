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

// nombre interno (server.js) -> alias del servicio Z (CDS en espanol)
const S4_FIELD_NAMES = {
  fileName: "archivo",
  status: "estado",
  startedAt: "iniciadoEn",
  finishedAt: "finalizadoEn",
  totalRows: "filasTotales",
  validRows: "filasValidas",
  createdCount: "creadas",
  updatedCount: "actualizadas",
  errorCount: "errores",
  message: "mensaje",
  createdBy: "creadoPor"
};

const JOB_FIELDS = Object.keys(S4_FIELD_NAMES);
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
function mapJobToS4(oJob) {
  const oOut = { ID: oJob.ID };

  JOB_FIELDS.forEach(function (sField) {
    oOut[S4_FIELD_NAMES[sField]] = mapJobFieldToS4(sField, oJob[sField]);
  });

  return oOut;
}

// Mapeo PARCIAL: para updateJob. NO rellena campos ausentes con defaults,
// asi un PATCH de solo {message} no pisa contadores/fechas ya guardados
// (leccion aprendida del store de embargo).
function buildJobPatchPayload(oPatch) {
  const oOut = {};

  JOB_FIELDS.forEach(function (sField) {
    if (!Object.prototype.hasOwnProperty.call(oPatch, sField)) {
      return;
    }

    oOut[S4_FIELD_NAMES[sField]] = mapJobFieldToS4(sField, oPatch[sField]);
  });

  return oOut;
}

function normalizeJobFromS4(o) {
  if (!o) {
    return null;
  }

  return {
    ID: o.ID,
    fileName: o.archivo || null,
    status: o.estado,
    startedAt: fromS4Date(o.iniciadoEn),
    finishedAt: fromS4Date(o.finalizadoEn),
    totalRows: o.filasTotales || 0,
    validRows: o.filasValidas || 0,
    createdCount: o.creadas || 0,
    updatedCount: o.actualizadas || 0,
    errorCount: o.errores || 0,
    message: o.mensaje || null,
    createdBy: o.creadoPor || null
  };
}

function mapLogToS4(oEntry) {
  return {
    ID: oEntry.ID,
    job_ID: oEntry.job_ID,
    numeroLinea: Number(oEntry.numeroLinea) || 0,
    cuit: truncStr(oEntry.cuit || "", LOG_FIELD_MAXLEN.cuit),
    cliente: truncStr(oEntry.cliente || "", LOG_FIELD_MAXLEN.cliente),
    razonSocial: truncStr(oEntry.razonSocial || "", LOG_FIELD_MAXLEN.razonSocial),
    accion: truncStr(oEntry.accion || "", LOG_FIELD_MAXLEN.accion),
    resultado: truncStr(oEntry.resultado || "", LOG_FIELD_MAXLEN.resultado),
    mensaje: truncStr(oEntry.mensaje || "", LOG_FIELD_MAXLEN.mensaje),
    timestamp: toS4Date(oEntry.timestamp)
  };
}

function keyPredicate(sId) {
  const sEscaped = String(sId || "").replace(/'/g, "''");

  if (ID_KEY_TYPE === "guid") {
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

function resolveId(sId) {
  return ID_ALIASES.get(sId) || sId;
}

async function createJob(oJob) {
  const data = await writeRequest("POST", jobsPath(), mapJobToS4(oJob), "al crear job en S/4");
  const created = data && data.d ? data.d : null;

  if (created && created.ID && String(created.ID).toLowerCase() !== String(oJob.ID).toLowerCase()) {
    ID_ALIASES.set(oJob.ID, created.ID);
    console.warn("S/4 asigno ID " + created.ID + " en lugar del enviado " + oJob.ID + ". Se usara el de S/4.");
  }

  return oJob.ID;
}

async function updateJob(sId, oPatch) {
  const oPayload = buildJobPatchPayload(oPatch);

  if (!Object.keys(oPayload).length) {
    return;
  }

  await writeRequest("PATCH", jobsPath() + keyPredicate(resolveId(sId)), oPayload, "al actualizar job " + sId + " en S/4");
}

async function getJobById(sId) {
  const response = await callDestination(DESTINATION_NAME, jobsPath() + keyPredicate(resolveId(sId)) + "?$format=json", {
    headers: { "Accept": "application/json" }
  });

  if (response.status === 404) {
    return null;
  }

  const data = await readJsonResponse(response, "al consultar job " + sId + " en S/4");
  return normalizeJobFromS4(data && data.d ? data.d : null);
}

async function listJobs(nTop) {
  const sPath = jobsPath() +
    "?$orderby=" + encodeURIComponent("iniciadoEn desc") +
    "&$top=" + (Number(nTop) || 20) +
    "&$format=json";

  const response = await callDestination(DESTINATION_NAME, sPath, {
    headers: { "Accept": "application/json" }
  });

  const data = await readJsonResponse(response, "al listar jobs en S/4");
  const results = data && data.d && data.d.results ? data.d.results : [];

  return results.map(normalizeJobFromS4);
}

async function getLogEntriesByJobId(sJobId) {
  const sId = String(resolveId(sJobId)).replace(/'/g, "''");
  const sFilter = ID_KEY_TYPE === "guid" ? "job_ID eq guid'" + sId + "'" : "job_ID eq '" + sId + "'";
  const sPath = logsPath() +
    "?$filter=" + encodeURIComponent(sFilter) +
    "&$orderby=" + encodeURIComponent("numeroLinea asc") +
    "&$format=json";

  const response = await callDestination(DESTINATION_NAME, sPath, {
    headers: { "Accept": "application/json" }
  });

  const data = await readJsonResponse(response, "al consultar logs del job " + sJobId);
  const results = data && data.d && data.d.results ? data.d.results : [];

  return results.map(function (o) {
    return {
      numeroLinea: o.numeroLinea || 0,
      cuit: o.cuit || "",
      cliente: o.cliente || "",
      razonSocial: o.razonSocial || "",
      accion: o.accion || "",
      resultado: o.resultado || "",
      mensaje: o.mensaje || "",
      timestamp: fromS4Date(o.timestamp)
    };
  });
}

async function createLogEntry(oEntry) {
  const oPayload = mapLogToS4(oEntry);

  if (ID_ALIASES.has(oEntry.job_ID)) {
    oPayload.job_ID = ID_ALIASES.get(oEntry.job_ID);
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
