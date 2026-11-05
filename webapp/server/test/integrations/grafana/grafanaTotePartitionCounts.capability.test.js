// Unit tests for server/integrations/grafana/grafanaTotePartitionCounts.js -
// buildPayload/validateResult only. No network, no runtime, no real Grafana
// call.

const test = require("node:test");
const assert = require("node:assert/strict");
const cap = require("../../../integrations/grafana/grafanaTotePartitionCounts");

test("buildPayload embeds the fixed datasource and chunks the tote list into per-chunk SQL queries", () => {
  const payload = cap.buildPayload("https://grafana.example", { totes: ["TS0000018492", "TL0000002607"], chunkSize: 1 });
  assert.equal(payload.grafanaOrigin, "https://grafana.example");
  assert.equal(payload.datasourceUid, "rerQ11pVk");
  assert.equal(payload.datasourceType, "mssql");
  assert.equal(payload.datasourceId, 1);
  assert.equal(payload.queries.length, 2, "chunkSize:1 with 2 totes must produce 2 separate query chunks");
  assert.match(payload.queries[0].sql, /container like 'TS0000018492-%'/);
  assert.match(payload.queries[1].sql, /container like 'TL0000002607-%'/);
});

test("buildPayload with the default chunk size groups multiple totes into one query", () => {
  const payload = cap.buildPayload("https://grafana.example", { totes: ["TS0000018492", "TL0000002607", "TS0000018493"] });
  assert.equal(payload.queries.length, 1, "3 totes with the default 40-per-chunk size must produce exactly one query");
  assert.match(payload.queries[0].sql, /container like 'TS0000018492-%' or container like 'TL0000002607-%' or container like 'TS0000018493-%'/);
});

test("buildPayload rejects an empty or missing totes array", () => {
  assert.throws(() => cap.buildPayload("https://grafana.example", { totes: [] }), /non-empty totes array/);
  assert.throws(() => cap.buildPayload("https://grafana.example", {}), /non-empty totes array/);
});

test("buildPayload rejects an invalid tote id - never lets an unvalidated string reach the SQL builder", () => {
  assert.throws(() => cap.buildPayload("https://grafana.example", { totes: ["not-a-tote"] }), /invalid tote id/);
  assert.throws(() => cap.buildPayload("https://grafana.example", { totes: ["TS0000018492'; DROP TABLE tote_details; --"] }), /invalid tote id/);
});

test("validateResult accepts a well-shaped rows array", () => {
  const r = cap.validateResult({ rows: [{ container: "TS0000018492-1", qty: 5 }] });
  assert.equal(r.ok, true);
});

test("validateResult rejects a missing/non-array rows field", () => {
  assert.equal(cap.validateResult({}).ok, false);
  assert.equal(cap.validateResult({ rows: "nope" }).ok, false);
});

test("validateResult rejects a row missing container or with a non-numeric qty", () => {
  assert.equal(cap.validateResult({ rows: [{ qty: 5 }] }).ok, false);
  assert.equal(cap.validateResult({ rows: [{ container: "TS0000018492-1", qty: "5" }] }).ok, false);
});

test("validateResult rejects an unexpected field in a row - never silently passes through extra data", () => {
  assert.equal(cap.validateResult({ rows: [{ container: "TS0000018492-1", qty: 5, extra: "x" }] }).ok, false);
});
