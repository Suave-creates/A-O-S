// Pure pre-filter + blocked-classification stages of the Tote Purge engine -
// ported faithfully from background/index.js's runPurgeGenerate() steps
// 3-5. No I/O, no network, no capability calls - blockedMap is passed in
// already-fetched (see server/features/tote-purge/purgeEngine.js for the orchestration that
// fetches it via nexsBlockedInventoryProvider).

// Defaults match the legacy extension's own hardcoded constants exactly.
const DEFAULT_FILTERS = {
  toteBarcodeMax: 7, // Total Tote Barcode (<=)
  partitionMax: 1, // Tote Partition / active-PID limit (<=)
  pidInvMin: 100, // Total PID Inv (>) - BLOCKED path only
  pidToteMin: 3, // Total PID Tote (>=)
  blockedMode: "both", // "both" | "blocked" | "non_blocked"
};
const PURGE_TOTE_MIN = 1; // tote inventory window lower bound (inclusive)
const PURGE_SAFETY_FLOOR = 5; // exclude PID when purgeAvailableInventory <= this

function numOr(v, d) {
  return v === undefined || v === null || v === "" || isNaN(Number(v)) ? d : Number(v);
}

function resolveFilters(filters) {
  return {
    toteBarcodeMax: numOr(filters && filters.toteBarcodeMax, DEFAULT_FILTERS.toteBarcodeMax),
    partitionMax: numOr(filters && filters.partitionMax, DEFAULT_FILTERS.partitionMax),
    pidInvMin: numOr(filters && filters.pidInvMin, DEFAULT_FILTERS.pidInvMin),
    pidToteMin: numOr(filters && filters.pidToteMin, DEFAULT_FILTERS.pidToteMin),
    blockedMode: (filters && filters.blockedMode) || DEFAULT_FILTERS.blockedMode,
  };
}

// preFilterCandidates({pidAgg, toteAgg}, filters) -> { pre: [...], resolvedFilters }
//
// "Active partitions" = DISTINCT PIDs in the tote, NOT the raw `partition`
// field - preserved deliberately: the ASRS dump's partition field is often
// blank, so counting it directly would collapse every line to one key and
// let multi-partition totes slip through. Each PID occupies its own
// partition (confirmed by Quadron's per-PID PR), so distinct-PID count is
// the reliable measure - collapsing by PID also guarantees a tote can never
// appear twice for the same PID.
function preFilterCandidates({ pidAgg, toteAgg }, filters) {
  const F = resolveFilters(filters);
  const pre = [];

  for (const tote in toteAgg) {
    const t = toteAgg[tote];
    const byPid = Object.create(null);
    for (const row of t.rows) {
      if (!byPid[row.pid]) byPid[row.pid] = { pid: row.pid, partition: row.partition || "", inv: 0 };
      byPid[row.pid].inv += row.inv;
      if (!byPid[row.pid].partition && row.partition) byPid[row.pid].partition = row.partition;
    }
    const pidLines = Object.values(byPid);
    if (pidLines.length > F.partitionMax) continue; // Tote Partition: active partitions (distinct PIDs) <= N

    // Total Tote Barcode is the tote's combined barcode count across all its
    // PIDs/partitions - not a single PID-line. (At 1 partition these are equal.)
    const toteBarcodes = pidLines.reduce((s, l) => s + l.inv, 0);
    if (toteBarcodes < PURGE_TOTE_MIN || toteBarcodes > F.toteBarcodeMax) continue; // Total Tote Barcode: 1..N (tote-level)

    for (const line of pidLines) {
      const agg = pidAgg[line.pid];
      const pidTotes = agg ? agg.totes.size : 0;
      if (pidTotes < F.pidToteMin) continue; // Total PID Tote: >= N
      if (!agg) continue;
      pre.push({
        toteId: tote,
        toteType: tote.startsWith("TL") ? "Large" : "Small",
        pid: line.pid,
        partition: line.partition,
        inventoryCount: line.inv,
        toteBarcodes,
        totalPidInventory: agg.totalInventory,
        totalPidTotes: pidTotes,
      });
    }
  }

  return { pre, resolvedFilters: F };
}

// classifyByBlocked(pre, blockedMap, filters) -> { kept, apiSkipped }
//
// blockedMap[pid] = { ok:true, nexsAvailableInventory, blockedInventory, totalInventory }
//                 | { ok:false, reason }  (a failed blocked-inventory lookup
//                   for that PID - excludes its candidates, never treats
//                   the PID as non-blocked, never silently continues as
//                   validated)
//
// purgeAvailableInventory is the LEGACY PURGE quantity - deliberately
// totalPidInventory (ASRS-dump-scoped) minus blockedInventory, NOT NexS's
// own raw availableInventory field (a different, NexS-internal figure - see
// server/integrations/nexs/nexsBlockedInventoryProvider.js's own note on this).
function classifyByBlocked(pre, blockedMap, filters) {
  const F = resolveFilters(filters);
  const kept = [];
  const apiSkipped = [];

  for (const c of pre) {
    const b = blockedMap[c.pid];
    if (!b || !b.ok) {
      apiSkipped.push({
        toteId: c.toteId,
        pid: c.pid,
        toteType: c.toteType,
        inventoryCount: c.inventoryCount,
        reason: (b && b.reason) || "blocked API failed",
      });
      continue;
    }

    c.blockedInventory = b.blockedInventory;
    c.nexsAvailableInventory = b.availableInventory; // NexS's own raw field - display/diagnostics only, never used for purge safety math
    c.purgeAvailableInventory = c.totalPidInventory - b.blockedInventory; // the LEGACY PURGE quantity

    const isBlocked = b.blockedInventory > 0;
    if (F.blockedMode === "blocked" && !isBlocked) continue; // keep only blocked
    if (F.blockedMode === "non_blocked" && isBlocked) continue; // keep only non-blocked (0)

    if (isBlocked) {
      if (c.totalPidInventory <= F.pidInvMin) continue; // Total PID Inv > N - BLOCKED path only
      if (c.purgeAvailableInventory <= PURGE_SAFETY_FLOOR) continue; // safety net: don't purge near-depleted PIDs
      c.purgeType = "BLOCKED";
    } else {
      c.purgeType = "NON_BLOCKED"; // no PID-inv floor for non-blocked
    }
    kept.push(c);
  }

  return { kept, apiSkipped };
}

module.exports = { DEFAULT_FILTERS, PURGE_TOTE_MIN, PURGE_SAFETY_FLOOR, resolveFilters, preFilterCandidates, classifyByBlocked };
