// Pure classification algorithm - no I/O, no capability calls, no DB. Given
// already-fetched results from the three Classification source
// capabilities (GET_GRAFANA_LOCKED_TOTES, GET_GRAFANA_SUPERVISOR_DUMP,
// GET_QUADRON_INVENTORY), assigns SD/P0/P1/P2 priority to every locked
// tote. Ported verbatim (algorithm, not code shape) from
// buildPIDMapFromInventory() in background/index.js:754 - the existing
// extension's "live Quadron API" classification path, which is the one
// this web app's architecture uses (no Google Sheet / Apps Script "ASRS
// Dump" source exists here).
//
// This is the ONE place SD/P0/P1/P2 gets decided. Auto Mode (a later,
// separate phase) must call this function rather than re-deriving
// priority itself - see the Classification design's explicit "do not
// duplicate the classification algorithm inside Auto" requirement.

const DEFAULT_P0_MAX_TOTES = 1;
const DEFAULT_P1_MAX_TOTES = 3;

// "TS0000018492-6" -> "TS0000018492". Mirrors invBaseOf() in
// background/index.js:717 and splitPartitionedToteId() in
// runtime/background/capabilities.js - a tote id may appear with a
// partition suffix in inventory rows, never in Locked/Supervisor Dump rows.
function baseToteId(id) {
  return String(id || "").trim().toUpperCase().replace(/-\d+\s*$/, "");
}

// classifyLockedTotes({
//   lockedRows:      [{toteId, tracker, location, zone, shuttle}]   from GET_GRAFANA_LOCKED_TOTES
//   supervisorRows:  [{toteId}]                                      from GET_GRAFANA_SUPERVISOR_DUMP (may be null/omitted - degraded mode)
//   inventoryRows:   [{toteId, quadronQty, partitions:[{part,qty,sku}]}]  from GET_QUADRON_INVENTORY (may be null/omitted - degraded mode)
//   p0MaxTotes, p1MaxTotes
// }) -> { totes: [ClassifiedTote], summary: {...} }
// ClassifiedTote now also carries totalToteInv (the tote's real, already-
// aggregated Quadron quantity, or null if unavailable - see the toteInvMap
// comment below). worstPid/scarcityCount are still computed (the Reason
// text is allowed to reference PID scarcity) but worstPid is no longer
// meant to be rendered as its own UI column - see webapp/public/js/classification.js.
function classifyLockedTotes({ lockedRows, supervisorRows, inventoryRows, p0MaxTotes, p1MaxTotes } = {}) {
  const p0Max = Number(p0MaxTotes) || DEFAULT_P0_MAX_TOTES;
  const p1Max = Number(p1MaxTotes) || DEFAULT_P1_MAX_TOTES;

  const locked = Array.isArray(lockedRows) ? lockedRows : [];
  const supervisor = Array.isArray(supervisorRows) ? supervisorRows : [];
  const inventory = Array.isArray(inventoryRows) ? inventoryRows : [];

  // Locked Dump is the base universe - dedupe by base tote id, keep the
  // first occurrence's zone/location/tracker/shuttle.
  const lockedByBase = new Map();
  for (const row of locked) {
    const base = baseToteId(row && row.toteId);
    if (!base || lockedByBase.has(base)) continue;
    lockedByBase.set(base, row);
  }

  // Supervisor cross-reference: only a tote present in BOTH Supervisor Dump
  // AND Locked Dump qualifies as SD (background/index.js:453-454's
  // "Cross-reference supervisor totes against locked tote dump" comment).
  const supervisorRawCount = supervisor.length;
  const sdSet = new Set();
  for (const row of supervisor) {
    const base = baseToteId(row && row.toteId);
    if (base && lockedByBase.has(base)) sdSet.add(base);
  }

  // SKU scarcity map: sku -> set of base tote ids holding it, facility-wide.
  // toteInvMap: base tote id -> quadronQty (the real, already-aggregated
  // total inventory quantity Quadron reports for that tote - see
  // runtime/background/capabilities.js's executeGetQuadronInventory(),
  // which sums materialDetails[].quantity across every raw partition row
  // for a base tote into exactly this field. Not re-derived or estimated
  // here - read straight through from the capability's own normalized
  // result, which server/integrations/quadron/quadronInventory.js already
  // validates is a number or null before this function ever sees it.
  const skuMap = new Map();
  const toteSkus = new Map(); // base tote id -> Set(sku) - only for locked totes
  const toteInvMap = new Map(); // base tote id -> quadronQty (number) - for every inventory entry, not only locked totes
  for (const entry of inventory) {
    const base = baseToteId(entry && entry.toteId);
    if (!base) continue;
    if (typeof entry.quadronQty === "number") toteInvMap.set(base, entry.quadronQty);
    const partitions = Array.isArray(entry.partitions) ? entry.partitions : [];
    for (const part of partitions) {
      const sku = part && part.sku != null ? String(part.sku).trim() : "";
      if (!sku) continue;
      if (!skuMap.has(sku)) skuMap.set(sku, new Set());
      skuMap.get(sku).add(base);
      if (lockedByBase.has(base)) {
        if (!toteSkus.has(base)) toteSkus.set(base, new Set());
        toteSkus.get(base).add(sku);
      }
    }
  }

  const totes = [];
  const summary = { total: 0, sdCount: 0, p0Count: 0, p1Count: 0, p2Count: 0, lockedCount: lockedByBase.size, supervisorRawCount, supervisorIntersectedCount: sdSet.size };

  for (const [base, row] of lockedByBase) {
    // Total Tote Inv: the real Quadron quantity if this tote appears in the
    // inventory result at all, otherwise explicitly null (never fabricated,
    // never defaulted to 0) - "unavailable" and "confirmed zero" are
    // different facts and must not be conflated.
    const totalToteInv = toteInvMap.has(base) ? toteInvMap.get(base) : null;
    const passthrough = { toteId: base, zone: row.zone ?? null, location: row.location ?? null, tracker: row.tracker ?? null, shuttle: row.shuttle ?? null, totalToteInv };

    if (sdSet.has(base)) {
      totes.push({ ...passthrough, priority: "SD", worstPid: null, scarcityCount: null, reason: "Supervisor Dump cross-reference", source: "Supervisor Dump" });
      summary.sdCount++;
      summary.total++;
      continue;
    }

    const skus = toteSkus.get(base);
    if (!skus || !skus.size) {
      totes.push({ ...passthrough, priority: "P2", worstPid: null, scarcityCount: null, reason: "Not in ASRS — defaulting to P2", source: "Locked Tote Dump" });
      summary.p2Count++;
      summary.total++;
      continue;
    }

    let worstCount = Infinity;
    let worstSku = "";
    for (const sku of skus) {
      const count = skuMap.get(sku) ? skuMap.get(sku).size : 0;
      if (count < worstCount) {
        worstCount = count;
        worstSku = sku;
      }
    }

    const priority = worstCount <= p0Max ? "P0" : worstCount <= p1Max ? "P1" : "P2";
    const reason = skus.size === 1
      ? `PID ${worstSku} has ${worstCount} tote(s) in ASRS`
      : `${skus.size} PIDs — worst: PID ${worstSku} → ${worstCount} tote(s)`;

    totes.push({ ...passthrough, priority, worstPid: worstSku, scarcityCount: worstCount, reason, source: "Quadron API" });
    if (priority === "P0") summary.p0Count++;
    else if (priority === "P1") summary.p1Count++;
    else summary.p2Count++;
    summary.total++;
  }

  return { totes, summary };
}

module.exports = { classifyLockedTotes, baseToteId, DEFAULT_P0_MAX_TOTES, DEFAULT_P1_MAX_TOTES };
