"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let controllerDefinition;
const localStorageValues = new Map();

const sandbox = {
  console: console,
  setInterval: setInterval,
  clearInterval: clearInterval,
  window: {
    localStorage: {
      getItem: function (key) {
        return localStorageValues.get(key) || null;
      },
      setItem: function (key, value) {
        localStorageValues.set(key, String(value));
      },
      removeItem: function (key) {
        localStorageValues.delete(key);
      }
    }
  },
  sap: {
    ui: {
      define: function (_dependencies, factory) {
        const Controller = {
          extend: function (_name, definition) {
            controllerDefinition = definition;
            return definition;
          }
        };
        const JSONModel = function () {};
        const MessageToast = { show: function () {} };
        const MessageBox = {
          Action: { OK: "OK" },
          error: function () {},
          warning: function () {},
          success: function () {},
          confirm: function () {}
        };

        factory(Controller, JSONModel, MessageToast, MessageBox);
      }
    }
  }
};

const controllerPath = path.join(
  __dirname,
  "..",
  "webapp",
  "controller",
  "App.controller.js"
);

vm.runInNewContext(fs.readFileSync(controllerPath, "utf8"), sandbox, {
  filename: controllerPath
});

function createModel() {
  const values = new Map();

  return {
    setProperty: function (propertyPath, value) {
      values.set(propertyPath, value);
    },
    getProperty: function (propertyPath) {
      return values.get(propertyPath);
    }
  };
}

function createController(model) {
  return Object.assign({}, controllerDefinition, {
    getView: function () {
      return {
        getModel: function () {
          return model;
        }
      };
    }
  });
}

async function testCompanyCodeVisualFilter() {
  const model = createModel();
  const controller = createController(model);

  sandbox.fetch = async function () {
    return {
      ok: true,
      json: async function () {
        return {
          companyCodes: [
            { companyCode: "2384", companyCodeName: "TELEVISION FEDERAL" },
            { companyCode: "2385", companyCodeName: "OTRA SOCIEDAD" }
          ]
        };
      }
    };
  };

  await controller._loadCompanyCodes();

  assert.deepEqual(
    Array.from(model.getProperty("/companyCodes"), function (item) {
      return item.companyCode;
    }),
    ["2384"]
  );
  assert.equal(model.getProperty("/companyCode"), "2384");
}

function testPersistentJobProgress() {
  const model = createModel();
  const controller = createController(model);

  const running = {
    status: "EN_PROCESO",
    message: "Procesando 3/12 customer 0001 CUIT 30700000001."
  };

  assert.equal(controller._calculateJobProgress(running), 25);
  assert.equal(controller._buildProgressText(running.status, 25), "Cargando... 25%");
  assert.equal(controller._formatJobStatus(running.status), "En proceso");
  assert.equal(controller._jobValueState(running.status), "Information");

  const finished = {
    status: "FINALIZADO",
    message: "Proceso finalizado."
  };

  assert.equal(controller._calculateJobProgress(finished), 100);
  assert.equal(controller._buildProgressText(finished.status, 100), "Finalizado");
  assert.equal(controller._jobValueState(finished.status), "Success");
}

async function testRecoveredJobUpdatesPanel() {
  const model = createModel();
  const controller = createController(model);

  model.setProperty("/totalRows", 0);
  model.setProperty("/validRows", 0);
  controller._stopJobPolling = function () {};

  sandbox.fetch = async function () {
    return {
      ok: true,
      json: async function () {
        return {
          id: "JOB-CABA-2384",
          status: "EN_PROCESO",
          TotalRows: 12,
          validRows: 12,
          errorCount: 0,
          message: "Procesado 6/12 customer 0001 CUIT 30700000001."
        };
      }
    };
  };

  await controller._pollJobStatus("JOB-CABA-2384");

  assert.equal(model.getProperty("/jobId"), "JOB-CABA-2384");
  assert.equal(model.getProperty("/jobProgress"), 50);
  assert.equal(model.getProperty("/jobProgressText"), "Cargando... 50%");
  assert.equal(model.getProperty("/jobMessage"), "Procesado 6/12 customer 0001 CUIT 30700000001.");
  assert.equal(model.getProperty("/totalRows"), 12);
}

async function run() {
  await testCompanyCodeVisualFilter();
  testPersistentJobProgress();
  await testRecoveredJobUpdatesPanel();
  console.log("CABA UI state unit test: OK");
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});

