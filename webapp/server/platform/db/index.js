// Clean database access layer. Business logic (Query Manager, auth, jobs,
// routes) depends ONLY on this module's three functions - never on mysql2 or
// the pool directly. Swapping database engines later would mean rewriting
// this file, not the app's business logic.

const config = require("../../config");
const pool = require("./pool");

// Database review remediation (2026-09-04): mysql2's pool has no native
// timeout for "waiting for a free connection when every connection is
// currently busy" (waitForConnections:true + queueLimit:0 means wait
// forever - confirmed by inspecting node_modules/mysql2/lib/base/pool.js,
// no timeout reference anywhere in its connection-queueing path). Every
// query()/execute()/transaction() call below races the real mysql2 work
// against this timer so a request can never hang indefinitely on pool
// exhaustion, per the review's explicit requirement.
//
// Leak-safety: if the timer wins the race, the ORIGINAL mysql2 promise is
// still pending and may resolve later once a connection frees up. This
// function still attaches a cleanup to it (release the connection if one
// arrives, or just let a plain query result be discarded) so a "timed out"
// acquisition can never silently hold a connection forever - the giving-up
// is purely from this application's perspective; mysql2 itself is still
// tracking and will eventually reclaim that connection normally.
function withAcquireTimeout(promise, { onLateResolve } = {}) {
  const ms = config.dbAcquireTimeoutMs;
  if (!ms) return promise;
  let timer;
  const timeoutErr = () => Object.assign(new Error(`Timed out after ${ms}ms waiting for a database connection`), { code: "DB_ACQUIRE_TIMEOUT" });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutErr()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)).catch((err) => {
    if (err && err.code === "DB_ACQUIRE_TIMEOUT" && onLateResolve) {
      promise.then(onLateResolve).catch(() => {});
    }
    throw err;
  });
}

// Wraps a plain SQL string into mysql2's native {sql, timeout} form so
// every query gets the same per-statement timeout without every one of
// this app's ~50 call sites needing to change. A caller that already passed
// an options object (rare - none currently do) is respected as-is rather
// than clobbered.
function withStatementTimeout(sql) {
  if (typeof sql !== "string" || !config.dbQueryTimeoutMs) return sql;
  return { sql, timeout: config.dbQueryTimeoutMs };
}

// SELECT-style calls. Returns the rows array.
async function query(sql, params = []) {
  const t0 = Date.now();
  const retryable = isReadOnly(sql);
  for (let attempt = 0; ; attempt++) {
    try {
      const [rows] = await withAcquireTimeout(pool.query(withStatementTimeout(sql), params));
      logSlowQuery(sql, Date.now() - t0);
      return rows;
    } catch (e) {
      // A read that hit a dropped socket is safe to repeat on a fresh connection; a write never is.
      if (retryable && attempt < config.dbReadRetries && TRANSIENT_NET_CODES.has(e.code)) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      throw classifyAndLog(e, sql, Date.now() - t0);
    }
  }
}

// Errors that mean "the connection died", not "the query is wrong or slow". Pool exhaustion
// (DB_ACQUIRE_TIMEOUT) and statement timeouts are deliberately absent - retrying those only adds load.
const TRANSIENT_NET_CODES = new Set([
  "ECONNRESET", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNREFUSED", "PROTOCOL_CONNECTION_LOST",
]);
function isReadOnly(sql) {
  const text = typeof sql === "string" ? sql : sql && sql.sql;
  return typeof text === "string" && /^\s*\(?\s*(SELECT|SHOW|WITH)\b/i.test(text);
}

// Keeps the pool warm: a ping every dbWarmPingMs opens/refreshes a connection before a request needs one, so a
// request never pays the connect cost and a dead socket is found (and replaced) by the ping, not by a user.
// Started by server/index.js, not on require, so tests and scripts stay quiet.
let warmTimer = null;
function startWarmPing() {
  if (warmTimer || !config.dbWarmPingMs) return;
  const ping = async () => {
    try {
      await pool.query({ sql: "SELECT 1", timeout: 5000 });
    } catch (e) {
      console.warn(`[db] warm ping failed (${e.code || e.message}) - the pool will reconnect on next use.`);
    }
  };
  ping();
  warmTimer = setInterval(ping, config.dbWarmPingMs);
  if (warmTimer.unref) warmTimer.unref();
}

// INSERT/UPDATE/DELETE-style calls. Returns { insertId, affectedRows, ... }.
//
// One Pager Report deadlock fix (2026-09-07, operator-reported: "Deadlock
// found when trying to get lock" on repeated Generate clicks). Root cause:
// onePagerReportEngine.js's generate() is the first place in this app that
// fires several independent capability refreshes (each with its own
// result-table INSERT - locked_tote_snapshots, tote_utilisation_results,
// one_pager_reports itself) truly concurrently via Promise.all, and a
// second overlapping Generate click multiplies that further. pool.execute()
// runs each single statement in mysql2's own implicit auto-commit
// transaction, so a deadlock here means that ONE statement was wholly
// rolled back - nothing partial to worry about - making a transparent retry
// exactly as safe as transaction()'s own identical, already-established
// retry below (same RETRYABLE_ERRNOS/backoff, same MySQL-documented
// recommendation for this error class). This protects every existing
// execute() caller in the app, not just the new report - the least
// invasive fix, since it needed no change to classificationEngine.js/
// toteUtilisationJob.js's own already-correct INSERT statements.
async function execute(sql, params = []) {
  for (let attempt = 1; attempt <= TRANSACTION_MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    try {
      const [result] = await withAcquireTimeout(pool.execute(withStatementTimeout(sql), params));
      logSlowQuery(sql, Date.now() - t0);
      return result;
    } catch (e) {
      if (RETRYABLE_ERRNOS.has(e.errno) && attempt < TRANSACTION_MAX_ATTEMPTS) {
        await backoff(attempt);
        continue;
      }
      throw classifyAndLog(e, sql, Date.now() - t0);
    }
  }
}

// Observability (Task 6), deliberately cheap: only ever logs when a query
// is slow (not every query - "avoid excessive logging that could impact
// production performance") or when one errors. SLOW_QUERY_MS is a fixed
// internal threshold, not another env var to tune - this schema's queries
// are all simple, already-indexed lookups (see the query-audit migration
// 0007's own comment for the evidence); anything over 2s here is already
// worth a look regardless of environment.
const SLOW_QUERY_MS = 2000;
function truncateSql(sql) {
  const text = typeof sql === "string" ? sql : sql && sql.sql;
  return text ? text.replace(/\s+/g, " ").trim().slice(0, 200) : "(unknown)";
}
function logSlowQuery(sql, ms) {
  if (ms >= SLOW_QUERY_MS) console.warn(`[db] slow query (${ms}ms): ${truncateSql(sql)}`);
}

// Classifies a raw mysql2 error for logging/response-shaping without ever
// logging bound parameter VALUES (this schema's params are things like
// tote/PID/employee identifiers, not credentials - but per the review's own
// "without exposing... sensitive data" requirement, only the SQL shape
// (truncated, no params) and the driver's own error code/message are
// logged - never the full error.sql mysql2 sometimes attaches, which can
// include literal bound values). Returns the SAME error (never swallowed),
// just logged consistently first.
function classifyAndLog(err, sql, ms) {
  const code = err && (err.code === "DB_ACQUIRE_TIMEOUT" ? "DB_ACQUIRE_TIMEOUT" : err.code);
  console.error(`[db] query failed after ${ms}ms (${code || "UNKNOWN"}): ${truncateSql(sql)} :: ${err.message}`);
  return err;
}

// MySQL error codes worth a transparent retry: a deadlock or lock-wait
// timeout means the transaction was rolled back through no fault of `fn`
// itself - every current caller (createQuery's INSERT+UPDATE-by-id,
// nexsAsrsDumpEngine's bulk insert/pointer swap, syncToCompany) does pure
// DB work with no external side effects inside the transaction, so blindly
// re-running fn from scratch is safe and correct, not just convenient.
const RETRYABLE_ERRNOS = new Set([1213 /* ER_LOCK_DEADLOCK */, 1205 /* ER_LOCK_WAIT_TIMEOUT */]);
// 5, not 3 (2026-09-08, raised after a real deadlock was observed against
// nexsAsrsDumpEngine.js's own ~10s bulk-insert transaction - a legitimately
// long-held transaction is more exposed to a colliding transaction than the
// short single-row writes this retry was originally built for, so it gets a
// couple more attempts; a retry only ever redoes real DB work from a clean
// rolled-back state, so extra attempts cost time on the rare collision,
// never correctness).
const TRANSACTION_MAX_ATTEMPTS = 5;
// Backoff is jittered (2026-09-08, same investigation): two transactions
// that collided once and retry on the SAME fixed schedule (50ms, 100ms, ...)
// are liable to collide again on the next attempt too - a random component
// spreads retries apart so that doesn't repeat in lockstep.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoff = (attempt) => sleep(50 * attempt + Math.floor(Math.random() * 50));

// Runs fn(tx) inside a single MySQL transaction, committing on success and
// rolling back on any thrown error. `tx` exposes the same query/execute
// shape, bound to the transaction's own connection.
//
// BUG FIX (found via a live "debug the whole website" pass, 2026-09-03):
// concurrent createQuery() calls under real load (several Dashboard tiles
// firing their own capability queries at once) hit a genuine MySQL
// "Deadlock found when trying to get lock" (errno 1213) here - previously
// uncaught, surfacing as an unhandled 500 instead of the route's intended
// `{ error: e.message }` JSON body. Retrying the whole transaction a couple
// of times with a short backoff is MySQL's own documented recommendation
// for this class of error.
async function transaction(fn) {
  for (let attempt = 1; attempt <= TRANSACTION_MAX_ATTEMPTS; attempt++) {
    // Database review remediation (2026-09-04): same acquire-timeout
    // guarantee as query()/execute() above, applied to the one other place
    // this module ever calls pool.getConnection() directly. onLateResolve
    // releases the connection if it shows up AFTER this attempt has already
    // given up and thrown - otherwise a slow-but-eventually-successful
    // acquisition would leak a connection that this code never got a chance
    // to release itself.
    const connPromise = pool.getConnection();
    const conn = await withAcquireTimeout(connPromise, { onLateResolve: (c) => c.release() });
    const t0 = Date.now();
    try {
      await conn.beginTransaction();
      const tx = {
        query: async (sql, params = []) => {
          const [rows] = await conn.query(withStatementTimeout(sql), params);
          return rows;
        },
        execute: async (sql, params = []) => {
          const [result] = await conn.execute(withStatementTimeout(sql), params);
          return result;
        },
      };
      const result = await fn(tx);
      await conn.commit();
      logSlowQuery("(transaction)", Date.now() - t0);
      return result;
    } catch (e) {
      await conn.rollback();
      if (RETRYABLE_ERRNOS.has(e.errno) && attempt < TRANSACTION_MAX_ATTEMPTS) {
        await backoff(attempt);
        continue;
      }
      throw classifyAndLog(e, "(transaction)", Date.now() - t0);
    } finally {
      conn.release();
    }
  }
}

async function close() {
  await pool.end();
}

// Current pool state (active/idle/queued connections + lifetime counters) -
// Task 6 observability. See pool.js's stats() for the exact shape/caveats.
function poolStats() {
  return pool.stats();
}

module.exports = { query, execute, transaction, close, poolStats, startWarmPing };
// Pure helpers, exported for direct unit testing (no real DB needed) - see
// server/test/dbTimeouts.test.js. Not part of the module's real public
// surface (business logic never calls these directly), same convention as
// operationLog.js exporting summarizeResults alongside toOperationLogEntry.
module.exports._internal = { withAcquireTimeout, withStatementTimeout, truncateSql, classifyAndLog };
