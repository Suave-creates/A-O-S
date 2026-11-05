#!/usr/bin/env node
// Local-First Phase 1 - explicit, manually-triggered sync of the local
// outbox (webapp/.local-dev-data/outbox.json) into company MySQL, plus a
// separate additive merge of locally-tracked Classification "Locked Since"
// state. Invoked ONLY via `npm run sync-local-to-company` - NEVER run
// automatically (not on startup, not on reconnect, not on a timer). This
// script has no HTTP route and is not reachable from the running app, so
// nothing - a stray UI click, MySQL becoming reachable again - can trigger
// it implicitly.
//
// CRITICAL: this file must NEVER import quadronPull.js, quadronPullLock.js,
// capabilityManager.js, zonePicker.js, or anything under runtime/ - see
// server/test/syncToCompany.test.js's own structural test, which greps
// this file's source for exactly that. It only ever writes historical ASO
// bookkeeping rows (queries / audit_logs / classification_tote_state) that
// already reflect operations that already happened from home (a real
// Quadron pull, if one occurred, already happened for real through the
// unmodified capability/runtime path at the time it was recorded) - this
// script never re-executes, replays, or re-dispatches anything.
//
// Uses the SAME server/db module every other MySQL-backed code path uses,
// which resolves its target purely from config.js / the process's own env
// (DB_HOST/DB_NAME/DB_USER/DB_PASSWORD). `npm run sync-local-to-company`
// loads only .env (the same file `npm start` uses) - never .env.local-dev -
// so this always targets whichever MySQL .env currently points at. Point
// it at a real company database only when you mean to; for verification,
// override DB_NAME/DB_HOST/etc. via a dedicated test database exactly the
// way server/test/api.test.js and server/test/classificationTimestamps.test.js
// already do (TEST_DB_NAME, never DB_NAME/production_tracker).

const outbox = require("../platform/audit/outbox");
const localStore = require("../platform/storage/localStore");
const syncMeta = require("../platform/audit/syncMeta");
const config = require("../config");
const db = require("../platform/db");

// Local-dev-auth mode attributes every operation to exactly one identity
// (config.seedAdminId - see requireAuth.js/queryManagerMemory.js). Every
// synced row's user_id must be resolved to THAT identity's real company
// row id - the local sentinel id (-1) does not exist in company MySQL's
// users table and would violate the queries/audit_logs foreign keys.
async function resolveCompanyUserId() {
  const rows = await db.query("SELECT id FROM users WHERE employee_id = ?", [config.seedAdminId]);
  if (!rows[0]) {
    throw new Error(
      `No company user found with employee_id="${config.seedAdminId}" (config.seedAdminId). ` +
        `Local-dev-auth-mode operations are always attributed to this identity - it must already ` +
        `exist in company MySQL's users table before syncing.`
    );
  }
  return rows[0].id;
}

async function ledgerHas(operationId) {
  const rows = await db.query("SELECT operation_id FROM local_sync_ledger WHERE operation_id = ?", [operationId]);
  return !!rows[0];
}

async function recordLedger({ operationId, entityType, mysqlTable, mysqlId }) {
  await db.execute(
    "INSERT INTO local_sync_ledger (operation_id, entity_type, mysql_table, mysql_id, synced_at) VALUES (?, ?, ?, ?, ?)",
    [operationId, entityType, mysqlTable, mysqlId, new Date().toISOString()]
  );
}

// Deliberately does NOT try to preserve the local query_id string (e.g.
// "Q-000042") as the company row's query_id - company MySQL mints its own
// AUTO_INCREMENT id / query_id exactly the way queryManagerMysql.js's own
// createQuery() does, avoiding any collision with a company query_id that
// already exists (local and company each count from 1 independently). The
// original local query_id remains discoverable via this outbox entry's own
// payload and the local_sync_ledger row this call creates - no information
// is lost, nothing is silently overwritten.
async function syncQueryEntry(entry, companyUserId) {
  const row = entry.payload;
  return db.transaction(async (tx) => {
    const result = await tx.execute(
      `INSERT INTO queries (query_id, user_id, operation, status, parameters, started_at, completed_at, cancelled_at, error, created_at)
       VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyUserId, row.operation, row.status, row.parameters, row.started_at, row.completed_at, row.cancelled_at, row.error, row.created_at]
    );
    const id = result.insertId;
    await tx.execute("UPDATE queries SET query_id = CONCAT('Q-', LPAD(id, 6, '0')) WHERE id = ?", [id]);
    return { mysqlTable: "queries", mysqlId: id };
  });
}

// Pure additive INSERT - audit_logs has no unique key besides its own
// AUTO_INCREMENT id, so there is no collision risk to guard against here.
// created_at is preserved exactly as recorded locally (the moment the
// operation actually completed at home), not the sync time.
async function syncAuditLogEntry(entry, companyUserId) {
  const row = entry.payload;
  const result = await db.execute(
    "INSERT INTO audit_logs (user_id, action, detail, created_at) VALUES (?, ?, ?, ?)",
    [companyUserId, row.action, row.detail, row.created_at]
  );
  return { mysqlTable: "audit_logs", mysqlId: result.insertId };
}

// Reads every PENDING outbox entry and, for each: checks local_sync_ledger
// first (idempotency - requirement 13). Already-present operation_id ->
// mark SYNCED, no insert. Absent -> insert the company record, record the
// ledger row, then mark SYNCED. Any failure leaves the entry PENDING,
// increments retry_count, and records last_sync_error - the operation is
// never lost.
async function syncOutbox() {
  const companyUserId = await resolveCompanyUserId();
  const pending = outbox.list({ status: "PENDING" });
  const results = { synced: 0, alreadySynced: 0, failed: 0, total: pending.length };

  for (const entry of pending) {
    try {
      if (await ledgerHas(entry.operation_id)) {
        outbox.markSynced(entry.operation_id);
        results.alreadySynced++;
        continue;
      }

      let outcome;
      if (entry.entity_type === "query") {
        outcome = await syncQueryEntry(entry, companyUserId);
      } else if (entry.entity_type === "audit_log") {
        outcome = await syncAuditLogEntry(entry, companyUserId);
      } else {
        throw new Error(`Unknown outbox entity_type "${entry.entity_type}"`);
      }

      await recordLedger({ operationId: entry.operation_id, entityType: entry.entity_type, ...outcome });
      outbox.markSynced(entry.operation_id);
      results.synced++;
    } catch (e) {
      outbox.markFailed(entry.operation_id, e);
      results.failed++;
      console.error(`[sync] Failed to sync ${entry.operation_id} (${entry.entity_type}): ${e.message}`);
    }
  }

  return results;
}

// Additive-first MIN(first_seen_at)/MAX(last_seen_at) merge (requirement
// 14) - deliberately NOT routed through the generic outbox/ledger
// mechanism above (a merge is not a single idempotent "insert if absent"
// operation the way a completed session record is; it is safe to re-apply
// unconditionally, every run, which is idempotent in its own right: running
// it twice with unchanged local data changes nothing the second time).
// discrepancy_marked_at is not present anywhere in this statement, so it
// can never be overwritten by sync - same "the SQL's shape guarantees it"
// discipline classificationTimestampsMysql.js's own touchMany() already
// uses.
async function syncClassificationLockedSince() {
  const rows = localStore.readCollection("classification_tote_state", []);
  if (!rows.length) return { merged: 0 };

  for (const row of rows) {
    await db.execute(
      `INSERT INTO classification_tote_state (tote_id, first_seen_at, last_seen_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         first_seen_at = LEAST(first_seen_at, VALUES(first_seen_at)),
         last_seen_at = GREATEST(last_seen_at, VALUES(last_seen_at))`,
      [row.tote_id, row.first_seen_at, row.last_seen_at]
    );
  }
  return { merged: rows.length };
}

async function run() {
  console.log(`[sync] Target database: ${config.dbName || "(DB_NAME not set)"} @ ${config.dbHost || "(DB_HOST not set)"}`);

  const outboxResult = await syncOutbox();
  const classificationResult = await syncClassificationLockedSince();

  syncMeta.set({
    lastSyncAt: new Date().toISOString(),
    lastSyncSummary: { ...outboxResult, classificationMerged: classificationResult.merged },
  });

  console.log(
    `[sync] Outbox: ${outboxResult.synced} synced, ${outboxResult.alreadySynced} already-synced (ledger hit), ` +
      `${outboxResult.failed} failed, ${outboxResult.total} pending total.`
  );
  console.log(`[sync] Classification Locked Since: ${classificationResult.merged} tote(s) merged.`);

  return { outboxResult, classificationResult };
}

if (require.main === module) {
  run()
    .then(() => db.close())
    .catch(async (e) => {
      console.error("[sync] Fatal error:", e);
      process.exitCode = 1;
      await db.close();
    });
}

module.exports = { run, syncOutbox, syncClassificationLockedSince, resolveCompanyUserId };
