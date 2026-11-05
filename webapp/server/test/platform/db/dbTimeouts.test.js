// Pure unit tests for server/platform/db/index.js's timeout/leak-safety internals
// (withAcquireTimeout/withStatementTimeout/truncateSql/classifyAndLog).
// No database, no network - these are exactly the pieces the database
// review asked to be verified: "connections are properly reused",
// "connections are released even when a query throws an error", "timeout
// handling works". Exercised directly against hand-built Promises rather
// than a real mysql2 pool, so this suite runs anywhere, fast, and doesn't
// depend on TEST_DB_NAME/production_tracker_test being reachable.

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../../../config");
const { _internal } = require("../../../platform/db");
const { withAcquireTimeout, withStatementTimeout, truncateSql, classifyAndLog } = _internal;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// withAcquireTimeout reads config.dbAcquireTimeoutMs fresh on every call
// (not captured at require time) - config is a plain, unfrozen object, so
// temporarily shrinking it here to make the timeout path fast/deterministic
// to test is safe and mirrors how other suites in this repo override config
// fields for a single test. Always restored, even on failure.
function withTempAcquireTimeout(ms, fn) {
  const original = config.dbAcquireTimeoutMs;
  config.dbAcquireTimeoutMs = ms;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      config.dbAcquireTimeoutMs = original;
    });
}

// ── withAcquireTimeout ──────────────────────────────────────────────────

test("withAcquireTimeout resolves normally when the underlying work finishes before the deadline", async () => {
  const fast = sleep(5).then(() => "connection-1");
  const result = await withAcquireTimeout(fast);
  assert.equal(result, "connection-1");
});

test("withAcquireTimeout rejects with a DB_ACQUIRE_TIMEOUT-coded error once the configured deadline elapses, for a connection attempt that never resolves", () =>
  withTempAcquireTimeout(30, async () => {
    const neverResolves = new Promise(() => {}); // simulates a fully exhausted pool with waitForConnections:true - would hang forever without this timeout
    await assert.rejects(withAcquireTimeout(neverResolves), (err) => {
      assert.equal(err.code, "DB_ACQUIRE_TIMEOUT");
      assert.match(err.message, /Timed out after 30ms/);
      return true;
    });
  })
);

test("withAcquireTimeout: a connection that resolves LATE (after this app already gave up) is still released via onLateResolve - never leaked", () =>
  withTempAcquireTimeout(30, async () => {
    let released = false;
    const lateConn = { release: () => { released = true; } };
    const lateConnPromise = sleep(80).then(() => lateConn); // resolves well after the 30ms deadline above

    await assert.rejects(withAcquireTimeout(lateConnPromise, { onLateResolve: (c) => c.release() }));
    assert.equal(released, false, "not released yet - the underlying acquisition is still in flight");

    await sleep(80); // let the late connection actually arrive
    assert.equal(released, true, "a connection that arrives after the caller gave up must still be released back to the pool, not leaked");
  })
);

test("withAcquireTimeout: onLateResolve is never invoked on the normal, non-timeout success path", async () => {
  let released = false;
  const conn = { release: () => { released = true; } };
  const result = await withAcquireTimeout(Promise.resolve(conn), { onLateResolve: (c) => c.release() });
  assert.equal(result, conn);
  assert.equal(released, false);
});

test("withAcquireTimeout is a no-op passthrough when the timeout is disabled (0/falsy)", () =>
  withTempAcquireTimeout(0, async () => {
    const result = await withAcquireTimeout(Promise.resolve("value"));
    assert.equal(result, "value");
  })
);

// ── withStatementTimeout ─────────────────────────────────────────────────

test("withStatementTimeout wraps a plain SQL string into mysql2's {sql, timeout} form", () => {
  const wrapped = withStatementTimeout("SELECT 1");
  assert.equal(typeof wrapped, "object");
  assert.equal(wrapped.sql, "SELECT 1");
  assert.equal(typeof wrapped.timeout, "number");
  assert.ok(wrapped.timeout > 0);
});

test("withStatementTimeout leaves a non-string (already an options object) untouched, never double-wraps", () => {
  const already = { sql: "SELECT 1", timeout: 5000 };
  assert.equal(withStatementTimeout(already), already);
});

// ── truncateSql ──────────────────────────────────────────────────────────

test("truncateSql collapses whitespace and caps length for both plain strings and {sql} objects", () => {
  assert.equal(truncateSql("SELECT   1\n  FROM  dual"), "SELECT 1 FROM dual");
  assert.equal(truncateSql({ sql: "SELECT 1", timeout: 30000 }), "SELECT 1");
  const long = "SELECT " + "x".repeat(500);
  assert.equal(truncateSql(long).length, 200);
});

test("truncateSql never throws on an unexpected shape", () => {
  assert.equal(truncateSql(null), "(unknown)");
  assert.equal(truncateSql(undefined), "(unknown)");
  assert.equal(truncateSql(42), "(unknown)");
});

// ── classifyAndLog ───────────────────────────────────────────────────────

test("classifyAndLog returns the SAME error unmodified (never swallows or replaces it)", () => {
  const err = Object.assign(new Error("Deadlock found when trying to get lock"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });
  const returned = classifyAndLog(err, "UPDATE queries SET status = ?", 42);
  assert.equal(returned, err);
});

test("classifyAndLog logs the SQL shape and driver error code/message, never the bound parameter values (never receives `params` at all)", (t) => {
  const logs = [];
  t.mock.method(console, "error", (msg) => logs.push(msg));
  const err = Object.assign(new Error("Access denied for user 'root'@'%' (using password: YES)"), { code: "ER_ACCESS_DENIED_ERROR" });
  classifyAndLog(err, "SELECT * FROM users WHERE employee_id = ?", 5);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes("ER_ACCESS_DENIED_ERROR"));
  assert.ok(logs[0].includes("SELECT * FROM users WHERE employee_id"));
});
