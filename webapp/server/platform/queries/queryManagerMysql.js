// Query Manager - the central abstraction for every backend-executed
// operation. Phase 1 only drives it from Tote Utilisation, but the shape
// (createQuery/getQuery/cancelQuery + status lifecycle) is meant to be the
// same one future operations (RCA, Purge, Cycle Count, ...) plug into.
//
// IMPORTANT - cancellation semantics: cancelling a query that is calling out
// to Google Apps Script does NOT stop execution inside Apps Script itself -
// there is no kill hook for that in the current system. What "cancel" means
// here is: the backend stops waiting on / processing the response, via an
// AbortController wired into the outbound fetch, and the query is marked
// CANCELLED. If Apps Script keeps running remotely, its (now-unused) result
// is simply discarded when/if it eventually arrives. This logic is entirely
// in-memory/persistence-agnostic and is UNCHANGED by the MySQL migration -
// only the surrounding reads/writes below became async.
//
// This is intentionally independent of, and unrelated to, the existing
// tote-serving kill switch (Config!kill_switch in the Google
// Sheet/apps-script/Code.gs). That mechanism is untouched by this file.
//
// This is the MySQL-backed implementation only - server/platform/queries/queryManager.js
// is now a thin selector between this file and queryManagerMemory.js,
// mirroring server/runtime/registry.js's own mysql/memory split exactly.
// This file's own code/behavior is UNCHANGED by that extraction.

const db = require("../db");
const auditLog = require("../audit/auditLog");

const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING", "CANCEL_REQUESTED"]);

// In-memory registry of in-flight jobs: queryId -> { controller, cancelledByUser }
// Deliberately NOT persisted - if the process restarts, any query still
// QUEUED/RUNNING in the DB has no live controller to cancel and is reconciled
// as FAILED on next read (see getQuery/listQueries below).
const registry = new Map();

async function createQuery({ userId, operation, parameters }) {
  const row = await db.transaction(async (tx) => {
    const result = await tx.execute(
      `INSERT INTO queries (query_id, user_id, operation, status, parameters, started_at, created_at)
       VALUES ('', ?, ?, 'QUEUED', ?, NULL, ?)`,
      [userId, operation, JSON.stringify(parameters || {}), new Date().toISOString()]
    );
    const id = result.insertId;
    await tx.execute(
      "UPDATE queries SET query_id = CONCAT('Q-', LPAD(id, 6, '0')) WHERE id = ?",
      [id]
    );
    const rows = await tx.query("SELECT * FROM queries WHERE id = ?", [id]);
    return rows[0];
  });

  await auditLog.record(userId, "QUERY_CREATED", { queryId: row.query_id, operation });
  return row;
}

async function markRunning(queryId) {
  const now = new Date().toISOString();
  await db.execute(
    `UPDATE queries SET status = 'RUNNING', started_at = COALESCE(started_at, ?) WHERE query_id = ?`,
    [now, queryId]
  );
}

async function updateTerminalStatus(queryId, status, { completedAt = null, cancelledAt = null, error = null } = {}) {
  await db.execute(
    `UPDATE queries
        SET status = ?, completed_at = ?, cancelled_at = ?, error = ?
      WHERE query_id = ?`,
    [status, completedAt, cancelledAt, error, queryId]
  );
  registry.delete(queryId);
}

async function completeQuery(queryId) {
  const now = new Date().toISOString();
  await updateTerminalStatus(queryId, "COMPLETED", { completedAt: now });
}

async function failQuery(queryId, error) {
  const now = new Date().toISOString();
  await updateTerminalStatus(queryId, "FAILED", { completedAt: now, error: String(error || "Unknown error") });
}

// Generic across every capability (Grafana/Quadron/NexS single-PID and
// batch/Apps Script) - this function has no idea which one timed out, so
// the message must never name one specific capability (it previously
// hardcoded "Apps Script", which was actively misleading on e.g. a
// GET_QUADRON_INVENTORY timeout row).
async function timeoutQuery(queryId) {
  const now = new Date().toISOString();
  await updateTerminalStatus(queryId, "TIMEOUT", {
    completedAt: now,
    error: "Backend gave up waiting for a response (timeout)",
  });
}

async function finalizeCancelled(queryId) {
  const now = new Date().toISOString();
  await updateTerminalStatus(queryId, "CANCELLED", { cancelledAt: now });
}

// Registers the AbortController for an in-flight job so cancelQuery() can
// reach it. Returns a small handle the executor uses to check/react to
// cancellation requests. Purely in-memory - no DB access.
function registerJob(queryId, controller) {
  const entry = { controller, cancelledByUser: false };
  registry.set(queryId, entry);
  return {
    signal: controller.signal,
    wasCancelledByUser: () => entry.cancelledByUser,
  };
}

function unregisterJob(queryId) {
  registry.delete(queryId);
}

async function getByQueryId(queryId) {
  const rows = await db.query("SELECT * FROM queries WHERE query_id = ?", [queryId]);
  return rows[0] || null;
}

// Duplicate-in-flight guard for mutating capabilities (e.g.
// PULL_QUADRON_TOTE) - "is there already an active query for this exact
// parameter value" - reusing the existing generic `parameters` JSON column.
// No new table or column: JSON_EXTRACT reads straight out of what
// createQuery() already persisted.
async function findActiveByParam(operation, paramKey, paramValue) {
  const rows = await db.query(
    `SELECT query_id FROM queries
      WHERE operation = ? AND status IN ('QUEUED','RUNNING')
        AND JSON_UNQUOTE(JSON_EXTRACT(parameters, ?)) = ?
      LIMIT 1`,
    [operation, `$.${paramKey}`, paramValue]
  );
  return rows[0] || null;
}

async function getQuery(queryId) {
  const row = await getByQueryId(queryId);
  return row ? reconcileStale(row) : null;
}

// Active queries (QUEUED/RUNNING/CANCEL_REQUESTED) always sort above every
// terminal one (operator-requested - a long-running or stuck query must
// never scroll off the bottom of the Admin/Active Queries list just because
// enough newer, already-finished queries piled up above it). This is done
// in the ORDER BY itself, not a client-side re-sort of whatever page comes
// back - sorting after the fact can't help if a plain "most recent LIMIT
// rows" query already excluded an older still-active row entirely; ordering
// active-first BEFORE the LIMIT guarantees every currently active query is
// included as long as there are fewer of them than `limit` (in practice,
// always). `q.status IN (...)` evaluates to 1/0 in MySQL, so DESC puts the
// active (1) rows first; q.id DESC is the secondary, newest-first order
// within each group - unchanged from before this fix.
const ACTIVE_FIRST_ORDER_BY = "ORDER BY (q.status IN ('QUEUED','RUNNING','CANCEL_REQUESTED')) DESC, q.id DESC";

async function listQueries({ userId, isAdmin, limit = 100 }) {
  const rows = isAdmin
    ? await db.query(
        `SELECT q.*, u.employee_id FROM queries q JOIN users u ON u.id = q.user_id ${ACTIVE_FIRST_ORDER_BY} LIMIT ?`,
        [limit]
      )
    : await db.query(
        `SELECT q.*, u.employee_id FROM queries q JOIN users u ON u.id = q.user_id WHERE q.user_id = ? ${ACTIVE_FIRST_ORDER_BY} LIMIT ?`,
        [userId, limit]
      );
  return Promise.all(rows.map(reconcileStale));
}

// If the process restarted, a row stuck QUEUED/RUNNING/CANCEL_REQUESTED with
// no live entry in `registry` can never progress - surface that honestly as
// FAILED instead of leaving it stuck forever.
async function reconcileStale(row) {
  if (ACTIVE_STATUSES.has(row.status) && !registry.has(row.query_id)) {
    await failQuery(row.query_id, "Backend restarted before this query finished");
    return getByQueryId(row.query_id);
  }
  return row;
}

// Returns { ok:true, query } if the query was moved to CANCEL_REQUESTED (and
// the AbortController was signalled) or finalized to CANCELLED, or
// { ok:false, code, reason } if it could not be cancelled (already finished,
// not found, or not permitted).
async function cancelQuery(queryId, requestingUser) {
  const row = await getByQueryId(queryId);
  if (!row) return { ok: false, code: 404, reason: "Query not found" };

  if (requestingUser.role !== "ADMIN" && row.user_id !== requestingUser.id) {
    return { ok: false, code: 403, reason: "You may not cancel another user's query" };
  }

  if (!ACTIVE_STATUSES.has(row.status)) {
    return { ok: false, code: 409, reason: `Query already ${row.status}` };
  }

  await db.execute("UPDATE queries SET status = 'CANCEL_REQUESTED' WHERE query_id = ?", [queryId]);

  const entry = registry.get(queryId);
  if (entry) {
    entry.cancelledByUser = true;
    entry.controller.abort();
  } else {
    // Still QUEUED and hasn't started executing yet (or already reconciled) -
    // no controller to abort; finalize directly.
    await finalizeCancelled(queryId);
  }

  await auditLog.record(requestingUser.id, "QUERY_CANCEL_REQUESTED", { queryId });
  return { ok: true, query: await getByQueryId(queryId) };
}

module.exports = {
  createQuery,
  markRunning,
  completeQuery,
  failQuery,
  timeoutQuery,
  finalizeCancelled,
  registerJob,
  unregisterJob,
  getQuery,
  listQueries,
  cancelQuery,
  findActiveByParam,
};
