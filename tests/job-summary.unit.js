"use strict";

const assert = require("node:assert/strict");
const {
  SUMMARY_ACTION,
  normalizeCuitForS4,
  toPersistedStatus,
  fromPersistedStatus,
  encodeJobSummary,
  decodeJobSummary,
  isSummaryEntry,
  applyJobSummary
} = require("../api/lib/job-summary");

assert.equal(normalizeCuitForS4("20-00041649-6"), "20000416496");
assert.equal(normalizeCuitForS4("20.000.43481-8"), "20000434818");
assert.equal(toPersistedStatus("FINALIZADO_CON_ERRORES"), "FIN_ERROR");
assert.equal(fromPersistedStatus("FIN_ERROR"), "FINALIZADO_CON_ERRORES");

const encoded = encodeJobSummary({
  totalRows: 4,
  validRows: 2,
  createdCount: 2,
  updatedCount: 0,
  errorCount: 0,
  status: "FINALIZADO",
  startedAt: "2026-08-25T14:48:42.000Z",
  finishedAt: "2026-08-25T14:48:47.000Z",
  message: "Proceso finalizado. Creadas: 2. Actualizadas: 0. Errores: 0."
});

const decoded = decodeJobSummary(encoded);
assert.equal(decoded.totalRows, 4);
assert.equal(decoded.validRows, 2);
assert.equal(decoded.createdCount, 2);
assert.equal(decoded.status, "FINALIZADO");

const entry = {
  accion: SUMMARY_ACTION,
  mensaje: encoded,
  timestamp: "2026-08-25T14:48:47.000Z"
};

assert.equal(isSummaryEntry(entry), true);
assert.equal(isSummaryEntry({ accion: "COND_CREADA", mensaje: "OK" }), false);

const enriched = applyJobSummary({
  ID: "JOB-1",
  status: "FINALIZADO",
  totalRows: 0,
  validRows: 0,
  createdCount: 0,
  updatedCount: 0,
  errorCount: 0,
  message: null
}, entry);

assert.equal(enriched.totalRows, 4);
assert.equal(enriched.validRows, 2);
assert.equal(enriched.createdCount, 2);
assert.match(enriched.message, /Creadas: 2/);

console.log("job-summary.unit.js: OK");
