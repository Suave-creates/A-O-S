// Keeps the Locked Totes snapshot fresh without anyone pressing Refresh.
//
// A snapshot only changed when a person clicked Refresh on the Locked Tote Information tab, so the Dashboard
// tile could sit on an hours-old number. Now, while anyone has the app open (the live feeds below call this),
// a refresh runs by itself when the newest snapshot is older than `lockedToteAutoRefreshMs` (default 15 min).
//
// It is a normal refresh (same engine, a Query Manager row attributed to the first ADMIN), single-flight, and
// spaced out: a refresh reads Grafana (locked totes, supervisor dump) and Quadron, so it is never run more often
// than the interval, and a failed attempt is not retried for 5 minutes. A manual Refresh is unaffected.

const config = require("../config");
const db = require("../platform/db");
const queryManager = require("../platform/queries/queryManager");
const classificationEngine = require("../features/locked-tote-info/classificationEngine");
const { getSystemUser } = require("./systemUser");

const CHECK_EVERY_MS = 30 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

let refreshing = false;
let lastCheckAt = 0;
let lastAttemptAt = 0;

async function newestSnapshotAt() {
  const rows = await db.query("SELECT MAX(created_at) AS latest FROM locked_tote_snapshots");
  return rows[0] && rows[0].latest ? Date.parse(rows[0].latest) : 0;
}

// Fire-and-forget: callers never wait on it.
function maybeRefresh() {
  const every = config.lockedToteAutoRefreshMs;
  if (!(every > 0) || refreshing) return;
  if (Date.now() - lastCheckAt < CHECK_EVERY_MS) return;
  lastCheckAt = Date.now();
  (async () => {
    try {
      const age = Date.now() - (await newestSnapshotAt());
      if (age < every || Date.now() - lastAttemptAt < RETRY_AFTER_FAILURE_MS) return;
      refreshing = true;
      lastAttemptAt = Date.now();
      const user = await getSystemUser();
      const q = await queryManager.createQuery({ userId: user.id, operation: "LOCKED_TOTE_INFO_REFRESH", parameters: { auto: true } });
      // the system user has no employee id; label the snapshot so the screen says who (what) refreshed it
      await classificationEngine.refresh({ queryId: q.query_id, user: { ...user, employeeId: "auto-refresh" } });
      console.log("[locked-totes] auto-refreshed (snapshot was older than " + Math.round(every / 60000) + " min).");
    } catch (e) {
      console.warn("[locked-totes] auto-refresh failed:", e.message || e);
    } finally {
      refreshing = false;
    }
  })();
}

// A Locked Totes snapshot on request (a screen's auto-refresh tick or Refresh), when the newest one is older than
// maxAgeMs. Single-flight: a second request while one runs waits for that one. Never throws - a failed refresh
// leaves the last snapshot current (it is reported in the server log).
let inFlight = null;
function refreshNow({ maxAgeMs = 60 * 1000 } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      if (Date.now() - (await newestSnapshotAt()) < maxAgeMs) return false;
      const user = await getSystemUser();
      const q = await queryManager.createQuery({ userId: user.id, operation: "LOCKED_TOTE_INFO_REFRESH", parameters: { auto: true, onRequest: true } });
      await classificationEngine.refresh({ queryId: q.query_id, user: { ...user, employeeId: "auto-refresh" } });
      return true;
    } catch (e) {
      console.warn("[locked-totes] refresh on request failed:", e.message || e);
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

module.exports = { maybeRefresh, refreshNow };
