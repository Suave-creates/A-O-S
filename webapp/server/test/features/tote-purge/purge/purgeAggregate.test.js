// Unit tests for server/features/tote-purge/purge/purgeAggregate.js - pure, no I/O, no
// network, no Quadron/Grafana/Concinity/Runtime call anywhere in this file.

const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregateAsrsRows } = require("../../../../features/tote-purge/purge/purgeAggregate");

function row(pid, toteId, barcodeCount, partition) {
  return { pid, toteId, barcodeCount, partition: partition || "" };
}

test("PID aggregation: totals inventory and collects distinct totes per PID", () => {
  const { pidAgg } = aggregateAsrsRows([
    row("1", "TS0000000001", 3, "PR1"),
    row("1", "TS0000000002", 4, "PR1"),
    row("1", "TS0000000001", 1, "PR1"), // same tote again - totals still sum, tote set stays size 1 for this tote
  ]);
  assert.equal(pidAgg["1"].totalInventory, 8);
  assert.equal(pidAgg["1"].totes.size, 2);
  assert.ok(pidAgg["1"].totes.has("TS0000000001"));
  assert.ok(pidAgg["1"].totes.has("TS0000000002"));
});

test("tote aggregation: collects rows and distinct PIDs per tote", () => {
  const { toteAgg } = aggregateAsrsRows([row("1", "TS0000000001", 3, "PR1"), row("2", "TS0000000001", 5, "PR2")]);
  assert.equal(toteAgg["TS0000000001"].rows.length, 2);
  assert.equal(toteAgg["TS0000000001"].pids.size, 2);
});

test("rows with a missing/empty pid are ignored entirely", () => {
  const { pidAgg, toteAgg } = aggregateAsrsRows([row("", "TS0000000001", 3), row(null, "TS0000000002", 4)]);
  assert.deepEqual(Object.keys(pidAgg), []);
  assert.deepEqual(Object.keys(toteAgg), []);
});

test("rows with an invalid tote id (not TL/TS + 10 digits) are ignored entirely", () => {
  const { pidAgg, toteAgg } = aggregateAsrsRows([row("1", "NOT-A-TOTE", 3), row("1", "TX0000000001", 3), row("1", "TS12345", 3)]);
  assert.deepEqual(Object.keys(pidAgg), []);
  assert.deepEqual(Object.keys(toteAgg), []);
});

test("a valid TL tote id and a valid TS tote id are both accepted", () => {
  const { toteAgg } = aggregateAsrsRows([row("1", "TL0000000001", 3), row("2", "TS0000000002", 4)]);
  assert.ok(toteAgg["TL0000000001"]);
  assert.ok(toteAgg["TS0000000002"]);
});

test("a missing/non-numeric barcodeCount normalizes to 0, never NaN or dropped", () => {
  const { pidAgg } = aggregateAsrsRows([{ pid: "1", toteId: "TS0000000001", barcodeCount: null }]);
  assert.equal(pidAgg["1"].totalInventory, 0);
});

test("empty input never throws", () => {
  assert.doesNotThrow(() => aggregateAsrsRows([]));
  assert.doesNotThrow(() => aggregateAsrsRows(null));
  assert.doesNotThrow(() => aggregateAsrsRows(undefined));
});
