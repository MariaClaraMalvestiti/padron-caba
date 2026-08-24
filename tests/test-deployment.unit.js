"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "api", "server.js"), "utf8");
const manifest = fs.readFileSync(path.join(root, "manifest-test.yml"), "utf8");
const xsApp = JSON.parse(
  fs.readFileSync(path.join(root, "test-approuter", "xs-app.json"), "utf8")
);
const xsSecurity = JSON.parse(
  fs.readFileSync(path.join(root, "xs-security-test.json"), "utf8")
);

assert.match(server, /S4_BUSINESS_PARTNER_DESTINATION/);
assert.match(server, /S4_PRICING_DESTINATION/);
assert.match(manifest, /space|TEST|telefe-test/i);
assert.match(manifest, /S4HANA-BP-I0A/);
assert.match(manifest, /S4_JOBLOG_SERVICE_PATH:\s*\/sap\/opu\/odata\/sap\/ZFI_PADRON_JOBLOG_SRV/);
assert.doesNotMatch(manifest, /ZFI_PADRON_CABA_SRV/);
assert.doesNotMatch(manifest, /S4HANA-BP(?:\s|$)/m);
assert.doesNotMatch(manifest, /S4HANA-PRICING(?:\s|$)/m);

const destinations = xsApp.routes
  .map(function (route) { return route.destination; })
  .filter(Boolean);
assert.deepStrictEqual(destinations, [
  "padrones-tax-upload-api-test",
  "S4HANA-BP-I0A",
  "S4HANA-BP-I0A"
]);
assert.ok(xsApp.routes.some(function (route) {
  return route.source === "^/s4/(.*)$" && route.destination === "S4HANA-BP-I0A";
}));
assert.ok(xsApp.routes.some(function (route) {
  return route.source === "^/pricing/(.*)$" && route.destination === "S4HANA-BP-I0A";
}));
assert.match(manifest, /padrones-tax-upload-destination-telefe-test/);
assert.ok(xsApp.routes.some(function (route) {
  return route.service === "html5-apps-repo-rt";
}));
assert.deepStrictEqual(xsSecurity["oauth2-configuration"]["redirect-uris"], [
  "https://padrones-tax-upload-approuter-telefe-test.cfapps.us10-001.hana.ondemand.com/**"
]);

console.log("CABA TEST deployment unit test: OK");
