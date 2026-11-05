// Pure unit tests for server/features/locked-tote-info/classification.js - the SD/P0/P1/P2
// classification algorithm. No database, no network, no capability call,
// no Quadron mutation.

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyLockedTotes, baseToteId } = require("../../../platform/domain/classification");

function locked(toteId, overrides = {}) {
  return { toteId, tracker: "T1", location: "0012A", zone: "5", shuttle: "S1", ...overrides };
}
function inventoryEntry(toteId, partitions) {
  return { toteId, quadronQty: partitions.reduce((s, p) => s + p.qty, 0), partitions };
}

test("SD wins regardless of PID scarcity - a supervisor-cross-referenced tote is SD even with an abundant PID", () => {
  const lockedRows = [locked("TS0000000001")];
  const supervisorRows = [{ toteId: "TS0000000001" }];
  const inventoryRows = [inventoryEntry("TS0000000001", [{ part: 1, qty: 5, sku: "SKU-ABUNDANT" }, ...Array.from({ length: 10 }, (_, i) => ({ part: 2, qty: 1, sku: "SKU-ABUNDANT" }))])];
  const { totes, summary } = classifyLockedTotes({ lockedRows, supervisorRows, inventoryRows, p0MaxTotes: 1, p1MaxTotes: 3 });
  assert.equal(totes[0].priority, "SD");
  assert.equal(totes[0].reason, "Supervisor Dump cross-reference");
  assert.equal(summary.sdCount, 1);
  assert.equal(summary.p0Count, 0);
});

test("a supervisor tote NOT present in Locked Dump is excluded entirely - not SD, not counted", () => {
  const lockedRows = [locked("TS0000000001")];
  const supervisorRows = [{ toteId: "TS0000000001" }, { toteId: "TS0000009999" }]; // second tote isn't locked
  const { totes, summary } = classifyLockedTotes({ lockedRows, supervisorRows, inventoryRows: [] });
  assert.equal(totes.length, 1);
  assert.equal(summary.supervisorRawCount, 2);
  assert.equal(summary.supervisorIntersectedCount, 1);
});

test("boundary: worstCount exactly equal to p0MaxTotes classifies as P0", () => {
  const lockedRows = [locked("TS0000000001")];
  const inventoryRows = [inventoryEntry("TS0000000001", [{ part: 1, qty: 1, sku: "SKU-A" }])]; // 1 tote holds SKU-A
  const { totes } = classifyLockedTotes({ lockedRows, inventoryRows, p0MaxTotes: 1, p1MaxTotes: 3 });
  assert.equal(totes[0].priority, "P0");
  assert.equal(totes[0].scarcityCount, 1);
});

test("boundary: worstCount exactly equal to p1MaxTotes classifies as P1, not P0", () => {
  const lockedRows = [locked("TS0000000001")];
  const inventoryRows = [
    inventoryEntry("TS0000000001", [{ part: 1, qty: 1, sku: "SKU-A" }]),
    inventoryEntry("TS0000000002", [{ part: 1, qty: 1, sku: "SKU-A" }]),
    inventoryEntry("TS0000000003", [{ part: 1, qty: 1, sku: "SKU-A" }]),
  ];
  const { totes } = classifyLockedTotes({ lockedRows: [locked("TS0000000001")], inventoryRows, p0MaxTotes: 1, p1MaxTotes: 3 });
  assert.equal(totes[0].priority, "P1");
  assert.equal(totes[0].scarcityCount, 3);
});

test("boundary: worstCount one above p1MaxTotes falls back to P2", () => {
  const inventoryRows = [1, 2, 3, 4].map((n) => inventoryEntry(`TS000000000${n}`, [{ part: 1, qty: 1, sku: "SKU-A" }]));
  const { totes } = classifyLockedTotes({ lockedRows: [locked("TS0000000001")], inventoryRows, p0MaxTotes: 1, p1MaxTotes: 3 });
  assert.equal(totes[0].priority, "P2");
  assert.equal(totes[0].scarcityCount, 4);
});

test("multi-PID tote: the scarcest (fewest-totes) PID wins, not the first or the most abundant", () => {
  const lockedRows = [locked("TS0000000001")];
  const inventoryRows = [
    inventoryEntry("TS0000000001", [
      { part: 1, qty: 1, sku: "SKU-COMMON" },
      { part: 2, qty: 1, sku: "SKU-RARE" },
    ]),
    // SKU-COMMON also held by 4 other totes -> count 5; SKU-RARE held by nobody else -> count 1
    inventoryEntry("TS0000000002", [{ part: 1, qty: 1, sku: "SKU-COMMON" }]),
    inventoryEntry("TS0000000003", [{ part: 1, qty: 1, sku: "SKU-COMMON" }]),
    inventoryEntry("TS0000000004", [{ part: 1, qty: 1, sku: "SKU-COMMON" }]),
    inventoryEntry("TS0000000005", [{ part: 1, qty: 1, sku: "SKU-COMMON" }]),
  ];
  const { totes } = classifyLockedTotes({ lockedRows, inventoryRows, p0MaxTotes: 1, p1MaxTotes: 3 });
  assert.equal(totes[0].priority, "P0");
  assert.equal(totes[0].worstPid, "SKU-RARE");
  assert.equal(totes[0].scarcityCount, 1);
});

test("a tote absent from inventory entirely defaults to P2 with the correct reason", () => {
  const { totes } = classifyLockedTotes({ lockedRows: [locked("TS0000000001")], inventoryRows: [] });
  assert.equal(totes[0].priority, "P2");
  assert.equal(totes[0].reason, "Not in ASRS — defaulting to P2");
  assert.equal(totes[0].worstPid, null);
  assert.equal(totes[0].scarcityCount, null);
});

test("zone/location/tracker/shuttle pass through unchanged from the Locked Dump row", () => {
  const { totes } = classifyLockedTotes({ lockedRows: [locked("TS0000000001", { zone: "12", location: "0099Z", tracker: "TR9", shuttle: "SH3" })], inventoryRows: [] });
  assert.equal(totes[0].zone, "12");
  assert.equal(totes[0].location, "0099Z");
  assert.equal(totes[0].tracker, "TR9");
  assert.equal(totes[0].shuttle, "SH3");
});

test("summary counts always equal the sum of totes[].priority tallies", () => {
  const lockedRows = [locked("TS0000000001"), locked("TS0000000002"), locked("TS0000000003")];
  const supervisorRows = [{ toteId: "TS0000000001" }];
  const inventoryRows = [inventoryEntry("TS0000000002", [{ part: 1, qty: 1, sku: "SKU-A" }])];
  const { totes, summary } = classifyLockedTotes({ lockedRows, supervisorRows, inventoryRows, p0MaxTotes: 1, p1MaxTotes: 3 });
  const tally = { SD: 0, P0: 0, P1: 0, P2: 0 };
  for (const t of totes) tally[t.priority]++;
  assert.equal(summary.sdCount, tally.SD);
  assert.equal(summary.p0Count, tally.P0);
  assert.equal(summary.p1Count, tally.P1);
  assert.equal(summary.p2Count, tally.P2);
  assert.equal(summary.total, totes.length);
  assert.equal(summary.lockedCount, 3);
});

test("Locked Dump rows are deduped by base tote id", () => {
  const { totes } = classifyLockedTotes({ lockedRows: [locked("TS0000000001"), locked("TS0000000001")], inventoryRows: [] });
  assert.equal(totes.length, 1);
});

test("missing/null supervisorRows and inventoryRows (degraded mode) do not throw - classifies with what's available", () => {
  const { totes, summary } = classifyLockedTotes({ lockedRows: [locked("TS0000000001")], supervisorRows: null, inventoryRows: undefined });
  assert.equal(totes[0].priority, "P2");
  assert.equal(summary.supervisorRawCount, 0);
});

test("baseToteId strips a partition suffix and uppercases", () => {
  assert.equal(baseToteId("ts0000018492-6"), "TS0000018492");
  assert.equal(baseToteId("TS0000018492"), "TS0000018492");
});

// ═══════════════════════════════════════════════════════════════════════
// Total Tote Inv - reads straight through the already-aggregated
// quadronQty field GET_QUADRON_INVENTORY's own runtime handler computes
// (sums materialDetails[].quantity across every partition row for a base
// tote - see runtime/background/capabilities.js). Never re-derived,
// estimated, or defaulted to 0 here.
// ═══════════════════════════════════════════════════════════════════════

test("Total Tote Inv aggregation: reflects the inventory entry's own quadronQty (already summed across partitions)", () => {
  const inventoryRows = [inventoryEntry("TS0000000001", [{ part: 1, qty: 2, sku: "SKU-A" }, { part: 2, qty: 3, sku: "SKU-B" }])];
  const { totes } = classifyLockedTotes({ lockedRows: [locked("TS0000000001")], inventoryRows, p0MaxTotes: 1, p1MaxTotes: 3 });
  assert.equal(totes[0].totalToteInv, 5);
});

test("Total Tote Inv is independent of priority - an SD tote still reports its real quantity, not null", () => {
  const inventoryRows = [inventoryEntry("TS0000000001", [{ part: 1, qty: 7, sku: "SKU-A" }])];
  const { totes } = classifyLockedTotes({
    lockedRows: [locked("TS0000000001")],
    supervisorRows: [{ toteId: "TS0000000001" }],
    inventoryRows,
    p0MaxTotes: 1,
    p1MaxTotes: 3,
  });
  assert.equal(totes[0].priority, "SD");
  assert.equal(totes[0].totalToteInv, 7);
});

test("Total Tote Inv is explicitly null (never 0, never fabricated) when the tote has no matching inventory entry", () => {
  const { totes } = classifyLockedTotes({ lockedRows: [locked("TS0000000001")], inventoryRows: [] });
  assert.equal(totes[0].totalToteInv, null);
});

test("Total Tote Inv is null for every tote when Quadron Inventory itself is missing/degraded (null/undefined inventoryRows)", () => {
  const { totes } = classifyLockedTotes({ lockedRows: [locked("TS0000000001"), locked("TS0000000002")], inventoryRows: null });
  assert.equal(totes[0].totalToteInv, null);
  assert.equal(totes[1].totalToteInv, null);
});

test("Total Tote Inv handles a malformed quadronQty (non-numeric) safely - surfaces as unavailable, not NaN or a crash", () => {
  const inventoryRows = [{ toteId: "TS0000000001", quadronQty: "not-a-number", partitions: [{ part: 1, qty: 1, sku: "SKU-A" }] }];
  const { totes } = classifyLockedTotes({ lockedRows: [locked("TS0000000001")], inventoryRows, p0MaxTotes: 1, p1MaxTotes: 3 });
  assert.equal(totes[0].totalToteInv, null);
  assert.equal(totes[0].priority, "P0"); // PID scarcity logic (unrelated to quadronQty) is still unaffected
});

test("Total Tote Inv of exactly 0 is preserved as 0, not treated as unavailable", () => {
  const inventoryRows = [{ toteId: "TS0000000001", quadronQty: 0, partitions: [] }];
  const { totes } = classifyLockedTotes({ lockedRows: [locked("TS0000000001")], inventoryRows });
  assert.equal(totes[0].totalToteInv, 0);
});

test("worstPid is still computed (Reason may reference it) even though it is no longer meant to be its own UI column", () => {
  const inventoryRows = [inventoryEntry("TS0000000001", [{ part: 1, qty: 1, sku: "SKU-A" }])];
  const { totes } = classifyLockedTotes({ lockedRows: [locked("TS0000000001")], inventoryRows, p0MaxTotes: 1, p1MaxTotes: 3 });
  assert.equal(totes[0].worstPid, "SKU-A");
  assert.match(totes[0].reason, /SKU-A/);
});
