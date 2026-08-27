"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function harness() {
  const timers = new Map();
  const values = new Map();
  const requests = [];
  const dialogs = [];
  let nextTimer = 1;
  let definition;
  let reply = async function () { return job("EN_PROCESO"); };
  const model = {
    setProperty: function (key, value) { values.set(key, value); },
    getProperty: function (key) { return values.get(key); }
  };
  function timer(callback, ms, repeating) {
    const id = nextTimer++;
    timers.set(id, { callback: callback, ms: ms, repeating: repeating });
    return id;
  }
  const sandbox = {
    AbortController: AbortController,
    setInterval: function (callback, ms) { return timer(callback, ms, true); },
    clearInterval: function (id) { timers.delete(id); },
    setTimeout: function (callback, ms) { return timer(callback, ms, false); },
    clearTimeout: function (id) { timers.delete(id); },
    window: { localStorage: { getItem: function () { return "RECOVERED"; } } },
    fetch: async function (url, options) {
      assert.equal(options.method, "GET", "El seguimiento nunca debe crear ni repetir un job");
      assert.match(url, /^\/api\/jobs\//);
      requests.push({ url: url, options: options });
      return reply(options);
    },
    sap: { ui: { define: function (_dependencies, factory) {
      factory({ extend: function (_name, object) { definition = object; } },
        function () { return model; }, { show: function () {} }, {
          success: function (message) { dialogs.push(message); },
          warning: function (message) { dialogs.push(message); },
          error: function (message) { dialogs.push(message); }
        });
    } } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "webapp", "controller", "App.controller.js"), "utf8"), sandbox);
  const controller = Object.assign({}, definition, {
    _loadCompanyCodes: function () {},
    getView: function () { return { getModel: function () { return model; }, setModel: function () {} }; }
  });
  return {
    controller: controller, model: model, timers: timers, requests: requests, dialogs: dialogs,
    reply: function (fn) { reply = fn; },
    countPolls: function () { return Array.from(timers.values()).filter(function (t) { return t.repeating; }).length; },
    tick: function (ms) {
      Array.from(timers.entries()).forEach(function (entry) {
        const [id, t] = entry;
        if (t.ms !== ms || !timers.has(id)) { return; }
        if (!t.repeating) { timers.delete(id); }
        t.callback();
      });
    }
  };
}

function job(status, id) {
  return { ok: true, json: async function () {
    return {
      id: id || "RECOVERED", status: status, TotalRows: 3, validRows: 3, errorCount: 0,
      updatedCount: status === "FINALIZADO" ? 3 : 0,
      message: status === "EN_PROCESO" ? "Procesando 1/3 customer TEST." : "Proceso finalizado. Actualizadas: 3."
    };
  } };
}

async function settle() {
  for (let i = 0; i < 12; i += 1) { await Promise.resolve(); }
}

async function testReopenResumesUntilFinished() {
  const h = harness();
  h.controller.onInit();
  await settle();
  assert.equal(h.model.getProperty("/jobProgress"), 33);
  assert.equal(h.countPolls(), 1, "Al reabrir, debe reactivar el seguimiento periodico");
  assert.equal(h.model.getProperty("/busy"), true, "No debe habilitar otro procesamiento mientras el job sigue activo");
  assert.equal(h.requests[0].options.cache, "no-store");
  h.reply(async function () { return job("FINALIZADO"); });
  h.tick(5000);
  await settle();
  assert.equal(h.model.getProperty("/jobStatus"), "FINALIZADO");
  assert.equal(h.model.getProperty("/jobProgress"), 100);
  assert.equal(h.model.getProperty("/busy"), false);
  assert.equal(h.model.getProperty("/validRows"), 3);
  assert.equal(h.countPolls(), 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.dialogs.length, 1);
  h.tick(5000);
  assert.equal(h.requests.length, 2);
}

async function testAlreadyFinishedAndErrorStatusesStop() {
  for (const status of ["FINALIZADO", "FINALIZADO_CON_ERRORES", "ERROR"]) {
    const h = harness();
    h.reply(async function () { return job(status); });
    h.controller.onInit();
    await settle();
    assert.equal(h.model.getProperty("/jobStatus"), status);
    assert.equal(h.model.getProperty("/busy"), false);
    assert.equal(h.timers.size, 0);
    assert.equal(h.dialogs.length, 1);
  }
}

async function testSingleTimerAndNoConcurrentRequests() {
  const h = harness();
  h.controller._startJobPolling("RECOVERED");
  await settle();
  h.controller._startJobPolling("RECOVERED");
  await settle();
  assert.equal(h.countPolls(), 1, "Reactivar no debe duplicar los timers");
  let resolve;
  h.reply(function () { return new Promise(function (done) { resolve = done; }); });
  h.tick(5000);
  const requestCount = h.requests.length;
  h.tick(5000);
  assert.equal(h.requests.length, requestCount, "No debe superponer consultas lentas");
  resolve(job("EN_PROCESO"));
  await settle();
  h.controller.onExit();
  assert.equal(h.timers.size, 0);
}

async function testTemporaryFailureRetriesWithoutClaimingJobFailure() {
  const h = harness();
  h.reply(async function () { throw new Error("Sin conexion"); });
  h.controller.onInit();
  await settle();
  assert.equal(h.countPolls(), 1);
  assert.equal(h.model.getProperty("/busy"), true);
  assert.match(h.model.getProperty("/jobMessage"), /reintentara/i);
  assert.notEqual(h.model.getProperty("/jobStatus"), "ERROR");
  assert.equal(h.dialogs.length, 0);
  h.reply(async function () { return job("FINALIZADO"); });
  h.tick(5000);
  await settle();
  assert.equal(h.model.getProperty("/jobProgress"), 100);
  assert.equal(h.timers.size, 0);
}

async function testTimedOutReadCanRetry() {
  const h = harness();
  h.reply(function (options) {
    return new Promise(function (_resolve, reject) {
      options.signal.addEventListener("abort", function () { reject(new Error("Tiempo de espera agotado")); }, { once: true });
    });
  });
  h.controller.onInit();
  h.tick(30000);
  await settle();
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.countPolls(), 1);
  assert.match(h.model.getProperty("/jobMessage"), /reintentara/i);
  h.reply(async function () { return job("FINALIZADO"); });
  h.tick(5000);
  await settle();
  assert.equal(h.model.getProperty("/jobStatus"), "FINALIZADO");
  assert.equal(h.timers.size, 0);
}

async function testLateResponseCannotOverwriteNewJob() {
  const h = harness();
  let resolveOld;
  h.reply(function () { return new Promise(function (resolve) { resolveOld = resolve; }); });
  h.controller._startJobPolling("OLD");
  h.reply(async function () { return job("FINALIZADO", "NEW"); });
  h.controller._startJobPolling("NEW");
  await settle();
  resolveOld(job("EN_PROCESO", "OLD"));
  await settle();
  assert.equal(h.model.getProperty("/jobId"), "NEW");
  assert.equal(h.model.getProperty("/jobStatus"), "FINALIZADO");
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.timers.size, 0);
}

async function testExitIgnoresPendingResponse() {
  const h = harness();
  let resolve;
  h.reply(function () { return new Promise(function (done) { resolve = done; }); });
  h.controller.onInit();
  h.controller.onExit();
  resolve(job("FINALIZADO"));
  await settle();
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.notEqual(h.model.getProperty("/jobStatus"), "FINALIZADO");
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.timers.size, 0);
}

async function testPermanentReadFailureStopsAndExplains() {
  for (const status of [401, 403, 404]) {
    const h = harness();
    h.reply(async function () { return { ok: false, status: status }; });
    h.controller.onInit();
    await settle();
    assert.equal(h.timers.size, 0);
    assert.equal(h.model.getProperty("/jobStatusText"), "Error de consulta");
    assert.notEqual(h.model.getProperty("/jobStatus"), "ERROR");
    assert.equal(h.model.getProperty("/busy"), false);
    assert.equal(h.dialogs.length, 0);
  }
}

(async function () {
  await testReopenResumesUntilFinished();
  await testAlreadyFinishedAndErrorStatusesStop();
  await testSingleTimerAndNoConcurrentRequests();
  await testTemporaryFailureRetriesWithoutClaimingJobFailure();
  await testTimedOutReadCanRetry();
  await testLateResponseCannotOverwriteNewJob();
  await testExitIgnoresPendingResponse();
  await testPermanentReadFailureStopsAndExplains();
  console.log("CABA job polling regression: 8 cases OK (GET only)");
})().catch(function (error) { console.error(error); process.exitCode = 1; });
