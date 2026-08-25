"use strict";

const SUMMARY_ACTION = "RESUMEN";
const SUMMARY_PREFIX = "JOB_SUMMARY:";

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeCuitForS4(v) {
  return String(v || "").replace(/\D/g, "").slice(0, 11);
}

function normalizeLogActionForS4(v) {
  const sAction = String(v || "");
  const oAliases = {
    COND_CREADA: "CREADA",
    COND_ACTUALIZADA: "ACTUALIZA",
    SIN_CAMBIOS: "SIN_CAMBIO",
    RESUMEN_JOB: SUMMARY_ACTION
  };

  return (oAliases[sAction] || sAction).slice(0, 10);
}

function toPersistedStatus(sStatus) {
  return sStatus === "FINALIZADO_CON_ERRORES" ? "FIN_ERROR" : sStatus;
}

function fromPersistedStatus(sStatus) {
  return sStatus === "FIN_ERROR" ? "FINALIZADO_CON_ERRORES" : sStatus;
}

function encodeJobSummary(oPatch) {
  const oSummary = {
    t: toNumber(oPatch.totalRows),
    v: toNumber(oPatch.validRows),
    c: toNumber(oPatch.createdCount),
    u: toNumber(oPatch.updatedCount),
    e: toNumber(oPatch.errorCount),
    s: String(oPatch.status || ""),
    a: oPatch.startedAt || null,
    f: oPatch.finishedAt || null,
    m: String(oPatch.message || "").slice(0, 250)
  };

  return SUMMARY_PREFIX + JSON.stringify(oSummary);
}

function decodeJobSummary(sMessage) {
  const sValue = String(sMessage || "");

  if (sValue.indexOf(SUMMARY_PREFIX) !== 0) {
    return null;
  }

  try {
    const oSummary = JSON.parse(sValue.slice(SUMMARY_PREFIX.length));
    return {
      totalRows: toNumber(oSummary.t),
      validRows: toNumber(oSummary.v),
      createdCount: toNumber(oSummary.c),
      updatedCount: toNumber(oSummary.u),
      errorCount: toNumber(oSummary.e),
      status: String(oSummary.s || ""),
      startedAt: oSummary.a || null,
      finishedAt: oSummary.f || null,
      message: String(oSummary.m || "")
    };
  } catch (_error) {
    return null;
  }
}

function isSummaryEntry(oEntry) {
  return Boolean(
    oEntry && (
      oEntry.accion === SUMMARY_ACTION ||
      String(oEntry.mensaje || "").indexOf(SUMMARY_PREFIX) === 0
    )
  );
}

function applyJobSummary(oJob, oEntry) {
  const oSummary = oEntry && decodeJobSummary(oEntry.mensaje);

  if (!oSummary) {
    return oJob;
  }

  return Object.assign({}, oJob, {
    status: oSummary.status || oJob.status,
    startedAt: oSummary.startedAt || oJob.startedAt,
    finishedAt: oSummary.finishedAt || oJob.finishedAt,
    totalRows: oSummary.totalRows,
    validRows: oSummary.validRows,
    createdCount: oSummary.createdCount,
    updatedCount: oSummary.updatedCount,
    errorCount: oSummary.errorCount,
    message: oSummary.message || oJob.message
  });
}

module.exports = {
  SUMMARY_ACTION: SUMMARY_ACTION,
  normalizeCuitForS4: normalizeCuitForS4,
  normalizeLogActionForS4: normalizeLogActionForS4,
  toPersistedStatus: toPersistedStatus,
  fromPersistedStatus: fromPersistedStatus,
  encodeJobSummary: encodeJobSummary,
  decodeJobSummary: decodeJobSummary,
  isSummaryEntry: isSummaryEntry,
  applyJobSummary: applyJobSummary
};
