// MySQL-backed persistence for the NEXS ASRS Tote Dump - the approved
// two-table generation-swap design (see server/platform/db/migrations/0005_nexs_asrs_dump.sql).
// Mirrors the existing repository conventions exactly (server/platform/queries/queryManagerMysql.js,
// server/features/locked-tote-info/classificationTimestampsMysql.js): only ../db's query/execute/
// transaction surface is used, never mysql2 directly; timestamps are
// VARCHAR(32) ISO-8601 strings written via new Date().toISOString().
//
// A generation (one refresh_id) becomes visible to readers ONLY once ALL of
// its rows are inserted and nexs_asrs_dump_current has been atomically
// swapped to point at it - both of those happen inside the SAME transaction
// (see bulkInsertRows/markCompleted/swapCurrent, always called together
// with a shared `tx` from server/features/nexs-asrs-dump/nexsAsrsDumpEngine.js). This file
// itself has no opinion on transaction boundaries - it exposes the pieces,
// the engine composes them.

const db = require("../../platform/db");

// Deadlock hardening (2026-09-08, observed live: bulkInsertRows/markCompleted/
// swapCurrent all run inside ONE transaction - see nexsAsrsDumpEngine.js -
// and nexs_asrs_dump_rows carries an FK to nexs_asrs_dump_refreshes plus 3
// secondary indexes, so a full ~121k-row insert at 2000/batch held that
// transaction open (and its FK-shared parent-row lock) for ~9.6s, real
// "Deadlock found when trying to get lock" against it in production. Fewer,
// larger batches is the direct lever on a long transaction's deadlock odds -
// it shrinks wall-clock time (and the window a colliding transaction can
// land in), not just retries around the problem. 8000 rows/statement still
// stays well under this server's max_allowed_packet (64MB, confirmed) with
// large margin.
const BATCH_SIZE = 8000;

// createRefresh({ queryId, refreshedBy }) -> refreshId (int)
// Inserted as its own, immediately-committed statement (mirrors
// queryManagerMysql.createQuery()'s own QUEUED/RUNNING row) - gives every
// refresh attempt a stable id before we know whether it will succeed, and
// makes an in-progress refresh visible for diagnostics.
async function createRefresh({ queryId, refreshedBy }) {
  const now = new Date().toISOString();
  const result = await db.execute(
    `INSERT INTO nexs_asrs_dump_refreshes (query_id, status, refreshed_by, started_at, created_at)
     VALUES (?, 'RUNNING', ?, ?, ?)`,
    [queryId || null, refreshedBy ?? null, now, now]
  );
  return result.insertId;
}

// bulkInsertRows(refreshId, rows, { tx }) - batched multi-row INSERT, never
// one statement for the full ~121k rows. `tx` is required by convention
// (the caller always runs this inside server/features/nexs-asrs-dump/nexsAsrsDumpEngine.js's
// single write transaction) but falls back to the plain db surface so this
// function is independently unit-testable against a fake.
async function bulkInsertRows(refreshId, rows, { tx } = {}) {
  const runner = tx || db;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => "(?,?,?,?,?,?,?,?)").join(",");
    const params = [];
    for (const r of batch) {
      params.push(
        refreshId,
        r.pid ?? null,
        r.toteId ?? null,
        r.partition ?? null,
        r.barcodeCount ?? null,
        r.location ?? null,
        r.lastUpdatedAt ?? null,
        r.ingestedAt ?? null
      );
    }
    await runner.execute(
      `INSERT INTO nexs_asrs_dump_rows
         (refresh_id, pid, tote_id, partition_code, barcode_count, location, last_updated_at, ingested_at)
       VALUES ${placeholders}`,
      params
    );
  }
}

// markCompleted(refreshId, fields, { tx }) - the refresh row's terminal
// success update. Always called inside the same transaction as
// bulkInsertRows/swapCurrent (see the engine) so a mid-write failure rolls
// this back along with the rows themselves.
async function markCompleted(refreshId, { rowCount, totalBarcodeCount, source, latestIngestedAt, latestUpdatedAt }, { tx } = {}) {
  const runner = tx || db;
  const now = new Date().toISOString();
  await runner.execute(
    `UPDATE nexs_asrs_dump_refreshes
        SET status = 'COMPLETED', row_count = ?, total_barcode_count = ?, source = ?,
            latest_ingested_at = ?, latest_updated_at = ?, completed_at = ?
      WHERE id = ?`,
    [rowCount, totalBarcodeCount, source || null, latestIngestedAt || null, latestUpdatedAt || null, now, refreshId]
  );
}

// markFailed(refreshId, error) - deliberately OUTSIDE any transaction (the
// write transaction, if one was open, has already rolled back by the time
// this is called) - a small, separate, always-succeeds-if-DB-is-up
// statement, mirroring queryManagerMysql.failQuery()'s own pattern.
async function markFailed(refreshId, error) {
  const now = new Date().toISOString();
  await db.execute(
    `UPDATE nexs_asrs_dump_refreshes SET status = 'FAILED', error = ?, completed_at = ? WHERE id = ?`,
    [String(error || "Unknown error"), now, refreshId]
  );
}

// swapCurrent(refreshId, { tx }) - the atomic "this generation is now
// current" switch. A single upsert against the singleton pointer row
// (id=1). Always called inside the same transaction as bulkInsertRows/
// markCompleted.
async function swapCurrent(refreshId, { tx } = {}) {
  const runner = tx || db;
  await runner.execute(
    `INSERT INTO nexs_asrs_dump_current (id, refresh_id) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE refresh_id = VALUES(refresh_id)`,
    [refreshId]
  );
}

// getCurrentMeta() -> the refresh metadata row nexs_asrs_dump_current
// points at, with the refreshing user's employee_id resolved (same
// user_id -> employee_id JOIN pattern admin.routes.js's query listing
// already uses) - or null if no generation has ever become current.
async function getCurrentMeta() {
  const rows = await db.query(
    `SELECT r.*, u.employee_id AS refreshed_by_employee_id
       FROM nexs_asrs_dump_current c
       JOIN nexs_asrs_dump_refreshes r ON r.id = c.refresh_id
       LEFT JOIN users u ON u.id = r.refreshed_by
      WHERE c.id = 1`
  );
  return rows[0] || null;
}

// getLatestAttemptMeta() -> the most recent CONCLUDED (COMPLETED or FAILED)
// refresh attempt, regardless of whether it's the current one - mirrors the
// original in-memory engine's `lastAttempt`, which was only ever set at the
// end of a refresh (never while still RUNNING).
async function getLatestAttemptMeta() {
  const rows = await db.query(
    `SELECT * FROM nexs_asrs_dump_refreshes WHERE status IN ('COMPLETED','FAILED') ORDER BY id DESC LIMIT 1`
  );
  return rows[0] || null;
}

// getRowsForRefresh(refreshId) -> raw DB rows for one generation. The
// engine maps these back to the canonical {pid, toteId, partition,
// barcodeCount, location, lastUpdatedAt, ingestedAt} shape - this file
// stays a thin data-access layer, no shape translation here.
async function getRowsForRefresh(refreshId) {
  return db.query(
    `SELECT pid, tote_id, partition_code, barcode_count, location, last_updated_at, ingested_at
       FROM nexs_asrs_dump_rows WHERE refresh_id = ?`,
    [refreshId]
  );
}

// reconcileStaleRunning() - a refresh row left at RUNNING by a backend
// process that restarted mid-refresh can never progress (there is no live
// job to finish it). Flips every such row to FAILED with an explanatory
// reason. Safe to call any time - a no-op (0 rows affected) when nothing is
// actually stuck. Mirrors queryManagerMysql.reconcileStale()'s own
// "a row stuck active with no live owner is not stuck forever" principle,
// applied in bulk since there is no per-refresh in-memory job registry here.
async function reconcileStaleRunning() {
  const now = new Date().toISOString();
  await db.execute(
    `UPDATE nexs_asrs_dump_refreshes
        SET status = 'FAILED', error = 'Backend restarted before this refresh finished', completed_at = ?
      WHERE status = 'RUNNING'`,
    [now]
  );
}

// cleanupOldGenerations(keep) -> { deletedGenerations: [refreshId, ...] }
// Deletes ROW data (never the metadata row) for COMPLETED generations
// beyond the newest `keep`. The current generation is always kept even if,
// for any reason, it weren't among the newest `keep` COMPLETED rows
// (belt-and-suspenders - by construction it always is, since swapCurrent()
// only ever points at a generation that was just marked COMPLETED).
// RUNNING/FAILED generations are never candidates at all (FAILED ones were
// already rolled back to zero rows by the write transaction; RUNNING ones
// are, by definition, not yet COMPLETED). Batched DELETE per generation -
// never one statement across the whole stale generation's rows.
async function cleanupOldGenerations(keep = 3) {
  const currentRows = await db.query(`SELECT refresh_id FROM nexs_asrs_dump_current WHERE id = 1`);
  const currentId = currentRows[0] ? currentRows[0].refresh_id : null;

  const recentRows = await db.query(
    `SELECT id FROM nexs_asrs_dump_refreshes WHERE status = 'COMPLETED' ORDER BY id DESC LIMIT ?`,
    [keep]
  );
  const keepIds = new Set(recentRows.map((r) => r.id));
  if (currentId != null) keepIds.add(currentId);

  const keepList = [...keepIds];
  const placeholders = keepList.map(() => "?").join(",") || "NULL";
  const staleRows = await db.query(
    `SELECT id FROM nexs_asrs_dump_refreshes WHERE status = 'COMPLETED' AND id NOT IN (${placeholders})`,
    keepList
  );

  const deletedGenerations = [];
  for (const { id: staleId } of staleRows) {
    if (keepIds.has(staleId)) continue; // never delete current or a kept generation
    for (;;) {
      const result = await db.execute(`DELETE FROM nexs_asrs_dump_rows WHERE refresh_id = ? LIMIT 5000`, [staleId]);
      if (!result.affectedRows) break;
    }
    deletedGenerations.push(staleId);
  }
  return { deletedGenerations };
}

module.exports = {
  createRefresh,
  bulkInsertRows,
  markCompleted,
  markFailed,
  swapCurrent,
  getCurrentMeta,
  getLatestAttemptMeta,
  getRowsForRefresh,
  reconcileStaleRunning,
  cleanupOldGenerations,
  BATCH_SIZE,
};
