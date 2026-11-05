// Unit tests for server/integrations/nexs/nexsBlockedInventory.js (buildPayload/
// validateResult) and its registration in server/integrations/capabilities/registry.js.
// No network, no Quadron/Grafana/Concinity/Runtime call anywhere in this
// file.

const test = require("node:test");
const assert = require("node:assert/strict");
const nexsBlockedInventory = require("../../../integrations/nexs/nexsBlockedInventory");
const registry = require("../../../integrations/capabilities/registry");

test("buildPayload returns { nexsOrigin, pid, facilityCode } with the given params", () => {
  const payload = nexsBlockedInventory.buildPayload("https://app.nexs.lenskart.com", { pid: "82650064", facilityCode: "NXS2" });
  assert.deepEqual(payload, { nexsOrigin: "https://app.nexs.lenskart.com", pid: "82650064", facilityCode: "NXS2" });
});

test("buildPayload defaults facilityCode to NXS1 when omitted, matching the legacy extension's own default", () => {
  const payload = nexsBlockedInventory.buildPayload("https://app.nexs.lenskart.com", { pid: "82650064" });
  assert.equal(payload.facilityCode, "NXS1");
});

test("buildPayload never includes a secret/cookie field", () => {
  const payload = nexsBlockedInventory.buildPayload("https://app.nexs.lenskart.com", { pid: "1" });
  assert.deepEqual(Object.keys(payload).sort(), ["facilityCode", "nexsOrigin", "pid"]);
});

test("validateResult accepts a well-formed result envelope", () => {
  const result = nexsBlockedInventory.validateResult({ pid: "82650064", data: { totalInventory: 500, blockedInventory: 120, availableInventory: 380 } });
  assert.deepEqual(result, { ok: true });
});

test("validateResult accepts an empty data object (a genuinely empty NexS response is not malformed)", () => {
  assert.deepEqual(nexsBlockedInventory.validateResult({ pid: "1", data: {} }), { ok: true });
});

test("validateResult rejects a missing/non-string pid", () => {
  assert.equal(nexsBlockedInventory.validateResult({ data: {} }).ok, false);
  assert.equal(nexsBlockedInventory.validateResult({ pid: "", data: {} }).ok, false);
  assert.equal(nexsBlockedInventory.validateResult({ pid: 123, data: {} }).ok, false);
});

test("validateResult rejects a missing/non-object data field", () => {
  assert.equal(nexsBlockedInventory.validateResult({ pid: "1" }).ok, false);
  assert.equal(nexsBlockedInventory.validateResult({ pid: "1", data: null }).ok, false);
  assert.equal(nexsBlockedInventory.validateResult({ pid: "1", data: "not-an-object" }).ok, false);
  assert.equal(nexsBlockedInventory.validateResult({ pid: "1", data: [] }).ok, false);
});

test("validateResult rejects a null/non-object result entirely", () => {
  assert.equal(nexsBlockedInventory.validateResult(null).ok, false);
  assert.equal(nexsBlockedInventory.validateResult(undefined).ok, false);
});

test("GET_NEXS_BLOCKED_INVENTORY is registered in the capability registry, read-only, no write", () => {
  const capability = registry.getCapability("GET_NEXS_BLOCKED_INVENTORY");
  assert.ok(capability);
  assert.equal(capability.readOnly, true);
  assert.equal(capability.write, false);
  assert.deepEqual(capability.allowedRoles.sort(), ["ADMIN", "USER"]);
  assert.equal(typeof capability.buildPayload, "function");
  assert.equal(typeof capability.validateResult, "function");
});

test("GET_NEXS_BLOCKED_INVENTORY appears in listCapabilityNames()", () => {
  assert.ok(registry.listCapabilityNames().includes("GET_NEXS_BLOCKED_INVENTORY"));
});

test("registry's buildPayload threads params (pid/facilityCode) through to the capability's own buildPayload", () => {
  const capability = registry.getCapability("GET_NEXS_BLOCKED_INVENTORY");
  const payload = capability.buildPayload({ pid: "999", facilityCode: "NXS3" });
  assert.equal(payload.pid, "999");
  assert.equal(payload.facilityCode, "NXS3");
  assert.equal(Object.keys(payload).includes("secret"), false);
});

test("this capability's timeout is backed by its own config value (a positive number, present alongside the other capability families')", () => {
  const config = require("../../../config");
  assert.ok(Number.isFinite(config.nexsCapabilityTimeoutMs) && config.nexsCapabilityTimeoutMs > 0);
});
