"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { readJsonResponse } = require("../api/lib/destination");
const companyModule = require("../api/lib/customer-company");
const { loadCompanyCustomers, assertCustomersInCompany } = companyModule;
const ENTITY = "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_CustomerCompany";
const DESTINATION = "S4-BP-UNIT-TEST";

function page(customers, next) {
  const d = { results: customers.map(function (customer) {
    return { Customer: customer, CompanyCode: "2384" };
  }) };
  if (next !== undefined) d.__next = next;
  return { d: d };
}

function mockClient(pages) {
  const calls = [];
  return {
    calls: calls,
    readJsonResponse: readJsonResponse,
    callDestination: async function (destination, resourcePath, options) {
      assert.equal(destination, DESTINATION);
      assert.equal(options.method, "GET", "La validacion debe ser solo lectura");
      assert.ok(resourcePath.startsWith(ENTITY + "?"));
      calls.push(resourcePath);
      const result = pages[calls.length - 1];
      assert.notEqual(result, undefined, "Consulta S/4 no prevista");
      if (result instanceof Error) throw result;
      return result instanceof Response ? result : new Response(JSON.stringify(result));
    }
  };
}

async function testPaginatedRead() {
  const client = mockClient([
    page(["0000000001"], "https://example.invalid" + ENTITY + "?$skiptoken=page2"),
    page(["0000000002", "0000000001"])
  ]);
  const result = await loadCompanyCustomers(DESTINATION, "2384", client);
  assert.deepEqual(Array.from(result), ["0000000001", "0000000002"]);
  assert.match(decodeURIComponent(client.calls[0]), /CompanyCode eq '2384'/);
  assert.equal(client.calls[1], ENTITY + "?$skiptoken=page2");
  assert.equal((await loadCompanyCustomers(DESTINATION, "2384", mockClient([page([])]))).size, 0);

  const relative = mockClient([page(["0001"], "?$skiptoken=next"), page(["0002"])]);
  assert.equal((await loadCompanyCustomers(DESTINATION, "2384", relative)).size, 2);
}

async function testFailClosed() {
  const invalid = mockClient([]);
  await assert.rejects(loadCompanyCustomers(DESTINATION, "2384' or true", invalid),
    function (error) { return error.statusCode === 400; });
  assert.equal(invalid.calls.length, 0);

  const failures = [
    [new Response("private upstream details", { status: 403 })],
    [new Error("Timeout de S/4")],
    [new Response("<html>login</html>")],
    [{}],
    [{ d: { results: [{ Customer: "0001", CompanyCode: "2385" }] } }],
    [{ d: { results: [{ Customer: "", CompanyCode: "2384" }] } }],
    [page(["0001"], "/unrelated/resource")],
    [page(["0001"], "?$skiptoken=x"), page(["0002"], "?$skiptoken=x")],
    [page(["0001"], "?$skiptoken=next"), new Response("forbidden", { status: 403 })]
  ];
  for (const responses of failures) {
    await assert.rejects(loadCompanyCustomers(DESTINATION, "2384", mockClient(responses)),
      function (error) {
        assert.equal(error.statusCode, 503);
        assert.match(error.message, /A_CustomerCompany/);
        assert.doesNotMatch(error.message, /private upstream details|<html>|forbidden/);
        return true;
      });
  }
  assert.doesNotThrow(function () {
    assertCustomersInCompany([{ customer: "0001" }], new Set(["0001"]), "2384");
  });
  for (const row of [{ customer: "1" }, { customer: "other" }, { customer: 1 }, {}, null]) {
    assert.throws(function () {
      assertCustomersInCompany([row], new Set(["0001"]), "2384");
    }, function (error) { return error.statusCode === 422; });
  }
}

// Ejecuta los handlers reales sin iniciar servidor, timers, jobs ni conexion de red.
function serverHarness(client) {
  const routes = new Map();
  const created = [];
  const scheduled = [];
  const app = {
    use: function () {},
    get: function (route, handler) { routes.set("GET " + route, handler); },
    post: function (route, handler) { routes.set("POST " + route, handler); },
    listen: function () {}
  };
  const express = function () { return app; };
  express.json = function () {};
  const sandbox = {
    console: { log: function () {}, error: function () {} },
    process: { env: { S4_BUSINESS_PARTNER_DESTINATION: DESTINATION } },
    setImmediate: function (callback) { scheduled.push(callback); },
    require: function (name) {
      if (name === "express") return express;
      if (name === "node:crypto") return require(name);
      if (name === "./lib/destination") return client;
      if (name === "./lib/joblog-store") {
        return { createJob: async function (job) { created.push(job); } };
      }
      if (name === "./lib/customer-company") {
        return Object.assign({}, companyModule, {
          loadCompanyCustomers: function (destination, companyCode) {
            return loadCompanyCustomers(destination, companyCode, client);
          }
        });
      }
      throw new Error("Dependencia inesperada: " + name);
    }
  };
  const serverPath = path.join(__dirname, "..", "api", "server.js");
  vm.runInNewContext(fs.readFileSync(serverPath, "utf8"), sandbox, { filename: serverPath });
  return {
    created: created, scheduled: scheduled,
    request: async function (method, route, request) {
      const response = {
        statusCode: 200, headers: {},
        status: function (code) { this.statusCode = code; return this; },
        set: function (name, value) { this.headers[name] = value; return this; },
        json: function (data) { this.body = data; return this; }
      };
      await routes.get(method + " " + route)(request, response);
      return response;
    }
  };
}

function jobRequest(customers, companyCode = "2384") {
  return { body: {
    fileName: "test.txt", totalRows: customers.length,
    companyCode: companyCode,
    rows: customers.map(function (customer) {
      return { customer: customer, cuit: "20000000001", companyCode: "2385" };
    })
  } };
}

async function testRoutesBeforeAnyWrites() {
  const allowed = serverHarness(mockClient([page(["0001"])]));
  const success = await allowed.request("POST", "/api/jobs", jobRequest(["0001"]));
  assert.equal(success.statusCode, 202);
  assert.equal(allowed.created.length, 1);
  assert.equal(allowed.created[0].validRows, 1);
  assert.equal(allowed.scheduled.length, 1);

  const rejected = serverHarness(mockClient([page(["0001"])]));
  const failure = await rejected.request("POST", "/api/jobs", jobRequest(["0001", "0002"]));
  assert.equal(failure.statusCode, 422);
  assert.equal(failure.body.code, "CUSTOMER_NOT_IN_COMPANY");
  assert.equal(rejected.created.length, 0, "No debe persistir siquiera el job");
  assert.equal(rejected.scheduled.length, 0, "No debe iniciar escrituras parciales");

  const unavailable = serverHarness(mockClient([new Response("forbidden", { status: 403 })]));
  assert.equal((await unavailable.request("POST", "/api/jobs", jobRequest(["0001"]))).statusCode, 503);
  assert.equal(unavailable.created.length, 0);
  assert.equal(unavailable.scheduled.length, 0);

  const empty = serverHarness(mockClient([page([])]));
  assert.equal((await empty.request("POST", "/api/jobs", jobRequest(["0001"]))).statusCode, 422);
  assert.equal(empty.created.length, 0);

  const invalidClient = mockClient([]);
  const invalid = serverHarness(invalidClient);
  assert.equal((await invalid.request("POST", "/api/jobs", jobRequest(["0001"], ""))).statusCode, 400);
  assert.equal(invalidClient.calls.length, 0);
  assert.equal(invalid.created.length, 0);

  // La asignacion puede cambiar desde que la UI preparo el archivo: consultar de nuevo.
  const refreshedClient = mockClient([page(["0001", "0002"]), page(["0001"])]);
  const refreshed = serverHarness(refreshedClient);
  const index = await refreshed.request("GET", "/api/customer-company-index", { query: { companyCode: "2384" } });
  assert.equal(index.statusCode, 200);
  assert.equal(index.headers["Cache-Control"], "no-store");
  assert.equal(index.body.customers.length, 2);
  assert.equal((await refreshed.request("POST", "/api/jobs", jobRequest(["0001", "0002"]))).statusCode, 422);
  assert.equal(refreshedClient.calls.length, 2);
  assert.equal(refreshed.created.length, 0);
  assert.equal(refreshed.scheduled.length, 0);
}

async function run() {
  await testPaginatedRead();
  await testFailClosed();
  await testRoutesBeforeAnyWrites();
  console.log("CABA customer-company unit test: OK (lectura, paginacion y rechazo sin escrituras)");
}

run().catch(function (error) { console.error(error); process.exitCode = 1; });
