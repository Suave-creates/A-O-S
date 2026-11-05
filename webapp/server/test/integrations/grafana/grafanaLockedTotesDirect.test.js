// Unit tests for server/integrations/grafana/grafanaLockedTotesDirect.js's
// shapeResult() - the positional values[0..4] -> {toteId,tracker,location,
// zone,shuttle} extraction, ported from the runtime's own
// executeGetGrafanaLockedTotes(). execute() itself (the grafanaQueryDirect
// wiring) is covered by grafanaQueryDirect.test.js - these tests only
// exercise the pure row-shaping.

const test = require("node:test");
const assert = require("node:assert/strict");
const { shapeResult } = require("../../../integrations/grafana/grafanaLockedTotesDirect");

function frameOf(values) {
  return { results: { A: { frames: [{ data: { values } }] } } };
}

test("shapeResult(): maps values[0..4] positionally to toteId/tracker/location/zone/shuttle", () => {
  const values = [
    ["TL0000000001", "TS0000000002"], // Container
    ["TR1", "TR2"], // Tracker
    ["001-01-1", "002-02-1"], // Location
    ["Z1", "Z2"], // Zone
    ["S1", "S2"], // Shuttle
  ];
  const result = shapeResult(frameOf(values));
  assert.deepEqual(result.rows, [
    { toteId: "TL0000000001", tracker: "TR1", location: "001-01-1", zone: "Z1", shuttle: "S1" },
    { toteId: "TS0000000002", tracker: "TR2", location: "002-02-1", zone: "Z2", shuttle: "S2" },
  ]);
  assert.equal(result.rowCount, 2);
});

test("shapeResult(): drops rows whose Container fails the TL/TS tote id pattern", () => {
  const values = [["NOT-A-TOTE", "TL0000000001"], ["T1", "T2"], ["L1", "L2"], ["Z1", "Z2"], ["S1", "S2"]];
  const result = shapeResult(frameOf(values));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].toteId, "TL0000000001");
});

test("shapeResult(): a missing optional column (tracker/location/zone/shuttle) becomes null, not undefined/crash", () => {
  const values = [["TL0000000001"]]; // only Container present
  const result = shapeResult(frameOf(values));
  assert.deepEqual(result.rows[0], { toteId: "TL0000000001", tracker: null, location: null, zone: null, shuttle: null });
});

test("shapeResult(): an empty/missing frame returns an empty result, never throws", () => {
  const result = shapeResult({});
  assert.deepEqual(result.rows, []);
  assert.equal(result.rowCount, 0);
  assert.deepEqual(shapeResult(frameOf([])).rows, []);
});
