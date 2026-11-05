// Pure report-assembly stage of the Tote Purge engine - ported faithfully
// from background/index.js's runPurgeGenerate() steps 6-7 (mismatch
// reasons, summary, PID breakdown). No I/O, no network.

function purgeRecommendation(status) {
  return status === "MISSING_IN_QUADRON"
    ? "Do not purge — verify physical presence"
    : status === "INVENTORY_MISMATCH"
    ? "Recount before purge"
    : status === "PARTITION_MISMATCH"
    ? "Verify partition mapping"
    : status === "EXCEEDS_PURGE_LIMIT"
    ? "Exclude — Quadron qty exceeds purge limit"
    : status === "VALIDATION_UNAVAILABLE"
    ? "Re-run once Quadron is reachable"
    : "Review";
}

// buildMismatches(kept) -> candidates whose validationStatus isn't VALIDATED,
// each carrying candidate identity, mismatch type, and a recommended action.
function buildMismatches(kept) {
  return kept
    .filter((c) => c.validationStatus !== "VALIDATED")
    .map((c) => ({
      toteId: c.toteId,
      pid: c.pid,
      issueType: c.validationStatus,
      asrsValue: `qty ${c.inventoryCount} / ${c.partition || "—"}`,
      quadronValue: c.quadronQty == null ? "—" : `qty ${c.quadronQty} / ${c.quadronPartition == null ? "—" : "PR" + c.quadronPartition}`,
      recommendedAction: purgeRecommendation(c.validationStatus),
    }));
}

function emptySummary() {
  return {
    totalTotes: 0,
    distinctTotes: 0,
    candidateLines: 0,
    largeTotes: 0,
    smallTotes: 0,
    totalInventory: 0,
    blockedCount: 0,
    nonBlockedCount: 0,
    uniquePids: 0,
    validatedCount: 0,
    mismatchCount: 0,
    blockedApiFails: 0,
    apiSkippedLines: 0,
    apiSkippedTotes: 0,
    apiFailReasons: [],
    quadronAvailable: false,
    quadronReason: null,
  };
}

// buildSummary(kept, mismatches, apiSkipped, quadronOk) -> summary object
// with reconciliation counts (blocked+non-blocked should equal
// candidateLines; validated+mismatches should too - the UI surfaces these
// as a visible integrity check, same as legacy).
// topFailReasons(apiSkipped, n) -> [{ reason, pids }] by distinct-PID count desc
function topFailReasons(apiSkipped, n = 3) {
  const byReason = new Map();
  for (const s of apiSkipped) {
    const r = String(s.reason || "blocked API failed").replace(/\d{4,}/g, "#").slice(0, 160);
    if (!byReason.has(r)) byReason.set(r, new Set());
    byReason.get(r).add(s.pid);
  }
  return [...byReason].map(([reason, pids]) => ({ reason, pids: pids.size })).sort((a, b) => b.pids - a.pids).slice(0, n);
}

function buildSummary(kept, mismatches, apiSkipped, quadronOk, quadronReason = null) {
  const distinctToteSet = new Set(kept.map((c) => c.toteId));
  const apiSkippedTotes = new Set(apiSkipped.map((s) => s.toteId)).size;
  return {
    totalTotes: kept.length,
    distinctTotes: distinctToteSet.size,
    candidateLines: kept.length,
    largeTotes: new Set(kept.filter((c) => c.toteType === "Large").map((c) => c.toteId)).size,
    smallTotes: new Set(kept.filter((c) => c.toteType === "Small").map((c) => c.toteId)).size,
    totalInventory: kept.reduce((s, c) => s + c.inventoryCount, 0),
    blockedCount: kept.filter((c) => c.purgeType === "BLOCKED").length,
    nonBlockedCount: kept.filter((c) => c.purgeType === "NON_BLOCKED").length,
    uniquePids: new Set(kept.map((c) => c.pid)).size,
    validatedCount: kept.filter((c) => c.quadronValidated).length,
    mismatchCount: mismatches.length,
    blockedApiFails: new Set(apiSkipped.map((s) => s.pid)).size,
    apiSkippedLines: apiSkipped.length,
    apiSkippedTotes,
    apiFailReasons: topFailReasons(apiSkipped),
    quadronAvailable: !!quadronOk,
    quadronReason: quadronOk ? null : quadronReason,
  };
}

// buildPidBreakdown(kept) -> per-PID rollup, sorted by totes-selected desc
// (matches legacy's own default sort).
function buildPidBreakdown(kept) {
  const byPid = Object.create(null);
  for (const c of kept) {
    if (!byPid[c.pid]) {
      byPid[c.pid] = {
        pid: c.pid,
        totesSelected: 0,
        inventorySelected: 0,
        blockedInventory: c.blockedInventory || 0,
        totalPidInventory: c.totalPidInventory,
        purgeAvailableInventory: c.purgeAvailableInventory != null ? c.purgeAvailableInventory : c.totalPidInventory - (c.blockedInventory || 0),
      };
    }
    byPid[c.pid].totesSelected++;
    byPid[c.pid].inventorySelected += c.inventoryCount;
  }
  return Object.values(byPid).sort((a, b) => b.totesSelected - a.totesSelected);
}

module.exports = { purgeRecommendation, buildMismatches, emptySummary, buildSummary, buildPidBreakdown };
