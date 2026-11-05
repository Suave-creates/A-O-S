// Unit tests for server/integrations/grafana/grafanaToteFinder.js - buildPayload/
// validateResult only. No network, no runtime, no real Grafana call.

const test = require("node:test");
const assert = require("node:assert/strict");
const cap = require("../../../integrations/grafana/grafanaToteFinder");

test("buildPayload embeds the fixed datasource and both finder/scan SQL strings", () => {
  const payload = cap.buildPayload("https://grafana.example", { totes: ["TS0000018492"] });
  assert.equal(payload.datasourceUid, "rerQ11pVk");
  assert.match(payload.finderSql, /location_tracker/);
  assert.match(payload.finderSql, /'TS0000018492'/);
  assert.match(payload.scanSql, /scanner_events/);
  assert.match(payload.scanSql, /'TS0000018492'/);
});

test("buildPayload rejects an empty/missing totes array", () => {
  assert.throws(() => cap.buildPayload("https://grafana.example", { totes: [] }), /non-empty totes array/);
});

test("buildPayload rejects an invalid tote id", () => {
  assert.throws(() => cap.buildPayload("https://grafana.example", { totes: ["not-a-tote"] }), /invalid tote id/);
});

test("validateResult accepts well-shaped finderRows/scanRows", () => {
  const r = cap.validateResult({
    finderRows: [{ tracker: "T1", container: "TS0000018492", location: "007-01", lane: "L1", updated_timestamp: "2026-01-01" }],
    scanRows: [{ scanner: "SC1", container: "TS0000018492", create_time: "2026-01-01", decision: "OK", decision_reason: null }],
  });
  assert.equal(r.ok, true);
});

test("validateResult rejects missing/non-array finderRows or scanRows", () => {
  assert.equal(cap.validateResult({}).ok, false);
  assert.equal(cap.validateResult({ finderRows: [], scanRows: "nope" }).ok, false);
});

test("validateResult rejects an unexpected field in either row type", () => {
  assert.equal(cap.validateResult({ finderRows: [{ container: "T1", extra: "x" }], scanRows: [] }).ok, false);
  assert.equal(cap.validateResult({ finderRows: [], scanRows: [{ container: "T1", extra: "x" }] }).ok, false);
});
