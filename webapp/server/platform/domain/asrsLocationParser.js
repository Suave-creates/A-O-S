// Reusable tote id / partition extraction from an ASRS Dump "location"
// string (e.g. "NXS1-ASRS-TS0000009125_PR1"). Ported (regex logic, not
// code shape) from apps-script/Code.gs's parseToteFromLocation()/
// extractPartition() - the same pattern the existing extension already
// uses to pull a tote id out of a longer location string. Kept as ONE
// reusable data-layer utility (per explicit instruction) so downstream
// consumers (NEXS ASRS Dump UI, Tote Purge, Tote Utilisation) never each
// implement their own location parsing.
//
// Pure, dependency-free. Never mutates or reinterprets the source value
// itself - this only ever reads out of it; the original `location` string
// is preserved unchanged by the caller (see googleSheetAsrsDumpProvider.js).

const TOTE_MATCH = /(T[LS])([0-9]{10})/;
const PARTITION_MATCH = /_PR([0-9]+)/i;

// parseLocation(rawLocation) -> { toteId: "TS0000009125"|null, partition: "PR1"|null }
// Returns nulls (never throws) for a location string that doesn't contain a
// recognizable tote id - that is a legitimate, expected outcome for some
// rows (e.g. non-ASRS locations), not a parse error.
function parseLocation(rawLocation) {
  const s = String(rawLocation == null ? "" : rawLocation).trim().toUpperCase();
  if (!s) return { toteId: null, partition: null };

  const toteMatch = s.match(TOTE_MATCH);
  const toteId = toteMatch ? toteMatch[1] + toteMatch[2] : null;

  const partMatch = s.match(PARTITION_MATCH);
  const partition = partMatch ? "PR" + partMatch[1] : null;

  return { toteId, partition };
}

module.exports = { parseLocation };
