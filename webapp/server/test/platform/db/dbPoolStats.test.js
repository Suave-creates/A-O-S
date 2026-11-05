// Pure unit test for server/platform/db/pool.js's stats() - Task 6 observability.
// Requiring pool.js creates a real (lazy) mysql2 pool object, but mysql2
// never opens an actual TCP connection until a query is first run - so this
// is still a no-database test: it only asserts on the pool's own initial
// bookkeeping shape, never touches the network.

const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../../../platform/db/pool");

test("stats() reports a freshly-created, never-used pool as having zero active/idle/queued connections", () => {
  const s = pool.stats();
  assert.equal(s.total, 0);
  assert.equal(s.free, 0);
  assert.equal(s.queued, 0);
  assert.equal(typeof s.limit, "number");
  assert.ok(s.limit > 0);
});

test("stats() always includes the lifetime event counters, starting at zero", () => {
  const s = pool.stats();
  assert.equal(s.acquired, 0);
  assert.equal(s.released, 0);
  assert.equal(s.enqueued, 0);
  assert.equal(s.acquireFailures, 0);
});

test("stats() never throws, even if mysql2's internal shape were to change (defensive fallback)", () => {
  const original = pool.pool;
  // Simulate a future mysql2 internal-shape change by breaking the
  // internals stats() reaches into.
  pool.pool = {};
  try {
    const s = pool.stats();
    assert.equal(s.total, null);
    assert.equal(s.free, null);
    assert.equal(s.queued, null);
    assert.equal(typeof s.limit, "number");
  } finally {
    pool.pool = original;
  }
});
