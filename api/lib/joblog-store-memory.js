"use strict";

/*
 * Store in-memory de jobs y logs, misma interfaz que s4-joblog-store.js.
 * Solo para desarrollo/pruebas sin el servicio Z de S/4: los datos viven
 * mientras corre la instancia y se pierden al reiniciar.
 */

var oJobs = new Map();
var oLogsByJob = new Map();

function clone(o) {
  return o ? JSON.parse(JSON.stringify(o)) : o;
}

async function createJob(oJob) {
  oJobs.set(oJob.ID, clone(oJob));
  oLogsByJob.set(oJob.ID, []);
  return oJob.ID;
}

async function updateJob(sId, oPatch) {
  var oJob = oJobs.get(sId);

  if (!oJob) {
    throw new Error("Job no encontrado en store memory: " + sId);
  }

  Object.assign(oJob, clone(oPatch));
}

async function getJobById(sId) {
  return clone(oJobs.get(sId)) || null;
}

async function createLogEntry(oEntry) {
  var aLogs = oLogsByJob.get(oEntry.job_ID);

  if (!aLogs) {
    aLogs = [];
    oLogsByJob.set(oEntry.job_ID, aLogs);
  }

  aLogs.push(clone(oEntry));
}

async function getLogEntriesByJobId(sJobId) {
  return clone(oLogsByJob.get(sJobId)) || [];
}

async function listJobs(nTop) {
  return Array.from(oJobs.values())
    .sort(function (a, b) {
      return String(b.startedAt || "").localeCompare(String(a.startedAt || ""));
    })
    .slice(0, Number(nTop) || 20)
    .map(clone);
}

async function ping() {
  return { store: "memory", jobs: oJobs.size };
}

module.exports = {
  mode: "memory",
  createJob: createJob,
  updateJob: updateJob,
  getJobById: getJobById,
  listJobs: listJobs,
  createLogEntry: createLogEntry,
  getLogEntriesByJobId: getLogEntriesByJobId,
  ping: ping
};
