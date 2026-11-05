// Unit tests for server/features/tote-purge/purge/purgeClassify.js - pure, no I/O, no
// network, no Quadron/Grafana/Concinity/Runtime call anywhere in this file.

const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregateAsrsRows } = require("../../../../features/tote-purge/purge/purgeAggregate");
const { preFilterCandidates, classifyByBlocked, DEFAULT_FILTERS, PURGE_SAFETY_FLOOR } = require("../../../../features/tote-purge/purge/purgeClassify");

function row(pid, toteId, barcodeCount, partition) {
  return { pid, toteId, barcodeCount, partition: partition || "" };
}

// A PID present in exactly `toteCount` totes, each tote holding exactly one
// PID line (single partition), `qtyPerTote` barcodes each - satisfies the
// default pidToteMin=3 and toteBarcodeMax=7 filters out of the box.
function makeEligiblePidRows(pid, toteCount, qtyPerTote) {
  const rows = [];
  for (let i = 0; i < toteCount; i++) {
    const tote = "TS" + String(1000000000 + i).slice(-10);
    rows.push(row(pid, tote, qtyPerTote, "PR1"));
  }
  return rows;
}

test("active-PID limit: a tote with 2 distinct PIDs is excluded when partitionMax=1 (default)", () => {
  const twoPidRows = [row("1", "TS0000009999", 2, "PR1"), row("2", "TS0000009999", 2, "PR2"), ...makeEligiblePidRows("1", 2, 2), ...makeEligiblePidRows("2", 2, 2)];
  const { pidAgg, toteAgg } = aggregateAsrsRows(twoPidRows);
  const { pre } = preFilterCandidates({ pidAgg, toteAgg }, {});
  assert.ok(!pre.some((c) => c.toteId === "TS0000009999"), "a tote with 2 distinct PIDs must be excluded under the default partitionMax=1");
});

test("active-PID limit uses DISTINCT PIDS, not the raw partition field (which is often blank)", () => {
  // Same PID, blank partition, split across two rows in the SAME tote -
  // must collapse to ONE active-PID line, not be excluded as if it had 2.
  const rows = [row("1", "TS0000001111", 2, ""), row("1", "TS0000001111", 1, ""), ...makeEligiblePidRows("1", 2, 3)];
  const { pidAgg, toteAgg } = aggregateAsrsRows(rows);
  const { pre } = preFilterCandidates({ pidAgg, toteAgg }, {});
  const candidate = pre.find((c) => c.toteId === "TS0000001111");
  assert.ok(candidate, "must survive - blank partitions for the same PID collapse to one active-PID line");
  assert.equal(candidate.inventoryCount, 3, "quantities for the same PID/tote are summed");
});

test("tote barcode threshold: total tote barcodes above toteBarcodeMax excludes the tote", () => {
  const rows = [row("1", "TS0000002222", 8, "PR1"), ...makeEligiblePidRows("1", 2, 3)]; // pid tote count now 3, but this tote's own qty=8 > default max 7
  const { pidAgg, toteAgg } = aggregateAsrsRows(rows);
  const { pre } = preFilterCandidates({ pidAgg, toteAgg }, {});
  assert.ok(!pre.some((c) => c.toteId === "TS0000002222"));
});

test("tote barcode threshold respects a custom toteBarcodeMax filter", () => {
  const rows = makeEligiblePidRows("1", 3, 5);
  const { pidAgg, toteAgg } = aggregateAsrsRows(rows);
  const { pre: preDefault } = preFilterCandidates({ pidAgg, toteAgg }, { toteBarcodeMax: 7 });
  assert.equal(preDefault.length, 3);
  const { pre: preStrict } = preFilterCandidates({ pidAgg, toteAgg }, { toteBarcodeMax: 4 });
  assert.equal(preStrict.length, 0, "qty=5 per tote exceeds a custom max of 4");
});

test("PID tote threshold: a PID present in fewer than pidToteMin totes is excluded entirely", () => {
  const rows = makeEligiblePidRows("1", 2, 3); // only 2 totes, default pidToteMin=3
  const { pidAgg, toteAgg } = aggregateAsrsRows(rows);
  const { pre } = preFilterCandidates({ pidAgg, toteAgg }, {});
  assert.equal(pre.length, 0);
});

test("PID tote threshold respects a custom pidToteMin filter", () => {
  const rows = makeEligiblePidRows("1", 2, 3);
  const { pidAgg, toteAgg } = aggregateAsrsRows(rows);
  const { pre } = preFilterCandidates({ pidAgg, toteAgg }, { pidToteMin: 2 });
  assert.equal(pre.length, 2);
});

test("preFilterCandidates returns the resolved filters actually applied (defaults filled in)", () => {
  const { resolvedFilters } = preFilterCandidates({ pidAgg: {}, toteAgg: {} }, { toteBarcodeMax: 9 });
  assert.equal(resolvedFilters.toteBarcodeMax, 9);
  assert.deepEqual(
    { partitionMax: resolvedFilters.partitionMax, pidInvMin: resolvedFilters.pidInvMin, pidToteMin: resolvedFilters.pidToteMin, blockedMode: resolvedFilters.blockedMode },
    { partitionMax: DEFAULT_FILTERS.partitionMax, pidInvMin: DEFAULT_FILTERS.pidInvMin, pidToteMin: DEFAULT_FILTERS.pidToteMin, blockedMode: DEFAULT_FILTERS.blockedMode }
  );
});

// ── classifyByBlocked ──────────────────────────────────────────────────────

function makeCandidate(overrides) {
  return { toteId: "TS0000000001", toteType: "Small", pid: "1", partition: "PR1", inventoryCount: 3, toteBarcodes: 3, totalPidInventory: 200, totalPidTotes: 3, ...overrides };
}

test("blocked classification: blockedInventory > 0 with totalPidInventory > pidInvMin and a healthy safety margin is kept as BLOCKED", () => {
  const c = makeCandidate({ totalPidInventory: 200 });
  const { kept, apiSkipped } = classifyByBlocked([c], { 1: { ok: true, blockedInventory: 50, totalInventory: 200, availableInventory: 999 } }, {});
  assert.equal(apiSkipped.length, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].purgeType, "BLOCKED");
  assert.equal(kept[0].blockedInventory, 50);
  assert.equal(kept[0].purgeAvailableInventory, 150, "totalPidInventory(200) - blockedInventory(50), NOT NexS's raw availableInventory(999)");
});

test("non-blocked classification: blockedInventory === 0 is kept as NON_BLOCKED with no PID-inventory floor", () => {
  const c = makeCandidate({ totalPidInventory: 1 }); // below pidInvMin, but that floor only applies to the BLOCKED path
  const { kept } = classifyByBlocked([c], { 1: { ok: true, blockedInventory: 0, totalInventory: 1, availableInventory: 1 } }, {});
  assert.equal(kept.length, 1);
  assert.equal(kept[0].purgeType, "NON_BLOCKED");
});

test("blocked-inventory PID-total threshold: BLOCKED path excludes a candidate whose totalPidInventory <= pidInvMin", () => {
  const c = makeCandidate({ totalPidInventory: 100 }); // default pidInvMin=100, must be STRICTLY greater than
  const { kept } = classifyByBlocked([c], { 1: { ok: true, blockedInventory: 10, totalInventory: 100, availableInventory: 90 } }, {});
  assert.equal(kept.length, 0);
});

test("safety floor: purgeAvailableInventory <= 5 excludes an otherwise-eligible BLOCKED candidate", () => {
  const c = makeCandidate({ totalPidInventory: 106 });
  const { kept } = classifyByBlocked([c], { 1: { ok: true, blockedInventory: 101, totalInventory: 106, availableInventory: 5 } }, {}); // 106-101=5, not > 5
  assert.equal(kept.length, 0, `PURGE_SAFETY_FLOOR is ${PURGE_SAFETY_FLOOR} - exactly 5 must be excluded`);
});

test("safety floor: purgeAvailableInventory === 6 (just above the floor) survives", () => {
  const c = makeCandidate({ totalPidInventory: 107 });
  const { kept } = classifyByBlocked([c], { 1: { ok: true, blockedInventory: 101, totalInventory: 107, availableInventory: 6 } }, {});
  assert.equal(kept.length, 1);
  assert.equal(kept[0].purgeAvailableInventory, 6);
});

test("blockedMode=blocked keeps only blocked candidates", () => {
  const blocked = makeCandidate({ pid: "1", totalPidInventory: 200 });
  const nonBlocked = makeCandidate({ pid: "2", totalPidInventory: 200 });
  const blockedMap = {
    1: { ok: true, blockedInventory: 50, totalInventory: 200, availableInventory: 150 },
    2: { ok: true, blockedInventory: 0, totalInventory: 200, availableInventory: 200 },
  };
  const { kept } = classifyByBlocked([blocked, nonBlocked], blockedMap, { blockedMode: "blocked" });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].pid, "1");
});

test("blockedMode=non_blocked keeps only non-blocked (0) candidates", () => {
  const blocked = makeCandidate({ pid: "1", totalPidInventory: 200 });
  const nonBlocked = makeCandidate({ pid: "2", totalPidInventory: 200 });
  const blockedMap = {
    1: { ok: true, blockedInventory: 50, totalInventory: 200, availableInventory: 150 },
    2: { ok: true, blockedInventory: 0, totalInventory: 200, availableInventory: 200 },
  };
  const { kept } = classifyByBlocked([blocked, nonBlocked], blockedMap, { blockedMode: "non_blocked" });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].pid, "2");
});

test("blockedMode=both (default) keeps both", () => {
  const blocked = makeCandidate({ pid: "1", totalPidInventory: 200 });
  const nonBlocked = makeCandidate({ pid: "2", totalPidInventory: 200 });
  const blockedMap = {
    1: { ok: true, blockedInventory: 50, totalInventory: 200, availableInventory: 150 },
    2: { ok: true, blockedInventory: 0, totalInventory: 200, availableInventory: 200 },
  };
  const { kept } = classifyByBlocked([blocked, nonBlocked], blockedMap, {});
  assert.equal(kept.length, 2);
});

test("apiSkipped: a PID whose blocked-inventory lookup failed excludes its candidates and is never treated as non-blocked", () => {
  const c = makeCandidate({ pid: "1" });
  const { kept, apiSkipped } = classifyByBlocked([c], { 1: { ok: false, reason: "NexS unreachable" } }, {});
  assert.equal(kept.length, 0, "must never silently continue as validated/non-blocked");
  assert.equal(apiSkipped.length, 1);
  assert.equal(apiSkipped[0].pid, "1");
  assert.equal(apiSkipped[0].reason, "NexS unreachable");
});

test("apiSkipped: a PID entirely absent from blockedMap (never attempted) is also skipped, not silently kept", () => {
  const c = makeCandidate({ pid: "1" });
  const { kept, apiSkipped } = classifyByBlocked([c], {}, {});
  assert.equal(kept.length, 0);
  assert.equal(apiSkipped.length, 1);
});
