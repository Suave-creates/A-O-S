// Unit tests for server/integrations/grafana/grafanaAsrsProductionNjit.js -
// buildPayload/validateResult only. No network, no runtime, no real
// Grafana call.

const test = require("node:test");
const assert = require("node:assert/strict");
const grafanaAsrsProductionNjit = require("../../../integrations/grafana/grafanaAsrsProductionNjit");

function make8() {
  return Array.from({ length: 8 }, (_, i) => ({ from: i * 1000, to: (i + 1) * 1000 }));
}
const HOUR_WINDOWS = { A: make8(), B: make8(), C: make8() };

test("buildPayload embeds the fixed SQL/datasource (rerQ11pVk - same as CC Metrics/Tote Freed) and the caller-supplied hourWindows verbatim", () => {
  const payload = grafanaAsrsProductionNjit.buildPayload("https://grafana.example", { hourWindows: HOUR_WINDOWS });
  assert.equal(payload.grafanaOrigin, "https://grafana.example");
  assert.equal(payload.datasourceUid, "rerQ11pVk");
  assert.equal(payload.datasourceType, "mssql");
  assert.equal(payload.datasourceId, 1);
  assert.match(payload.sql, /completedOrders/);
  assert.match(payload.sql, /sales_order/);
  assert.deepEqual(payload.hourWindows, HOUR_WINDOWS);
});

test("buildPayload throws if a shift's hour array is missing/wrong length/malformed - never silently sends a partial request", () => {
  assert.throws(() => grafanaAsrsProductionNjit.buildPayload("https://grafana.example", { hourWindows: { A: HOUR_WINDOWS.A, B: HOUR_WINDOWS.B } }), /hourWindows\.C/);
  assert.throws(() => grafanaAsrsProductionNjit.buildPayload("https://grafana.example", { hourWindows: { A: HOUR_WINDOWS.A.slice(0, 7), B: HOUR_WINDOWS.B, C: HOUR_WINDOWS.C } }), /hourWindows\.A/);
  assert.throws(() => grafanaAsrsProductionNjit.buildPayload("https://grafana.example", {}), /hourWindows\.A/);
});

test("validateResult accepts a well-shaped result with all three shifts as 8-element finite-number arrays", () => {
  assert.deepEqual(
    grafanaAsrsProductionNjit.validateResult({ hours: { A: [1, 2, 3, 4, 5, 6, 7, 8], B: [0, 0, 0, 0, 0, 0, 0, 0], C: [1, 1, 1, 1, 1, 1, 1, 1] } }),
    { ok: true }
  );
});

test("validateResult rejects a result missing a shift", () => {
  const v = grafanaAsrsProductionNjit.validateResult({ hours: { A: [1, 2, 3, 4, 5, 6, 7, 8], B: [1, 2, 3, 4, 5, 6, 7, 8] } });
  assert.equal(v.ok, false);
  assert.match(v.reason, /hours\.C/);
});

test("validateResult rejects an hour array that isn't exactly 8 entries", () => {
  const v = grafanaAsrsProductionNjit.validateResult({ hours: { A: [1, 2, 3], B: [1, 2, 3, 4, 5, 6, 7, 8], C: [1, 2, 3, 4, 5, 6, 7, 8] } });
  assert.equal(v.ok, false);
  assert.match(v.reason, /hours\.A/);
});

test("validateResult rejects a non-numeric or non-finite hour value - never silently coerces a bad value into a fabricated count", () => {
  const bad = (v) => ({ hours: { A: [v, 0, 0, 0, 0, 0, 0, 0], B: [0, 0, 0, 0, 0, 0, 0, 0], C: [0, 0, 0, 0, 0, 0, 0, 0] } });
  assert.equal(grafanaAsrsProductionNjit.validateResult(bad("3")).ok, false);
  assert.equal(grafanaAsrsProductionNjit.validateResult(bad(NaN)).ok, false);
  // null is a SKIPPED hour (live day cache - not queried), never turned into a count; it is allowed
  assert.equal(grafanaAsrsProductionNjit.validateResult(bad(null)).ok, true);
});

test("validateResult rejects a completely malformed result", () => {
  assert.equal(grafanaAsrsProductionNjit.validateResult(null).ok, false);
  assert.equal(grafanaAsrsProductionNjit.validateResult({}).ok, false);
});
