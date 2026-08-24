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

assert.match(server, /S4_BUSINESS_PARTNER_DESTINATION/);
assert.match(server, /S4_PRICING_DESTINATION/);
assert.match(manifest, /space|TEST|telefe-test/i);
assert.match(manifest, /S4HANA-BP-I0A/);
assert.doesNotMatch(manifest, /S4HANA-BP(?:\s|$)/m);
assert.doesNotMatch(manifest, /S4HANA-PRICING(?:\s|$)/m);

const destinations = xsApp.routes
  .map(function (route) { return route.destination; })
  .filter(Boolean);
assert.deepStrictEqual(destinations, ["padrones-tax-upload-api-test"]);
assert.ok(xsApp.routes.some(function (route) {
  return route.service === "html5-apps-repo-rt";
}));

console.log("CABA TEST deployment unit test: OK");
