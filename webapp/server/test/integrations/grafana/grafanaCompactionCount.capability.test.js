// Unit tests for server/integrations/grafana/grafanaCompactionCount.js -
// buildPayload/validateResult only. No network, no runtime, no real
// Grafana call.

const test = require("node:test");
const assert = require("node:assert/strict");
const grafanaCompactionCount = require("../../../integrations/grafana/grafanaCompactionCount");

const WINDOWS = {
  A: { from: 1000, to: 2000 },
  B: { from: 2000, to: 3000 },
  C: { from: 3000, to: 4000 },
};

test("buildPayload embeds the fixed SQL/datasource (the separate GTP instance, not the shared rerQ11pVk one) and the caller-supplied windows verbatim", () => {
  const payload = grafanaCompactionCount.buildPayload("https://grafana.example", { windows: WINDOWS });
  assert.equal(payload.grafanaOrigin, "https://grafana.example");
  assert.equal(payload.datasourceUid, "BE6qWEb4z");
  assert.equal(payload.datasourceType, "mssql");
  assert.equal(payload.datasourceId, 6);
  assert.match(payload.sql, /compaction_transaction_history/);
  assert.match(payload.sql, /total_compactions/);
  assert.deepEqual(payload.windows, WINDOWS);
});

test("buildPayload throws if any shift window is missing/malformed - never silently sends a partial request", () => {
  assert.throws(() => grafanaCompactionCount.buildPayload("https://grafana.example", { windows: { A: WINDOWS.A, B: WINDOWS.B } }), /windows\.C/);
  assert.throws(() => grafanaCompactionCount.buildPayload("https://grafana.example", { windows: {} }), /windows\.A/);
  assert.throws(() => grafanaCompactionCount.buildPayload("https://grafana.example", {}), /windows\.A/);
});

test("validateResult accepts a well-shaped result with all three shift windows as finite numbers", () => {
  assert.deepEqual(grafanaCompactionCount.validateResult({ windows: { A: 3, B: 0, C: 12 } }), { ok: true });
});

test("validateResult rejects a result missing a shift window", () => {
  const v = grafanaCompactionCount.validateResult({ windows: { A: 1, B: 2 } });
  assert.equal(v.ok, false);
  assert.match(v.reason, /windows\.C/);
});

test("validateResult rejects a non-numeric or non-finite shift value - never silently coerces a bad value into a fabricated count", () => {
  assert.equal(grafanaCompactionCount.validateResult({ windows: { A: "3", B: 0, C: 0 } }).ok, false);
  assert.equal(grafanaCompactionCount.validateResult({ windows: { A: NaN, B: 0, C: 0 } }).ok, false);
  // null is a SKIPPED shift (live day cache - not queried), never turned into a count; it is allowed
  assert.equal(grafanaCompactionCount.validateResult({ windows: { A: null, B: 0, C: 0 } }).ok, true);
});

test("validateResult rejects a completely malformed result", () => {
  assert.equal(grafanaCompactionCount.validateResult(null).ok, false);
  assert.equal(grafanaCompactionCount.validateResult({}).ok, false);
});
