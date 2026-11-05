// Pure unit tests for server/platform/http/shutdown.js's gracefulShutdown() - no real
// HTTP server, WebSocket server, or database. This is the actual fix for
// the database review's core finding (orphaned Sleep connections from
// restarts that never called pool.end()) - so its one non-negotiable
// guarantee, closeDb() always being called exactly once no matter which
// path shutdown takes, is exercised directly here against fakes.

const test = require("node:test");
const assert = require("node:assert/strict");
const { gracefulShutdown } = require("../../../platform/http/shutdown");

function silentLoggers() {
  return { log: () => {}, warn: () => {} };
}

test("happy path: drains the HTTP server, then closes the DB pool exactly once, and resolves true", async () => {
  let dbCloseCalls = 0;
  const httpServer = { close: (cb) => setImmediate(() => cb()) };
  const closeDb = async () => { dbCloseCalls++; };

  const drainedCleanly = await gracefulShutdown({ httpServer, closeDb, ...silentLoggers() });

  assert.equal(drainedCleanly, true);
  assert.equal(dbCloseCalls, 1);
});

test("forced path: if the HTTP server never drains (httpServer.close never calls back), the DB pool is STILL closed once the force-exit timer fires", async () => {
  let dbCloseCalls = 0;
  const httpServer = { close: () => {} }; // deliberately never invokes its callback - simulates a stuck keep-alive connection
  const closeDb = async () => { dbCloseCalls++; };

  const drainedCleanly = await gracefulShutdown({ httpServer, closeDb, forceExitMs: 20, ...silentLoggers() });

  assert.equal(drainedCleanly, false, "the forced path must report it did NOT drain cleanly");
  assert.equal(dbCloseCalls, 1, "the whole point of the force-exit timer is worthless if it doesn't still close the pool");
});

test("closeDb is called exactly once even if the HTTP server callback races the force timer (never double-closed)", async () => {
  let dbCloseCalls = 0;
  // Calls back right around the same time the (very short) force timer
  // would also fire - exercises the dbClosed guard against a real race.
  const httpServer = { close: (cb) => setTimeout(cb, 15) };
  const closeDb = async () => { dbCloseCalls++; };

  await gracefulShutdown({ httpServer, closeDb, forceExitMs: 15, ...silentLoggers() });
  // Give any second, erroneous closeDb() call a chance to have fired.
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(dbCloseCalls, 1);
});

test("a closeDb() that throws/rejects is caught - shutdown still resolves rather than crashing the process mid-exit", async () => {
  const httpServer = { close: (cb) => setImmediate(() => cb()) };
  const closeDb = async () => { throw new Error("pool.end() failed"); };

  const warnings = [];
  const drainedCleanly = await gracefulShutdown({ httpServer, closeDb, log: () => {}, warn: (...a) => warnings.push(a.join(" ")) });

  assert.equal(drainedCleanly, true, "the HTTP server itself still drained cleanly - only the DB close step failed");
  assert.ok(warnings.some((w) => w.includes("pool.end() failed")), "the failure must be logged, not silently swallowed");
});

test("an httpServer.close(cb) that itself reports an error still proceeds to close the DB pool", async () => {
  let dbCloseCalls = 0;
  const httpServer = { close: (cb) => setImmediate(() => cb(new Error("ERR_SERVER_NOT_RUNNING"))) };
  const closeDb = async () => { dbCloseCalls++; };

  const drainedCleanly = await gracefulShutdown({ httpServer, closeDb, ...silentLoggers() });
  assert.equal(drainedCleanly, true);
  assert.equal(dbCloseCalls, 1);
});
