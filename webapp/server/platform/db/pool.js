// The ONE place a mysql2 connection pool is created for the running app.
// Nothing outside server/platform/db/ should import this directly - use
// server/platform/db/index.js (query/execute/transaction) instead, so no other module
// depends on the mysql2 API shape.

const mysql = require("mysql2/promise");
const config = require("../../config");

const pool = mysql.createPool({
  host: config.dbHost,
  port: config.dbPort,
  user: config.dbUser,
  password: config.dbPassword,
  database: config.dbName,
  ssl: config.dbSsl ? {} : undefined,
  waitForConnections: true,
  connectionLimit: config.dbConnectionLimit,
  // queueLimit:0 means "no cap on how many requests may wait for a free
  // connection" (NOT "no waiting allowed") - mysql2's own documented
  // meaning. Kept at 0 (unchanged) rather than rejecting bursts outright;
  // the actual "don't hang forever" guarantee comes from
  // db/index.js's withAcquireTimeout(), since mysql2's pool has no native
  // timeout for this wait.
  queueLimit: 0,
  // Database review remediation (2026-09-04): previously implicit
  // (mysql2's own built-in defaults) - now explicit and independently
  // configurable per environment. See config.js for the full reasoning
  // behind each default.
  maxIdle: config.dbMaxIdleConnections,
  idleTimeout: config.dbIdleTimeoutMs,
  connectTimeout: config.dbConnectTimeoutMs,
  charset: "utf8mb4",
  dateStrings: true,
  // Wi-Fi/NAT silently drops a socket that has been quiet for a while; the next query on it then hangs until
  // ETIMEDOUT. Keep-alive probes make the OS notice a dead socket within seconds, so the pool discards it
  // instead of handing it out.
  enableKeepAlive: true,
  keepAliveInitialDelay: config.dbKeepAliveMs,
});

// Database review remediation (2026-09-04), follow-up fix: mysql2's own
// idle-connection reaper (started internally whenever maxIdle <
// connectionLimit, which is now this app's default - see config.js's own
// note on why) reschedules itself via a plain setTimeout(..., 1000) every
// second for the entire lifetime of the pool (confirmed by reading
// node_modules/mysql2/lib/base/pool.js's _removeIdleTimeoutConnections()) -
// and that timer is never unref()'d, so it alone keeps the Node event loop
// (and therefore the process) alive indefinitely. Harmless and actually
// correct in the real server (which is SUPPOSED to run forever) - but it
// silently broke every short-lived script/test process that merely
// requires this module, even ones that never touch the database at all,
// since the timer starts unconditionally in the Pool constructor based on
// config alone. Confirmed live: this app's own test suite, which ran
// cleanly in ~5s all session, started hanging indefinitely the moment this
// fix activated the reaper.
//
// Since mysql2 exposes no option to unref this timer itself, this wraps
// its own rescheduling method so every timer it ever creates (the first
// one from the constructor, and every one it reschedules itself into
// afterward) gets unref()'d right after creation. unref() only affects
// whether this ONE timer keeps the process alive on its own - it does not
// stop, delay, or otherwise change the reaper's actual behavior in any
// way, so idle connections are still reclaimed exactly as configured.
// Defensive by construction (typeof-checked) - if a future mysql2 version
// renames or removes this internal method, this silently does nothing
// rather than throwing, and the worst case reverts to today's "reaper
// keeps the process alive" behavior, never a hard failure.
(function unrefIdleReaperTimer() {
  const core = pool.pool;
  if (!core || typeof core._removeIdleTimeoutConnections !== "function") return;
  const unrefCurrentTimer = () => {
    if (core._removeIdleTimeoutConnectionsTimer && typeof core._removeIdleTimeoutConnectionsTimer.unref === "function") {
      core._removeIdleTimeoutConnectionsTimer.unref();
    }
  };
  const original = core._removeIdleTimeoutConnections.bind(core);
  core._removeIdleTimeoutConnections = function () {
    original();
    unrefCurrentTimer();
  };
  unrefCurrentTimer(); // the constructor's own initial call already ran before we could wrap it
})();

// Lightweight, always-on observability counters (Task 6) - cheap
// increments on the pool's own events, not per-query logging. Read via
// poolStats() in db/index.js. `acquireFailures` counts a connection-level
// error surfacing through the pool's 'acquire'->error path (rare - most
// acquire failures instead show up as a rejected getConnection()/query()
// promise, already visible to the caller); kept here mainly so a genuine
// pool-level error is never completely silent even when no request is
// actively awaiting it.
const counters = { acquired: 0, released: 0, enqueued: 0, acquireFailures: 0 };
pool.on("acquire", () => { counters.acquired++; });
pool.on("release", () => { counters.released++; });
pool.on("enqueue", () => { counters.enqueued++; });
pool.on("error", (err) => {
  counters.acquireFailures++;
  console.error("[db-pool] pool-level error:", err.code || err.message);
});

// Snapshot of current pool state - active/idle/queued connection counts
// (Task 6). Reaches into mysql2's internal (undocumented, but stable and
// widely relied upon - e.g. the driver's own README references
// _allConnections/_freeConnections for exactly this) Pool bookkeeping via
// the promise wrapper's own `.pool` property (confirmed present by reading
// node_modules/mysql2/lib/promise/pool.js). Defensive against a future
// mysql2 internal-shape change: never throws, degrades to nulls instead.
function stats() {
  try {
    const core = pool.pool;
    return {
      total: core._allConnections.length,
      free: core._freeConnections.length,
      queued: core._connectionQueue.length,
      limit: config.dbConnectionLimit,
      ...counters,
    };
  } catch (e) {
    return { total: null, free: null, queued: null, limit: config.dbConnectionLimit, ...counters };
  }
}

module.exports = pool;
module.exports.stats = stats;
