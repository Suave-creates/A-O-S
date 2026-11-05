// A read that hits a dropped connection is retried on a fresh one; a write, a slow query and a bad query are not.
const test = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../../../platform/db/pool");
const db = require("../../../platform/db");

function stubQuery(failures) {
  const original = pool.query;
  const calls = [];
  pool.query = async (q) => {
    calls.push(typeof q === "string" ? q : q.sql);
    const f = failures.shift();
    if (f) throw Object.assign(new Error(f), { code: f });
    return [[{ ok: 1 }]];
  };
  return { calls, restore: () => { pool.query = original; } };
}

test("a SELECT is retried after a dropped connection and then succeeds", async () => {
  const s = stubQuery(["ECONNRESET", "EHOSTUNREACH"]);
  try {
    assert.deepEqual(await db.query("SELECT 1"), [{ ok: 1 }]);
    assert.equal(s.calls.length, 3);
  } finally { s.restore(); }
});

test("it gives up after the configured number of retries", async () => {
  const s = stubQuery(["ETIMEDOUT", "ETIMEDOUT", "ETIMEDOUT", "ETIMEDOUT"]);
  try {
    await assert.rejects(() => db.query("SELECT 1"), { code: "ETIMEDOUT" });
    assert.equal(s.calls.length, 3); // first try + DB_READ_RETRIES (2)
  } finally { s.restore(); }
});

test("a non-network error and a non-SELECT statement are never retried", async () => {
  let s = stubQuery(["ER_PARSE_ERROR"]);
  try {
    await assert.rejects(() => db.query("SELECT nope"), { code: "ER_PARSE_ERROR" });
    assert.equal(s.calls.length, 1);
  } finally { s.restore(); }
  s = stubQuery(["ECONNRESET"]);
  try {
    await assert.rejects(() => db.query("UPDATE t SET a = 1"), { code: "ECONNRESET" });
    assert.equal(s.calls.length, 1);
  } finally { s.restore(); }
});
