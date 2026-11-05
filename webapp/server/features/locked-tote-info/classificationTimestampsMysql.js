// MySQL-backed adapter for "Locked Since" persistence. This file's own
// code/behavior is UNCHANGED by the Local-First Phase 1 selector split -
// server/features/locked-tote-info/classificationTimestamps.js is now a thin selector between
// this file and classificationTimestampsMemory.js, mirroring
// server/platform/queries/queryManager.js's own mysql/memory split exactly.
//
// touchMany() writes with a single atomic UPSERT per batch: on conflict
// (tote_id already exists), ONLY last_seen_at is written. first_seen_at
// and discrepancy_marked_at are not present anywhere in the UPDATE clause,
// so they cannot be overwritten by a repeat observation - this is
// guaranteed by the shape of the SQL statement itself, not by a JS
// branch that has to be correct. This replaces an earlier
// SELECT-existing-rows-then-branch-INSERT/UPDATE approach, which had a
// real (if narrow) read/write race window between checking whether a
// tote_id already existed and acting on that check - two overlapping
// touchMany() calls for the same tote could both see "not yet present"
// and both attempt to treat it as a first observation. The atomic upsert
// removes that window entirely: MySQL decides insert-vs-update and
// applies it in one indivisible per-row operation.
//
// The read that follows the write is a separate, later SELECT - by
// construction it can only ever see the already-committed result of the
// write it's reporting on, so it carries no race of its own.

const db = require("../../platform/db");
const lockedSinceTracker = require("./lockedSinceTracker");

// touchMany(toteIds, seenAtIso) -> Promise<Map<toteId, lockedSinceIso>>
// Called once per Classification refresh with every currently-locked base
// tote id.
async function touchMany(toteIds, seenAtIso) {
  if (!toteIds.length) return new Map();

  const valuePlaceholders = toteIds.map(() => "(?, ?, ?)").join(",");
  const insertParams = toteIds.flatMap((id) => [id, seenAtIso, seenAtIso]);
  await db.execute(
    `INSERT INTO classification_tote_state (tote_id, first_seen_at, last_seen_at)
     VALUES ${valuePlaceholders}
     ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at)`,
    insertParams
  );

  const selectPlaceholders = toteIds.map(() => "?").join(",");
  const rows = await db.query(
    `SELECT tote_id, first_seen_at, discrepancy_marked_at FROM classification_tote_state WHERE tote_id IN (${selectPlaceholders})`,
    toteIds
  );

  const result = new Map();
  for (const row of rows) {
    result.set(row.tote_id, lockedSinceTracker.lockedSinceOf({ firstSeenAt: row.first_seen_at, discrepancyMarkedAt: row.discrepancy_marked_at }));
  }
  return result;
}

// getMany(toteIds) -> Promise<Map<toteId, lockedSinceIso>> - pure, read-only
// lookup (SELECT only, no INSERT/UPDATE). Added for Auto Preview/Dry-Run
// (server/features/tote-puller/autoPreview.js), which needs to show Locked Since informationally
// without ever writing to classification_tote_state - Auto's own architecture
// never touches this table otherwise. Totes not yet observed by any
// Classification refresh simply have no entry in the returned Map.
async function getMany(toteIds) {
  if (!toteIds.length) return new Map();
  const placeholders = toteIds.map(() => "?").join(",");
  const rows = await db.query(
    `SELECT tote_id, first_seen_at, discrepancy_marked_at FROM classification_tote_state WHERE tote_id IN (${placeholders})`,
    toteIds
  );
  const result = new Map();
  for (const row of rows) {
    result.set(row.tote_id, lockedSinceTracker.lockedSinceOf({ firstSeenAt: row.first_seen_at, discrepancyMarkedAt: row.discrepancy_marked_at }));
  }
  return result;
}

// observeMany(observations, seenAtIso) -> Promise<Map<toteId, lockedSinceIso>> - the lock-episode rules of
// lockedSinceTracker.observeTote() (SKU change restarts a lock, a SHORT report dates it). Reads the current rows,
// applies the pure rules, then writes every row back with one upsert per chunk. Refreshes are effectively
// single-flight, so the read-then-write window the comment above warns about does not arise in practice.
async function observeMany(observations, seenAtIso, previousRefreshAt = null) {
  if (!observations.length) return new Map();
  const ids = observations.map((o) => o.toteId);
  const store = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await db.query(
      `SELECT tote_id, first_seen_at, last_seen_at, discrepancy_marked_at, sku_sig FROM classification_tote_state WHERE tote_id IN (${chunk.map(() => "?").join(",")})`,
      chunk
    );
    for (const r of rows) {
      let skus = null;
      try { skus = r.sku_sig ? JSON.parse(r.sku_sig) : null; } catch (e) { skus = null; }
      store.set(r.tote_id, { firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, discrepancyMarkedAt: r.discrepancy_marked_at, skus });
    }
  }
  const result = lockedSinceTracker.observeMany(store, observations, seenAtIso, previousRefreshAt);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const params = chunk.flatMap((id) => { const e = store.get(id); return [id, e.firstSeenAt, e.lastSeenAt, e.discrepancyMarkedAt, e.skus ? JSON.stringify(e.skus) : null]; });
    await db.execute(
      `INSERT INTO classification_tote_state (tote_id, first_seen_at, last_seen_at, discrepancy_marked_at, sku_sig)
       VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(",")}
       ON DUPLICATE KEY UPDATE first_seen_at = VALUES(first_seen_at), last_seen_at = VALUES(last_seen_at),
         discrepancy_marked_at = VALUES(discrepancy_marked_at), sku_sig = VALUES(sku_sig)`,
      params
    );
  }
  return result;
}

module.exports = { touchMany, getMany, observeMany };
