"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let controllerDefinition;
const localStorageValues = new Map();

const sandbox = {
  console: console,
  AbortController: AbortController,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
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
  await testCompanyMembershipFilter();
  await testCompanyValidationFailure();
  await testRejectedJobIsExplained();
  assert.equal(fs.readFileSync(controllerPath, "utf8"),
    fs.readFileSync(controllerPath.replace("App.controller.js", "App-dbg.controller.js"), "utf8"));
  console.log("CABA UI state unit test: OK");
}

function setTestFile(model) {
  model.setProperty("/companyCode", "2384");
  model.setProperty("/fileContent", ["20000000001", "20000000002", "20000000003", "20000000004", "20000000005"]
    .map(function (cuit) {
      return "P;25062026;01072026;31072026;" + cuit + ";D;N;N;3,45;01;";
    }).join("\n"));
}

function bpResponse(resource) {
  if (resource.includes("A_BusinessPartnerTaxNumber")) {
    return resource.includes("$skiptoken=next")
      ? { d: { results: [
          { BusinessPartner: "BP3", BPTaxNumber: "20000000001" },
          { BusinessPartner: "BP5", BPTaxLongNumber: "20-00000000-5" }
        ] } }
      : { d: { results: [
          { BusinessPartner: "BP1", BPTaxNumber: "20000000001" },
          { BusinessPartner: "BP2", BPTaxNumber: "20-00000000-2" },
          { BusinessPartner: "BP4", BPTaxNumber: "20000000004" }
        ], __next: "https://example.invalid/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartnerTaxNumber?$skiptoken=next" } };
  }
  return resource.includes("$skiptoken=next")
    ? { d: { results: [{ BusinessPartner: "BP5", Customer: "0005" }] } }
    : { d: { results: [
        { BusinessPartner: "BP1", Customer: "0001" },
        { BusinessPartner: "BP2", Customer: "0002" },
        { BusinessPartner: "BP3", Customer: "0003" },
        { BusinessPartner: "BP4", Customer: "" }
      ], __next: "https://example.invalid/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$skiptoken=next" } };
}

async function testCompanyMembershipFilter() {
  const model = createModel();
  const controller = createController(model);
  setTestFile(model);
  let members = ["0001", "0005"];
  let companyReads = 0;
  let bpReads = 0;
  sandbox.fetch = async function (resource, options) {
    assert.equal(options.method, "GET", "Preparar el filtro no debe escribir en S/4");
    let data;
    if (resource.startsWith("/api/customer-company-index")) {
      assert.equal(resource, "/api/customer-company-index?companyCode=2384");
      assert.equal(options.cache, "no-store");
      companyReads += 1;
      data = { companyCode: "2384", customers: members };
    } else {
      assert.ok(resource.startsWith("/s4/sap/opu/odata/sap/API_BUSINESS_PARTNER/"));
      bpReads += 1;
      data = bpResponse(resource);
    }
    return { ok: true, json: async function () { return data; } };
  };
  await controller._parseContent();
  assert.equal(model.getProperty("/totalRows"), 5);
  assert.equal(model.getProperty("/validRows"), 2);
  assert.equal(model.getProperty("/errorRows"), 0);
  const rows = model.getProperty("/rows");
  assert.deepEqual(Array.from(rows, function (row) { return row.customer; }), ["0001", "0005"]);
  assert.equal(rows[0].businessPartner, "BP1", "Un BP de otra sociedad no debe ocultar el CUIT habilitado");
  assert.equal(rows[0].rate, "3,45");
  assert.equal(rows[0].validFrom, "01.07.2026");
  assert.equal(rows[0].validTo, "31.07.2026");
  const messages = model.getProperty("/messages").map(function (message) { return message.text; }).join("\n");
  assert.match(messages, /1 registros: el cliente existe, pero no esta extendido a la sociedad 2384/);
  assert.match(messages, /2 registros porque no se encontro un cliente/);
  assert.equal(bpReads, 4, "Debe consultar todas las paginas de BP y CUIT");
  assert.equal(model.getProperty("/busy"), false);

  members = ["0002"];
  await controller._parseContent();
  assert.equal(companyReads, 2, "No debe reutilizar el indice anterior");
  assert.deepEqual(Array.from(model.getProperty("/rows"), function (row) { return row.customer; }), ["0002"]);

  members = [];
  await controller._parseContent();
  assert.equal(model.getProperty("/validRows"), 0);
  assert.equal(model.getProperty("/rows").length, 0);
}

async function testCompanyValidationFailure() {
  const model = createModel();
  const controller = createController(model);
  setTestFile(model);
  model.setProperty("/validRows", 99);
  model.setProperty("/rows", [{ customer: "old" }]);
  sandbox.fetch = async function (resource) {
    assert.ok(resource.startsWith("/api/customer-company-index"));
    return { ok: false, json: async function () {
      return { message: "Revisar acceso a A_CustomerCompany. No se inicio el procesamiento." };
    } };
  };
  await controller._parseContent();
  assert.equal(model.getProperty("/validRows"), 0);
  assert.equal(model.getProperty("/rows").length, 0);
  assert.equal(model.getProperty("/busy"), false);
  assert.match(model.getProperty("/messages")[0].text, /A_CustomerCompany/);

  sandbox.fetch = async function () {
    return { ok: true, json: async function () {
      return { companyCode: "2385", customers: ["0001"] };
    } };
  };
  await assert.rejects(controller._loadCompanyCustomerIndex("2384"), /incompleto/);

  controller._loadCompanyCustomerIndex = async function () { return new Set(["0001"]); };
  controller._loadBusinessPartnerIndex = async function () {
    model.setProperty("/companyCode", "2385");
    return new Map([["20000000001", { customer: "0001", businessPartner: "BP1" }]]);
  };
  await controller._parseContent();
  assert.equal(model.getProperty("/rows").length, 0);
  assert.match(model.getProperty("/messages")[0].text, /sociedad cambio/);
}

async function testRejectedJobIsExplained() {
  const model = createModel();
  const controller = createController(model);
  controller._stopJobPolling = function () {};
  controller._startJobPolling = function () { assert.fail("No debe recuperar un job rechazado"); };
  localStorageValues.clear();
  sandbox.fetch = async function () {
    return { ok: false, status: 422, json: async function () {
      return { message: "El cliente no esta extendido a la sociedad 2384." };
    } };
  };
  await controller._startBackgroundJob("test.txt", 1, [{ customer: "0001" }], "2384");
  assert.equal(model.getProperty("/busy"), false);
  assert.equal(localStorageValues.size, 0);
  assert.match(model.getProperty("/messages")[0].text, /no esta extendido a la sociedad 2384/);
}

run().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
