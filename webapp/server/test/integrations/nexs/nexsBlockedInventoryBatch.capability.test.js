// Unit tests for server/integrations/nexs/nexsBlockedInventoryBatch.js
// (buildPayload/validateResult) and its registration in
// server/integrations/capabilities/registry.js. No network, no Quadron/Grafana/
// Concinity/Runtime call anywhere in this file.

const test = require("node:test");
const assert = require("node:assert/strict");
const nexsBlockedInventoryBatch = require("../../../integrations/nexs/nexsBlockedInventoryBatch");
const registry = require("../../../integrations/capabilities/registry");

test("buildPayload returns { nexsOrigin, pids, facilityCode } with the given params", () => {
  const payload = nexsBlockedInventoryBatch.buildPayload("https://app.nexs.lenskart.com", { pids: ["1", "2"], facilityCode: "NXS2" });
  assert.deepEqual(payload, { nexsOrigin: "https://app.nexs.lenskart.com", pids: ["1", "2"], facilityCode: "NXS2" });
});

test("buildPayload defaults facilityCode to NXS1 when omitted, matching the single-PID capability's own default", () => {
  const payload = nexsBlockedInventoryBatch.buildPayload("https://app.nexs.lenskart.com", { pids: ["1"] });
  assert.equal(payload.facilityCode, "NXS1");
});

test("buildPayload defaults pids to an empty array when omitted or malformed, never throws", () => {
  assert.deepEqual(nexsBlockedInventoryBatch.buildPayload("https://app.nexs.lenskart.com", {}).pids, []);
  assert.deepEqual(nexsBlockedInventoryBatch.buildPayload("https://app.nexs.lenskart.com", { pids: "not-an-array" }).pids, []);
  assert.deepEqual(nexsBlockedInventoryBatch.buildPayload("https://app.nexs.lenskart.com", null).pids, []);
});

test("buildPayload never includes a secret/cookie field", () => {
  const payload = nexsBlockedInventoryBatch.buildPayload("https://app.nexs.lenskart.com", { pids: ["1"] });
  assert.deepEqual(Object.keys(payload).sort(), ["facilityCode", "nexsOrigin", "pids"]);
});

test("validateResult accepts a well-formed multi-entry result envelope", () => {
  const result = nexsBlockedInventoryBatch.validateResult({
    results: [
      { pid: "1", status: "ok", totalInventory: 500, blockedInventory: 120, availableInventory: 380, error: null },
      { pid: "2", status: "failed", totalInventory: 0, blockedInventory: 0, availableInventory: 0, error: "NexS HTTP 500" },
    ],
  });
  assert.deepEqual(result, { ok: true });
});

test("validateResult accepts an empty results array (an empty PID list is not malformed)", () => {
  assert.deepEqual(nexsBlockedInventoryBatch.validateResult({ results: [] }), { ok: true });
});

test("validateResult rejects a missing/non-array results field", () => {
  assert.equal(nexsBlockedInventoryBatch.validateResult({}).ok, false);
  assert.equal(nexsBlockedInventoryBatch.validateResult({ results: "not-an-array" }).ok, false);
  assert.equal(nexsBlockedInventoryBatch.validateResult({ results: null }).ok, false);
});

test("validateResult rejects a result entry with a missing/non-string pid", () => {
  assert.equal(nexsBlockedInventoryBatch.validateResult({ results: [{ status: "ok" }] }).ok, false);
  assert.equal(nexsBlockedInventoryBatch.validateResult({ results: [{ pid: "", status: "ok" }] }).ok, false);
  assert.equal(nexsBlockedInventoryBatch.validateResult({ results: [{ pid: 123, status: "ok" }] }).ok, false);
});

test("validateResult rejects a result entry with an invalid status", () => {
  assert.equal(nexsBlockedInventoryBatch.validateResult({ results: [{ pid: "1", status: "weird" }] }).ok, false);
  assert.equal(nexsBlockedInventoryBatch.validateResult({ results: [{ pid: "1" }] }).ok, false);
});

test("validateResult rejects a null/non-object result entirely", () => {
  assert.equal(nexsBlockedInventoryBatch.validateResult(null).ok, false);
  assert.equal(nexsBlockedInventoryBatch.validateResult(undefined).ok, false);
});

test("GET_NEXS_BLOCKED_INVENTORY_BATCH is registered in the capability registry, read-only, no write, cancellation-supported", () => {
  const capability = registry.getCapability("GET_NEXS_BLOCKED_INVENTORY_BATCH");
  assert.ok(capability);
  assert.equal(capability.readOnly, true);
  assert.equal(capability.write, false);
  assert.equal(capability.cancellationSupported, true);
  assert.deepEqual(capability.allowedRoles.sort(), ["ADMIN", "USER"]);
  assert.equal(typeof capability.buildPayload, "function");
  assert.equal(typeof capability.validateResult, "function");
});

test("GET_NEXS_BLOCKED_INVENTORY_BATCH appears in listCapabilityNames() alongside the unchanged single-PID capability", () => {
  const names = registry.listCapabilityNames();
  assert.ok(names.includes("GET_NEXS_BLOCKED_INVENTORY_BATCH"));
  assert.ok(names.includes("GET_NEXS_BLOCKED_INVENTORY"), "the single-PID capability must remain registered, unchanged");
});

test("registry's buildPayload threads params (pids/facilityCode) through to the capability's own buildPayload", () => {
  const capability = registry.getCapability("GET_NEXS_BLOCKED_INVENTORY_BATCH");
  const payload = capability.buildPayload({ pids: ["999"], facilityCode: "NXS3" });
  assert.deepEqual(payload.pids, ["999"]);
  assert.equal(payload.facilityCode, "NXS3");
  assert.equal(Object.keys(payload).includes("secret"), false);
});

test("Phase 6: the batch capability uses its OWN dedicated timeout config, independent of the single-PID capability's", () => {
  const config = require("../../../config");
  const batchCapability = registry.getCapability("GET_NEXS_BLOCKED_INVENTORY_BATCH");
  const singleCapability = registry.getCapability("GET_NEXS_BLOCKED_INVENTORY");

  assert.equal(batchCapability.timeoutMs, config.nexsBlockedInventoryBatchCapabilityTimeoutMs, "the batch capability's registered timeoutMs must come from its own dedicated config key");
  assert.equal(singleCapability.timeoutMs, config.nexsCapabilityTimeoutMs, "the single-PID capability's timeout must remain unchanged, from its own original config key");
  assert.notEqual(
    batchCapability.timeoutMs,
    singleCapability.timeoutMs,
    "the two must now be independently configurable - this is the whole point of Phase 6 (they are allowed to coincide numerically in principle, but the defaults are deliberately different: 60000 vs 30000)"
  );
});

test("Phase 6: default values - single-PID stays 30s, batch is 60s", () => {
  const config = require("../../../config");
  assert.equal(config.nexsCapabilityTimeoutMs, 30000, "single-PID GET_NEXS_BLOCKED_INVENTORY timeout must remain unchanged at 30s");
  assert.equal(config.nexsBlockedInventoryBatchCapabilityTimeoutMs, 60000, "GET_NEXS_BLOCKED_INVENTORY_BATCH's dedicated timeout must default to 60s");
});

test("Quadron's own timeout is untouched by the NexS batch timeout change", () => {
  const config = require("../../../config");
  const quadronCapability = registry.getCapability("GET_QUADRON_INVENTORY");
  assert.equal(quadronCapability.timeoutMs, config.quadronInventoryCapabilityTimeoutMs);
  assert.equal(config.quadronInventoryCapabilityTimeoutMs, 60000, "the inventory dump has its own 60s limit (8% of calls hit 30s on 2026-11-05)");
  assert.equal(registry.getCapability("PULL_QUADRON_TOTE").timeoutMs, config.quadronCapabilityTimeoutMs, "tote pulls stay on the 30s Quadron limit");
  assert.equal(config.quadronCapabilityTimeoutMs, 30000);
});
