// Pure aggregation step of the Tote Purge engine - ported faithfully from
// background/index.js's runPurgeGenerate() steps 1-2 (aggregate per PID and
// per tote). No I/O, no network, no capability calls - takes the ASRS Dump
// rows already fetched by the canonical nexsAsrsDumpEngine snapshot and
// produces the two lookup structures every later purge stage needs.
//
// Reuses the SAME tote-id validation/normalization every other module in
// this codebase already uses (server/features/tote-utilisation/toteUtilisation.js's
// isValidToteId/invBaseOf, themselves ported verbatim from the legacy
// extension) - no third copy of this logic.

const { isValidToteId, invBaseOf } = require("../../tote-utilisation/toteUtilisation");

// aggregateAsrsRows(rows) -> { pidAgg, toteAgg }
//   pidAgg[pid]  = { totes: Set<toteId>, totalInventory: number }
//   toteAgg[tote] = { rows: [{pid, partition, inv}], pids: Set<pid> }
//
// Ignores rows with a missing pid or an invalid (non TL/TS+10-digit) tote
// id - exactly the same skip condition as the legacy engine
// (`if(!pid||!isValidToteId(tote)) continue;`), never silently coerced into
// something else.
function aggregateAsrsRows(rows) {
  const pidAgg = Object.create(null);
  const toteAgg = Object.create(null);

  for (const r of rows || []) {
    const pid = String((r && r.pid) || "").trim();
    const tote = invBaseOf(r && r.toteId);
    const inv = Number(r && r.barcodeCount) || 0;
    if (!pid || !isValidToteId(tote)) continue;

    if (!pidAgg[pid]) pidAgg[pid] = { totes: new Set(), totalInventory: 0 };
    pidAgg[pid].totes.add(tote);
    pidAgg[pid].totalInventory += inv;

    if (!toteAgg[tote]) toteAgg[tote] = { rows: [], pids: new Set() };
    toteAgg[tote].rows.push({ pid, partition: r && r.partition, inv });
    toteAgg[tote].pids.add(pid);
  }

  return { pidAgg, toteAgg };
}

module.exports = { aggregateAsrsRows };
