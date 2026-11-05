// Unit tests for server/integrations/grafana/grafanaSupervisorDumpDirect.js's
// shapeResult() - the positional values[13]/values[15] LOCKED-status +
// embedded-tote-id extraction, ported from the runtime's own
// executeGetGrafanaSupervisorDump().

const test = require("node:test");
const assert = require("node:assert/strict");
const { shapeResult } = require("../../../integrations/grafana/grafanaSupervisorDumpDirect");

function frameOf(values) {
  return { results: { A: { frames: [{ data: { values } }] } } };
}

test("shapeResult(): a row whose [13] status contains LOCKED and [15] has an embedded tote id is included", () => {
  const values = [];
  values[13] = ["007-06-1-217-1-02///LOCKED/HEALTHY/"];
  values[15] = ["007-06-1-217-1-02/TS0000003490-1/QUADRON/"];
  const result = shapeResult(frameOf(values));
  assert.deepEqual(result.rows, [{ toteId: "TS0000003490" }]);
});

test("shapeResult(): a row whose [13] status does NOT contain LOCKED is excluded", () => {
  const values = [];
  // Deliberately NOT "UNLOCKED" - status.includes("LOCKED") is a substring
  // match ported verbatim from the runtime, and "UNLOCKED" would actually
  // match it (contains "LOCKED"); a genuinely non-matching real status is
  // used here instead, matching the runtime's own real values.
  values[13] = ["007-06-1-217-1-02///ACKNOWLEDGEMENT_AWAITING/HEALTHY/"];
  values[15] = ["007-06-1-217-1-02/TS0000003490-1/QUADRON/"];
  const result = shapeResult(frameOf(values));
  assert.deepEqual(result.rows, []);
});

test("shapeResult(): case-insensitive LOCKED match (status is upper-cased before checking)", () => {
  const values = [];
  values[13] = ["///locked//"];
  values[15] = ["x/TL0000000001-2/y"];
  const result = shapeResult(frameOf(values));
  assert.deepEqual(result.rows, [{ toteId: "TL0000000001" }]);
});

test("shapeResult(): duplicate tote ids across rows are deduplicated", () => {
  const values = [];
  values[13] = ["LOCKED", "LOCKED"];
  values[15] = ["a/TL0000000001-1/b", "a/TL0000000001-2/b"];
  const result = shapeResult(frameOf(values));
  assert.equal(result.rows.length, 1);
});

test("shapeResult(): a missing frame returns an empty result, never throws", () => {
  const result = shapeResult({});
  assert.deepEqual(result.rows, []);
  assert.equal(result.rowCount, 0);
});
