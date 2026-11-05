// DEVELOPMENT-ONLY, off-network implementation of the Query Manager
// interface. Used only when config.queryManagerMode === "memory" (see
// server/platform/queries/queryManager.js, the selector, which refuses to select this
// module at all when NODE_ENV=production) - mirrors
// server/runtime/registryMemory.js's own role/shape exactly.
//
// Behaves identically to queryManagerMysql.js from every caller's point of
// view - same function names, same async signatures, same row shape
// (snake_case fields matching the `queries` table columns, `parameters`
// stored as a JSON STRING exactly like the MySQL column, not an object) -
// so capabilityManager.js, toteEngine.routes.js, autoEngine.js,
// queries.routes.js, and admin.routes.js never need to know which one is
// active.
//
// Local-First Phase 1: rows ARE now persisted, to
// webapp/.local-dev-data/queries.json via localStore.js, ONLY when
// config.localStoreMode === "local" (the same gate this whole module is
// already selected under). The in-memory Map remains the source of truth
// while the process is running (every read/write goes through it, exactly
// as before) - the local store is a write-through mirror, hydrated back
// into the Map once at module load so history survives a restart. The
// `registry` Map (live AbortControllers) is deliberately NEVER persisted -
// those cannot be serialized, and a row still QUEUED/RUNNING/
// CANCEL_REQUESTED with no live registry entry is reconciled to FAILED on
// next read by the existing reconcileStale() below, exactly as before
// restart-persistence existed. This is Phase 1 only - an in-flight
// session's rich engine state (AutoEngine/TotePullEngine's own
// `this.sessions` Map) is NOT persisted or resumed; see the Phase 1 report
// for why that is explicitly out of scope.
//
// Every terminal transition (COMPLETED/FAILED/CANCELLED/TIMEOUT, all of
// which funnel through updateTerminalStatus() below) also appends one
// outbox.js entry (entity_type "query") representing that row for later
// sync to company MySQL - see outbox.js and server/scripts/syncToCompany.js.
//
// listQueries()'s MySQL counterpart JOINs `users` for employee_id. There is
// no `users` table available here - but this module is only ever selected
// when config.localDevAuthEnabled is true, which means requireAuth grants
// EXACTLY ONE identity for every single request (config.seedAdminId, see
// server/platform/http/requireAuth.js) - there is no other user who could ever
// call createQuery() while this module is active. Reading
// config.seedAdminId directly is therefore not a guess or a fabrication;
// it is the one and only real identity this mode ever produces.

const config = require("../../config");
const auditLog = require("../audit/auditLog");
const localStore = require("../storage/localStore");
const outbox = require("../audit/outbox");

const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING", "CANCEL_REQUESTED"]);
// Deliberately narrower than ACTIVE_STATUSES - mirrors queryManagerMysql.js's
// findActiveByParam() SQL exactly ("status IN ('QUEUED','RUNNING')"), which
// does NOT include CANCEL_REQUESTED. A query already being cancelled must
// not block a fresh duplicate-in-flight check for the same parameter.
const DUPLICATE_CHECK_STATUSES = new Set(["QUEUED", "RUNNING"]);
const TERMINAL_OUTBOX_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);

const LOCAL_COLLECTION = "queries";

const rows = new Map(); // query_id -> row
const registry = new Map(); // query_id -> { controller, cancelledByUser } - same role as queryManagerMysql.js's own
let nextId = 1;

// Hydrate once at module load from the local store (no-op, leaves rows
// empty and nextId at 1, if the file does not exist yet - e.g. first ever
// run). This is what lets `nextId` stay collision-free across restarts:
// without this, a fresh process would start counting from 1 again and
// could mint a query_id that already exists in the persisted history.
(function hydrate() {
  if (config.localStoreMode !== "local") return;
  const persisted = localStore.readCollection(LOCAL_COLLECTION, []);
  let maxId = 0;
  for (const row of persisted) {
    rows.set(row.query_id, row);
    if (row.id > maxId) maxId = row.id;
  }
  nextId = maxId + 1;
})();

function persist() {
  if (config.localStoreMode !== "local") return;
  localStore.writeCollection(LOCAL_COLLECTION, [...rows.values()]);
}

function clone(row) {
  return row ? { ...row } : null;
}

function formatQueryId(id) {
  return `Q-${String(id).padStart(6, "0")}`;
}

async function createQuery({ userId, operation, parameters }) {
  const id = nextId++;
  const query_id = formatQueryId(id);
  const now = new Date().toISOString();
  const row = {
    id,
    query_id,
    user_id: userId,
    employee_id: config.seedAdminId, // see module comment - the only identity this mode ever produces
    operation,
    status: "QUEUED",
    parameters: JSON.stringify(parameters || {}), // matches the MySQL column exactly - a JSON STRING, not an object
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    error: null,
    created_at: now,
  };
  rows.set(query_id, row);
  persist();

  await auditLog.record(userId, "QUERY_CREATED", { queryId: query_id, operation });
  return clone(row);
}

async function markRunning(queryId) {
  const row = rows.get(queryId);
  if (!row) return;
  const now = new Date().toISOString();
  row.status = "RUNNING";
  row.started_at = row.started_at || now;
  persist();
}

// Local-First Phase 1: every terminal transition also appends one outbox
// entry (entity_type "query") representing this row, so it can later reach
// company MySQL's `queries` table via server/scripts/syncToCompany.js. Not
// gated on which specific status - COMPLETED/FAILED/CANCELLED/TIMEOUT are
// all legitimate historical records worth syncing, including a row
// reconciled to FAILED by reconcileStale() after an interrupted restart.
function updateTerminalStatus(queryId, status, { completedAt = null, cancelledAt = null, error = null } = {}) {
  const row = rows.get(queryId);
  if (row) {
    row.status = status;
    row.completed_at = completedAt;
    row.cancelled_at = cancelledAt;
    row.error = error;
    persist();
    if (config.localStoreMode === "local" && TERMINAL_OUTBOX_STATUSES.has(status)) {
      outbox.append({ entityType: "query", payload: clone(row) });
    }
  }
  registry.delete(queryId);
}

async function completeQuery(queryId) {
  const now = new Date().toISOString();
  updateTerminalStatus(queryId, "COMPLETED", { completedAt: now });
}

async function failQuery(queryId, error) {
  const now = new Date().toISOString();
  updateTerminalStatus(queryId, "FAILED", { completedAt: now, error: String(error || "Unknown error") });
}

// Generic across every capability (Grafana/Quadron/NexS single-PID and
// batch/Apps Script) - this function has no idea which one timed out, so
// the message must never name one specific capability (it previously
// hardcoded "Apps Script", which was actively misleading on e.g. a
// GET_QUADRON_INVENTORY timeout row).
async function timeoutQuery(queryId) {
  const now = new Date().toISOString();
  updateTerminalStatus(queryId, "TIMEOUT", {
    completedAt: now,
    error: "Backend gave up waiting for a response (timeout)",
  });
}

async function finalizeCancelled(queryId) {
  const now = new Date().toISOString();
  updateTerminalStatus(queryId, "CANCELLED", { cancelledAt: now });
}

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
  return clone(rows.get(queryId));
}

async function findActiveByParam(operation, paramKey, paramValue) {
  for (const row of rows.values()) {
    if (row.operation !== operation) continue;
    if (!DUPLICATE_CHECK_STATUSES.has(row.status)) continue;
    let params;
    try {
      params = JSON.parse(row.parameters);
    } catch (e) {
      continue;
    }
    if (params && params[paramKey] === paramValue) return { query_id: row.query_id };
  }
  return null;
}

async function getQuery(queryId) {
  const row = rows.get(queryId);
  return row ? reconcileStale(row) : null;
}

// Mirrors queryManagerMysql.js's own ACTIVE_FIRST_ORDER_BY exactly (see its
// comment) - active queries sort above every terminal one, then newest
// first within each group, so a long-running/stuck query is never pushed
// out of the list by newer completed ones.
async function listQueries({ userId, isAdmin, limit = 100 }) {
  const all = [...rows.values()]
    .filter((r) => isAdmin || r.user_id === userId)
    .sort((a, b) => {
      const activeDiff = (ACTIVE_STATUSES.has(b.status) ? 1 : 0) - (ACTIVE_STATUSES.has(a.status) ? 1 : 0);
      return activeDiff !== 0 ? activeDiff : b.id - a.id;
    })
    .slice(0, limit);
  return Promise.all(all.map(reconcileStale));
}

// Mirrors queryManagerMysql.js's own reconcileStale() exactly: a row stuck
// QUEUED/RUNNING/CANCEL_REQUESTED with no live entry in `registry` (e.g.
// this process restarted) is surfaced honestly as FAILED, never left
// silently stuck.
async function reconcileStale(row) {
  if (ACTIVE_STATUSES.has(row.status) && !registry.has(row.query_id)) {
    await failQuery(row.query_id, "Backend restarted before this query finished");
    return clone(rows.get(row.query_id));
  }
  return clone(row);
}

async function cancelQuery(queryId, requestingUser) {
  const row = rows.get(queryId);
  if (!row) return { ok: false, code: 404, reason: "Query not found" };

  if (requestingUser.role !== "ADMIN" && row.user_id !== requestingUser.id) {
    return { ok: false, code: 403, reason: "You may not cancel another user's query" };
  }

  if (!ACTIVE_STATUSES.has(row.status)) {
    return { ok: false, code: 409, reason: `Query already ${row.status}` };
  }

  row.status = "CANCEL_REQUESTED";
  persist();

  const entry = registry.get(queryId);
  if (entry) {
    entry.cancelledByUser = true;
    entry.controller.abort();
  } else {
    await finalizeCancelled(queryId);
  }

  await auditLog.record(requestingUser.id, "QUERY_CANCEL_REQUESTED", { queryId });
  return { ok: true, query: clone(rows.get(queryId)) };
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
