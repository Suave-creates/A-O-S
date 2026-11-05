// Unit tests for server/integrations/grafana/grafanaTrackerHistory.js -
// buildPayload/validateResult only. No network, no runtime, no real Grafana call.

const test = require("node:test");
const assert = require("node:assert/strict");
const cap = require("../../../integrations/grafana/grafanaTrackerHistory");

test("buildPayload embeds the fixed datasource and a numeric tracker IN-list", () => {
  const payload = cap.buildPayload("https://grafana.example", { trackers: [101, "202"] });
  assert.equal(payload.datasourceUid, "rerQ11pVk");
  assert.match(payload.sql, /tracker_history/);
  assert.match(payload.sql, /IN \(101,202\)/);
});

test("buildPayload rejects an empty/missing trackers array", () => {
  assert.throws(() => cap.buildPayload("https://grafana.example", { trackers: [] }), /non-empty trackers array/);
});

test("buildPayload rejects a non-numeric tracker id", () => {
  assert.throws(() => cap.buildPayload("https://grafana.example", { trackers: ["abc"] }), /invalid tracker id/);
});

test("validateResult accepts well-shaped rows", () => {
  const r = cap.validateResult({ rows: [{ tracker: 101, destination: "007-01", rn: 2 }] });
  assert.equal(r.ok, true);
});

test("validateResult rejects a missing/non-array rows field", () => {
  assert.equal(cap.validateResult({}).ok, false);
});

test("validateResult rejects an unexpected field in a row", () => {
  assert.equal(cap.validateResult({ rows: [{ tracker: 101, destination: "x", rn: 1, extra: "y" }] }).ok, false);
});
