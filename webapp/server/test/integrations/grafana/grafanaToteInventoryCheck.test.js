// Unit tests for server/integrations/grafana/grafanaToteInventoryCheck.js - pure
// SQL-building and validation logic, no network/capability dispatch.

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPayload, validateResult, buildSql, MAX_TOTES } = require("../../../integrations/grafana/grafanaToteInventoryCheck");

test("buildSql(): ORs one LIKE clause per tote, matching the captured single-tote query shape", () => {
  const sql = buildSql(["TL0000025362"]);
  assert.match(sql, /use lenskart_wes/);
  assert.match(sql, /select \* from tote_details where \(container like 'TL0000025362-%'\)/);
});

test("buildSql(): multiple totes are OR'd together in one WHERE clause", () => {
  const sql = buildSql(["TL0000025362", "TS0000018492"]);
  assert.match(sql, /container like 'TL0000025362-%' OR container like 'TS0000018492-%'/);
});

test("buildPayload(): rejects an empty totes array", () => {
  assert.throws(() => buildPayload("https://x", { totes: [] }), /non-empty totes array/);
});

test("buildPayload(): rejects a missing totes param", () => {
  assert.throws(() => buildPayload("https://x", {}), /non-empty totes array/);
});

test("buildPayload(): rejects invalid tote ids (defense in depth - the engine already validates, but this capability must never trust a caller blindly)", () => {
  assert.throws(() => buildPayload("https://x", { totes: ["not-a-tote"] }), /invalid tote id/);
});

test("buildPayload(): rejects more than MAX_TOTES totes, never silently truncates", () => {
  const totes = Array.from({ length: MAX_TOTES + 1 }, (_, i) => `TL${String(i).padStart(10, "0")}`);
  assert.throws(() => buildPayload("https://x", { totes }), new RegExp(`exceeds the ${MAX_TOTES} limit`));
});

test("buildPayload(): on success, carries the datasource/sql/range shape every Grafana capability uses", () => {
  const payload = buildPayload("https://192.168.24.230", { totes: ["TL0000025362"] });
  assert.equal(payload.grafanaOrigin, "https://192.168.24.230");
  assert.equal(payload.datasourceUid, "rerQ11pVk");
  assert.equal(payload.datasourceType, "mssql");
  assert.equal(payload.datasourceId, 1);
  assert.ok(payload.sql.includes("TL0000025362"));
  assert.ok(payload.fromMs < payload.toMs);
});

test("validateResult(): accepts rows with exactly the real response's own field set", () => {
  const result = { rows: [{ id: 1, container: "TL0000025362-1", partition: "1", sku: "220529", serialId: "JJJ020093840", create_time: "2026-10-01T00:00:00Z" }] };
  assert.deepEqual(validateResult(result), { ok: true });
});

test("validateResult(): rejects a non-array rows field", () => {
  assert.equal(validateResult({ rows: "nope" }).ok, false);
});

test("validateResult(): rejects a row with no container", () => {
  assert.equal(validateResult({ rows: [{ id: 1 }] }).ok, false);
});

test("validateResult(): rejects a row with an unexpected field, never silently passes unknown data through", () => {
  const result = { rows: [{ container: "TL0000025362-1", unexpectedField: "x" }] };
  assert.equal(validateResult(result).ok, false);
});

test("validateResult(): an empty rows array (no partitions found for any requested tote) is still valid, never an error", () => {
  assert.deepEqual(validateResult({ rows: [] }), { ok: true });
});
