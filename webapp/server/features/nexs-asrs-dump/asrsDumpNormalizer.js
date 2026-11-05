// Shared ASRS Dump row normalization - used by BOTH concrete providers
// (googleSheetAsrsDumpProvider.js, the legacy Node-direct-fetch path, and
// runtimeAsrsDumpProvider.js, the production Runtime-capability path) so
// the normalization rules exist in exactly one place regardless of which
// transport actually fetched the raw rows.
//
// CONFIRMED LIVE CONTRACT (verified against the real production Apps
// Script deployment, 120,779-row live response): the source sends exactly
// four fields per row - { pid, toteId, partition, inventoryCount }. It does
// NOT send `location`, `last_updated_at`, or `ingested_at` - the 5-column
// shape once assumed here was never confirmed and is not what production
// actually returns. toteId/partition are therefore preserved directly from
// the source, never re-derived; `location` is DERIVED for display (see
// below); timestamps are left `null`, never fabricated, so a future source
// change that does add them would simply start flowing through unchanged.

const { parseLocation } = require("../../platform/domain/asrsLocationParser");

// NXS1-ASRS- is the fixed facility/aisle prefix the Google Sheet's own
// "location" column value always carried (confirmed from sample rows,
// e.g. "NXS1-ASRS-TS0000009125_PR1") - the live Apps Script contract just
// doesn't include that column, so this reconstructs the equivalent display
// string from the toteId/partition it DOES send, rather than fabricating
// unrelated data.
const LOCATION_PREFIX = "NXS1-ASRS-";

// Normalizes one raw row into the canonical ASRS Dump row.
function normalizeRow(raw) {
  raw = raw || {};

  const pid = raw.pid != null ? String(raw.pid) : null;

  // Preserved directly from the source (confirmed live contract). Falling
  // back to parsing a raw `location` string only covers a source shape
  // that is not what production currently sends - kept for robustness, not
  // because it's expected.
  let toteId = raw.toteId != null ? String(raw.toteId).trim().toUpperCase() : null;
  let partition = raw.partition != null && raw.partition !== "" ? String(raw.partition) : null;
  if (toteId == null && raw.location != null) {
    const parsed = parseLocation(raw.location);
    toteId = parsed.toteId;
    partition = parsed.partition;
  }

  // inventoryCount is the canonical barcode quantity per the confirmed live
  // contract; barcode_count is accepted too (a possible future field name)
  // but inventoryCount wins when both are present, since that's what the
  // live source actually sends today.
  const barcodeCount =
    raw.inventoryCount != null ? Number(raw.inventoryCount) : raw.barcode_count != null ? Number(raw.barcode_count) : null;

  // Display location is DERIVED, never sourced from the wire, since the
  // live contract carries no `location` field. Falls back to a raw
  // `location` value only in the (currently unconfirmed-in-production)
  // case where the source provides one directly instead of toteId/partition.
  const location =
    toteId != null ? `${LOCATION_PREFIX}${toteId}${partition ? "_" + partition : ""}` : raw.location != null ? String(raw.location) : null;

  // Not part of the confirmed live contract - left null rather than
  // fabricated. Passes through unchanged if a future source version adds
  // them.
  const lastUpdatedAt = raw.last_updated_at != null ? raw.last_updated_at : null;
  const ingestedAt = raw.ingested_at != null ? raw.ingested_at : null;

  return { pid, location, barcodeCount, lastUpdatedAt, ingestedAt, toteId, partition };
}

// Lexicographic max is correct here without parsing: both the documented
// "YYYY-MM-DD HH:mm:ss" source format and ISO-8601 sort identically to
// their chronological order as plain strings. Returns the ORIGINAL string
// unchanged (never reformatted) - null if no row has a value.
function latestOf(rows, field) {
  let latest = null;
  for (const row of rows) {
    const v = row[field];
    if (v == null) continue;
    if (latest == null || String(v) > String(latest)) latest = v;
  }
  return latest;
}

module.exports = { normalizeRow, latestOf };
