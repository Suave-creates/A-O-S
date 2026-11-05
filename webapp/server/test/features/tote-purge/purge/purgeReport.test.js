// Unit tests for server/features/tote-purge/purge/purgeReport.js - pure, no I/O, no network
// anywhere in this file.

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMismatches, buildSummary, buildPidBreakdown, emptySummary, purgeRecommendation } = require("../../../../features/tote-purge/purge/purgeReport");

function validated(overrides) {
  return { toteId: "TS0000000001", pid: "1", toteType: "Small", inventoryCount: 3, purgeType: "BLOCKED", quadronValidated: true, validationStatus: "VALIDATED", quadronQty: 3, quadronPartition: 1, partition: "PR1", blockedInventory: 10, totalPidInventory: 200, purgeAvailableInventory: 190, ...overrides };
}

test("emptySummary has all-zero counts and quadronAvailable false", () => {
  const s = emptySummary();
  assert.equal(s.totalTotes, 0);
  assert.equal(s.quadronAvailable, false);
});

test("buildSummary reconciliation: blockedCount + nonBlockedCount === candidateLines, validatedCount + mismatchCount === candidateLines", () => {
  const kept = [validated({ pid: "1", purgeType: "BLOCKED" }), validated({ pid: "2", purgeType: "NON_BLOCKED", quadronValidated: false, validationStatus: "MISSING_IN_QUADRON" })];
  const mismatches = buildMismatches(kept);
  const s = buildSummary(kept, mismatches, [], true);
  assert.equal(s.candidateLines, 2);
  assert.equal(s.blockedCount + s.nonBlockedCount, s.candidateLines);
  assert.equal(s.validatedCount + s.mismatchCount, s.candidateLines);
  assert.equal(s.mismatchCount, 1);
  assert.equal(s.validatedCount, 1);
});

test("buildSummary counts distinct totes, not candidate lines, for totalTotes/distinctTotes/largeTotes/smallTotes", () => {
  const kept = [
    validated({ toteId: "TS0000000001", pid: "1" }),
    validated({ toteId: "TS0000000001", pid: "2" }), // same tote, different PID - one distinct tote, two candidate lines
    validated({ toteId: "TL0000000002", pid: "3", toteType: "Large" }),
  ];
  const s = buildSummary(kept, [], [], true);
  assert.equal(s.candidateLines, 3);
  assert.equal(s.distinctTotes, 2);
  assert.equal(s.largeTotes, 1);
  assert.equal(s.smallTotes, 1);
});

test("buildSummary: quadronAvailable reflects the flag passed in, not inferred from candidates", () => {
  assert.equal(buildSummary([], [], [], true).quadronAvailable, true);
  assert.equal(buildSummary([], [], [], false).quadronAvailable, false);
  assert.equal(buildSummary([], [], [], false, "timeout").quadronReason, "timeout");
  assert.equal(buildSummary([], [], [], true, "ignored").quadronReason, null);
});

test("buildSummary: apiSkipped counts are surfaced distinctly (lines vs. distinct totes vs. distinct PIDs)", () => {
  const apiSkipped = [
    { toteId: "TS0000000001", pid: "1" },
    { toteId: "TS0000000001", pid: "2" }, // same tote, different PID
    { toteId: "TS0000000002", pid: "1" }, // same PID, different tote
  ];
  const s = buildSummary([], [], apiSkipped, true);
  assert.equal(s.apiSkippedLines, 3);
  assert.equal(s.apiSkippedTotes, 2);
  assert.equal(s.blockedApiFails, 2, "distinct PIDs that failed the blocked-inventory lookup");
});

test("buildMismatches only includes non-VALIDATED candidates, with the right recommendation per issue type", () => {
  const kept = [
    validated({ pid: "1", validationStatus: "VALIDATED", quadronValidated: true }),
    validated({ pid: "2", validationStatus: "MISSING_IN_QUADRON", quadronValidated: false }),
    validated({ pid: "3", validationStatus: "INVENTORY_MISMATCH", quadronValidated: false }),
  ];
  const mismatches = buildMismatches(kept);
  assert.equal(mismatches.length, 2);
  assert.equal(mismatches.find((m) => m.pid === "2").recommendedAction, purgeRecommendation("MISSING_IN_QUADRON"));
  assert.equal(mismatches.find((m) => m.pid === "3").recommendedAction, purgeRecommendation("INVENTORY_MISMATCH"));
});

test("purgeRecommendation covers every known validation status with a distinct, non-generic message", () => {
  const statuses = ["MISSING_IN_QUADRON", "INVENTORY_MISMATCH", "PARTITION_MISMATCH", "EXCEEDS_PURGE_LIMIT", "VALIDATION_UNAVAILABLE"];
  const recs = statuses.map(purgeRecommendation);
  assert.equal(new Set(recs).size, recs.length, "every known status should get its own distinct recommendation");
  assert.equal(purgeRecommendation("SOMETHING_UNKNOWN"), "Review");
});

test("buildPidBreakdown rolls up totesSelected/inventorySelected per PID and sorts by totesSelected desc", () => {
  const kept = [
    validated({ pid: "1", toteId: "TS0000000001", inventoryCount: 2 }),
    validated({ pid: "1", toteId: "TS0000000002", inventoryCount: 3 }),
    validated({ pid: "1", toteId: "TS0000000003", inventoryCount: 1 }),
    validated({ pid: "2", toteId: "TS0000000004", inventoryCount: 5 }),
  ];
  const breakdown = buildPidBreakdown(kept);
  assert.equal(breakdown[0].pid, "1");
  assert.equal(breakdown[0].totesSelected, 3);
  assert.equal(breakdown[0].inventorySelected, 6);
  assert.equal(breakdown[1].pid, "2");
  assert.equal(breakdown[1].totesSelected, 1);
});
