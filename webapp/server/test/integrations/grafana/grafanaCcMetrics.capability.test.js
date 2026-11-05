// Unit tests for server/integrations/grafana/grafanaCcMetrics.js - buildPayload/
// validateResult only. No network, no runtime, no real Grafana call.

const test = require("node:test");
const assert = require("node:assert/strict");
const grafanaCcMetrics = require("../../../integrations/grafana/grafanaCcMetrics");

const WINDOWS = {
  A: { from: 1000, to: 2000 },
  B: { from: 2000, to: 3000 },
  C: { from: 3000, to: 4000 },
};

test("buildPayload embeds the fixed SQL/datasource and the caller-supplied windows verbatim", () => {
  const payload = grafanaCcMetrics.buildPayload("https://grafana.example", { windows: WINDOWS });
  assert.equal(payload.grafanaOrigin, "https://grafana.example");
  assert.equal(payload.datasourceUid, "rerQ11pVk");
  assert.equal(payload.datasourceType, "mssql");
  assert.equal(payload.datasourceId, 1);
  assert.match(payload.discrepancySql, /verification_events/);
  assert.match(payload.stockCheckSql, /stock_check_tote_history/);
  assert.deepEqual(payload.windows, WINDOWS);
});

// Regression: the stock-check SQL was ported from the legacy extension
// (background/index.js:561-580) with its entire WHERE clause silently
// dropped, leaving an unfiltered join across the full history tables. Live
// impact: every shift window returned exactly 1,000,000 rows (Grafana's
// datasource row cap) instead of a real shift-scoped result, guaranteeing
// GET_GRAFANA_CC_METRICS could never complete before its timeout (a live
// diagnostic trace showed 0/32 attempts ever completing). Unlike
// discrepancySql (which uses Grafana's $__timeFilter() macro), the legacy
// stock-check query always used a manual DATEADD-based IST offset - both
// must be present, verbatim, or the bug reappears silently.
test("buildPayload's stockCheckSql is time-windowed (WHERE clause present) - without it every call returns the datasource's full row cap, never a real shift-scoped result", () => {
  const payload = grafanaCcMetrics.buildPayload("https://grafana.example", { windows: WINDOWS });
  assert.match(payload.stockCheckSql, /WHERE/);
  assert.match(payload.stockCheckSql, /sch\.create_time >= CAST\(DATEADD\(HOUR, 5, DATEADD\(MINUTE, 30, \$__timeFrom\(\)\)\) AS datetime\)/);
  assert.match(payload.stockCheckSql, /sch\.create_time < CAST\(DATEADD\(HOUR, 5, DATEADD\(MINUTE, 30, \$__timeTo\(\)\)\) AS datetime\)/);
});

test("buildPayload throws if any shift window is missing/malformed - never silently sends a partial request", () => {
  assert.throws(() => grafanaCcMetrics.buildPayload("https://grafana.example", { windows: { A: WINDOWS.A, B: WINDOWS.B } }), /windows\.C/);
  assert.throws(() => grafanaCcMetrics.buildPayload("https://grafana.example", { windows: {} }), /windows\.A/);
  assert.throws(() => grafanaCcMetrics.buildPayload("https://grafana.example", {}), /windows\.A/);
});

function validResult() {
  return {
    windows: {
      A: { discRows: [{ station: "5", discrepancyType: "SHORT", container: "TL0000000001" }], stockRows: [{ container: "TL0000000001", station: "5" }] },
      B: { discRows: [], stockRows: [] },
      C: { discRows: [], stockRows: [] },
    },
  };
}

test("validateResult accepts a well-shaped result with all three shift windows", () => {
  assert.deepEqual(grafanaCcMetrics.validateResult(validResult()), { ok: true });
});

test("validateResult rejects a result missing a shift window", () => {
  const r = validResult();
  delete r.windows.C;
  const v = grafanaCcMetrics.validateResult(r);
  assert.equal(v.ok, false);
  assert.match(v.reason, /windows\.C/);
});

test("validateResult rejects a discRows/stockRows entry with an unexpected field (never silently passes through extra data)", () => {
  const r = validResult();
  r.windows.A.discRows[0].secretToken = "abc";
  const v = grafanaCcMetrics.validateResult(r);
  assert.equal(v.ok, false);
  assert.match(v.reason, /unexpected field/);
});

test("validateResult rejects when discRows/stockRows is not an array", () => {
  const r = validResult();
  r.windows.B.stockRows = "not-an-array";
  const v = grafanaCcMetrics.validateResult(r);
  assert.equal(v.ok, false);
  assert.match(v.reason, /must be an array/);
});

test("validateResult rejects a completely malformed result", () => {
  assert.equal(grafanaCcMetrics.validateResult(null).ok, false);
  assert.equal(grafanaCcMetrics.validateResult({}).ok, false);
});
