// Administrative/system audit trail - deliberately separate from ASRS
// operational call history (which today lives in chrome.storage.local / the
// Apps Script "Call History" sheet and is out of scope for Phase 1).
// This only records actions taken against THIS backend: auth and query
// lifecycle/admin events.

const config = require("../../config");
const db = require("../db");
const localStore = require("../storage/localStore");
const outbox = require("./outbox");
const { OPERATION_META } = require("./operationLog");

// Local-First Phase 1: when config.localStoreMode === "local", a failed
// MySQL write (which, in this mode, is every write - there is no reachable
// MySQL) is also persisted to webapp/.local-dev-data/audit_logs.json so
// the audit trail (and therefore Pull Logs - the "operations" live feed's
// listByActions() call below) survives a backend restart. This does NOT
// change behavior for production (always throws, exactly as before).
//
// Only the four Manual/Auto session-completion actions in
// operationLog.OPERATION_META also get an outbox.js entry (entity_type
// "audit_log") - LOGIN/LOGOUT/QUERY_CREATED/RUNTIME_* etc. are not
// "operations" in the sync sense and are deliberately never queued for
// company sync (see the Phase 1 report's entity list).
const LOCAL_COLLECTION = "audit_logs";
let localRows = null; // lazily hydrated on first local write/read
let nextLocalId = 1;

function hydrateLocal() {
  if (localRows) return;
  localRows = localStore.readCollection(LOCAL_COLLECTION, []);
  nextLocalId = localRows.reduce((max, r) => Math.max(max, r.id), 0) + 1;
}

function persistLocal() {
  localStore.writeCollection(LOCAL_COLLECTION, localRows);
}

// Local-dev-auth mode grants exactly one identity for every request
// (config.seedAdminId / ADMIN) - see queryManagerMemory.js's identical
// justification for hardcoding it rather than looking it up.
function recordLocal(userId, action, detail) {
  hydrateLocal();
  const row = {
    id: nextLocalId++,
    user_id: userId == null ? null : userId,
    employee_id: config.seedAdminId,
    role: "ADMIN",
    action: String(action),
    detail: detail == null ? null : JSON.stringify(detail),
    created_at: new Date().toISOString(),
  };
  localRows.push(row);
  persistLocal();

  if (OPERATION_META[row.action]) {
    outbox.append({ entityType: "audit_log", payload: row });
  }
}

// Always tries the real (MySQL) audit trail first. The fallback below ONLY
// activates when config.localDevAuthEnabled is set (STRICT LOCAL DEVELOPMENT
// AUTH MODE, see server/platform/session/localDevGuard.js) - in every other case,
// including a genuine unexpected MySQL outage in normal/production
// operation, a failed audit write still throws/propagates exactly as
// before. This is not a second permanent audit system - it's the same single
// code path, made tolerant of one explicitly-configured development
// scenario. As soon as MySQL is reachable again (or that mode is switched
// off), this resumes writing to audit_logs with no code change. It can never
// be true in production: localDevAuthEnabled is refused there
// (server/platform/session/localDevGuard.js).
async function record(userId, action, detail) {
  try {
    await db.execute(
      "INSERT INTO audit_logs (user_id, action, detail, created_at) VALUES (?, ?, ?, ?)",
      [
        userId == null ? null : userId,
        String(action),
        detail == null ? null : JSON.stringify(detail),
        new Date().toISOString(),
      ]
    );
  } catch (e) {
    if (!config.localDevAuthEnabled) throw e;
    console.warn(
      `[audit:dev-fallback] MySQL unavailable - action=${action} userId=${userId ?? "null"} detail=${
        detail ? JSON.stringify(detail) : "null"
      }`
    );
    if (config.localStoreMode === "local") {
      recordLocal(userId, action, detail);
    }
  }
}

async function list(limit = 200) {
  if (config.localStoreMode === "local") {
    hydrateLocal();
    return localRows.slice().sort((a, b) => b.id - a.id).slice(0, limit);
  }
  return db.query("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?", [limit]);
}

// listByActions(actions, limit) - used by the Pull Logs live feed (server/live/feeds.js)
// so it stays persistence-agnostic (mirrors the
// mysql/memory selector pattern: the branching lives in exactly one place).
// In "mysql" mode this is the same SQL the old inline log route ran.
async function listByActions(actions, limit = 200) {
  if (config.localStoreMode === "local") {
    hydrateLocal();
    return localRows
      .filter((r) => actions.includes(r.action))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }
  return db.query(
    `SELECT a.*, u.employee_id, u.role FROM audit_logs a
       JOIN users u ON u.id = a.user_id
      WHERE a.action IN (${actions.map(() => "?").join(",")})
      ORDER BY a.id DESC
      LIMIT ?`,
    [...actions, limit]
  );
}

// Pull Logs history: the same rows as listByActions, narrowed to a created_at window (ISO strings, so a plain
// string compare is a time compare) and optionally to an employee ID / text found in the detail (a tote ID).
// Paged newest first by id: pass the last id seen as beforeId for the next page.
const likeArg = (q) => `%${String(q).replace(/[\\%_]/g, (c) => "\\" + c)}%`;

async function listByActionsInRange(actions, { fromIso, toIso, beforeId = null, q = "", limit = 50 }) {
  if (config.localStoreMode === "local") {
    hydrateLocal();
    const needle = String(q || "").toLowerCase();
    return localRows
      .filter((r) => actions.includes(r.action) && r.created_at >= fromIso && r.created_at < toIso)
      .filter((r) => beforeId == null || r.id < beforeId)
      .filter((r) => !needle || String(r.employee_id || "").toLowerCase().includes(needle) || String(r.detail || "").toLowerCase().includes(needle))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }
  const where = [`a.action IN (${actions.map(() => "?").join(",")})`, "a.created_at >= ?", "a.created_at < ?"];
  const params = [...actions, fromIso, toIso];
  if (beforeId != null) { where.push("a.id < ?"); params.push(beforeId); }
  if (q) { where.push("(u.employee_id LIKE ? OR a.detail LIKE ?)"); params.push(likeArg(q), likeArg(q)); }
  return db.query(
    `SELECT a.*, u.employee_id, u.role FROM audit_logs a
       JOIN users u ON u.id = a.user_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.id DESC
      LIMIT ?`,
    [...params, limit]
  );
}

// Totals for the same window and filter, per action: sessions and totes (the session's totalTotes, else the
// length of its results). Only counts - the detail itself is never shipped for this.
async function countByActionsInRange(actions, { fromIso, toIso, q = "" }) {
  if (config.localStoreMode === "local") {
    const rows = await listByActionsInRange(actions, { fromIso, toIso, q, limit: Infinity });
    const out = {};
    for (const r of rows) {
      let d = {};
      try { d = r.detail ? JSON.parse(r.detail) : {}; } catch (e) { d = {}; }
      const o = out[r.action] || (out[r.action] = { sessions: 0, totes: 0 });
      o.sessions++;
      o.totes += Number(d.totalTotes != null ? d.totalTotes : (d.results || []).length) || 0;
    }
    return out;
  }
  const where = [`a.action IN (${actions.map(() => "?").join(",")})`, "a.created_at >= ?", "a.created_at < ?"];
  const params = [...actions, fromIso, toIso];
  if (q) { where.push("(u.employee_id LIKE ? OR a.detail LIKE ?)"); params.push(likeArg(q), likeArg(q)); }
  const rows = await db.query(
    `SELECT a.action, COUNT(*) AS sessions,
            SUM(CASE WHEN JSON_VALID(a.detail)
                     THEN COALESCE(JSON_EXTRACT(a.detail, '$.totalTotes'), JSON_LENGTH(a.detail, '$.results'), 0)
                     ELSE 0 END) AS totes
       FROM audit_logs a
       JOIN users u ON u.id = a.user_id
      WHERE ${where.join(" AND ")}
      GROUP BY a.action`,
    params
  );
  const out = {};
  for (const r of rows) out[r.action] = { sessions: Number(r.sessions) || 0, totes: Number(r.totes) || 0 };
  return out;
}

module.exports = { record, list, listByActions, listByActionsInRange, countByActionsInRange };
