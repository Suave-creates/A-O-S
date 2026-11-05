// Unit tests for server/features/nexs-asrs-dump/nexsAsrsDumpEngine.js - the refresh
// orchestration + canonical current-snapshot, now MySQL-backed via an
// injected fake store/db (no real MySQL, no real Runtime/capability call
// anywhere in this file). The fake store below is a small in-memory model
// of the real two-table generation-swap design, used to prove the
// orchestration wiring (transaction boundaries, pointer-swap timing,
// failure handling, single-flight) is correct independent of real SQL -
// the real SQL itself is covered by server/test/nexsAsrsDumpMysqlStore.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const { refresh, getCurrentSnapshot, getLastAttempt, getStatus, isRunning } = require("../../../features/nexs-asrs-dump/nexsAsrsDumpEngine");

const USER = { id: 1, employeeId: "EMP001", role: "USER" };

function makeFakeQueryManager() {
  const calls = [];
  const registry = new Map();
  return {
    calls,
    async createQuery({ userId, operation, parameters }) {
      calls.push({ fn: "createQuery", userId, operation, parameters });
      return { query_id: "Q-FAKE-1" };
    },
    async markRunning(queryId) { calls.push({ fn: "markRunning", queryId }); },
    async completeQuery(queryId) { calls.push({ fn: "completeQuery", queryId }); },
    async failQuery(queryId, error) { calls.push({ fn: "failQuery", queryId, error }); },
    async timeoutQuery(queryId) { calls.push({ fn: "timeoutQuery", queryId }); },
    async finalizeCancelled(queryId) { calls.push({ fn: "finalizeCancelled", queryId }); },
    registerJob(queryId, controller) {
      const entry = { controller, cancelledByUser: false };
      registry.set(queryId, entry);
      return { signal: controller.signal, wasCancelledByUser: () => entry.cancelledByUser };
    },
    unregisterJob(queryId) { registry.delete(queryId); calls.push({ fn: "unregisterJob", queryId }); },
  };
}

function fakeProvider(result) {
  return { fetchAsrsDump: async () => result };
}
function throwingProvider(err) {
  return { fetchAsrsDump: async () => { throw err; } };
}
// A provider whose fetch only resolves once the test explicitly releases
// it - lets a test observe "still running" mid-flight without permanently
// poisoning the module-level `running` flag for every later test in this
// same process (a truly never-resolving provider would leave `running`
// stuck true forever once fired-and-not-awaited).
function controllableProvider() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return { fetchAsrsDump: async () => { await gate; return { rows: [], rowCount: 0, source: "runtime_apps_script" }; }, release: () => release() };
}

// A small in-memory model of the real two-table generation-swap store -
// same public shape as server/features/nexs-asrs-dump/nexsAsrsDumpMysqlStore.js, so the engine
// code under test is exercised exactly as it would be against real SQL,
// just without a real database.
function makeFakeStore() {
  const refreshes = new Map();
  const rowsByRefresh = new Map();
  let nextId = 1;
  let currentId = null;
  const calls = [];

  return {
    calls,
    async createRefresh({ queryId, refreshedBy }) {
      const id = nextId++;
      refreshes.set(id, { id, status: "RUNNING", query_id: queryId, refreshed_by_employee_id: refreshedBy != null ? USER.employeeId : null });
      rowsByRefresh.set(id, []);
      calls.push({ fn: "createRefresh", id });
      return id;
    },
    async bulkInsertRows(refreshId, rows) {
      calls.push({ fn: "bulkInsertRows", refreshId, count: rows.length });
      rowsByRefresh.set(
        refreshId,
        rows.map((r) => ({
          pid: r.pid, tote_id: r.toteId, partition_code: r.partition, barcode_count: r.barcodeCount,
          location: r.location, last_updated_at: r.lastUpdatedAt, ingested_at: r.ingestedAt,
        }))
      );
    },
    async markCompleted(refreshId, fields) {
      calls.push({ fn: "markCompleted", refreshId });
      Object.assign(refreshes.get(refreshId), {
        status: "COMPLETED", row_count: fields.rowCount, total_barcode_count: fields.totalBarcodeCount,
        source: fields.source, latest_ingested_at: fields.latestIngestedAt, latest_updated_at: fields.latestUpdatedAt,
        completed_at: new Date(2026, 0, 1).toISOString(),
      });
    },
    async markFailed(refreshId, error) {
      calls.push({ fn: "markFailed", refreshId, error });
      const r = refreshes.get(refreshId);
      if (r) Object.assign(r, { status: "FAILED", error, completed_at: new Date(2026, 0, 1).toISOString() });
    },
    async swapCurrent(refreshId) {
      calls.push({ fn: "swapCurrent", refreshId });
      currentId = refreshId;
    },
    async getCurrentMeta() {
      return currentId == null ? null : { ...refreshes.get(currentId) };
    },
    async getLatestAttemptMeta() {
      const concluded = [...refreshes.values()].filter((r) => r.status === "COMPLETED" || r.status === "FAILED");
      return concluded.length ? { ...concluded[concluded.length - 1] } : null;
    },
    async getRowsForRefresh(refreshId) {
      return rowsByRefresh.get(refreshId) || [];
    },
    async reconcileStaleRunning() {
      calls.push({ fn: "reconcileStaleRunning" });
      for (const r of refreshes.values()) {
        if (r.status === "RUNNING") Object.assign(r, { status: "FAILED", error: "Backend restarted before this refresh finished" });
      }
    },
    async cleanupOldGenerations(keep) {
      calls.push({ fn: "cleanupOldGenerations", keep });
      return { deletedGenerations: [] };
    },
  };
}

function makeFakeDb({ failInTransaction } = {}) {
  return {
    async transaction(fn) {
      if (failInTransaction) throw failInTransaction === true ? new Error("simulated MySQL insertion failure") : failInTransaction;
      return fn({});
    },
  };
}

const SAMPLE_ROW = { pid: "1", toteId: "TS0000000001", partition: "PR1", barcodeCount: 5, location: "NXS1-ASRS-TS0000000001_PR1", lastUpdatedAt: null, ingestedAt: null };

test("A: successful refresh creates a generation - createRefresh -> bulkInsertRows -> markCompleted -> swapCurrent -> completeQuery", async () => {
  const qm = makeFakeQueryManager();
  const store = makeFakeStore();
  const db = makeFakeDb();
  const provider = fakeProvider({ rows: [SAMPLE_ROW], rowCount: 1, source: "runtime_apps_script" });

  await refresh("Q-TEST-1", USER, { queryManager: qm, provider, db, store });

  assert.deepEqual(qm.calls.map((c) => c.fn), ["markRunning", "completeQuery", "unregisterJob"]);
  assert.deepEqual(store.calls.map((c) => c.fn), ["reconcileStaleRunning", "createRefresh", "bulkInsertRows", "markCompleted", "swapCurrent", "cleanupOldGenerations"]);
});

test("B: rows are associated with the correct refresh_id", async () => {
  const qm = makeFakeQueryManager();
  const store = makeFakeStore();
  const db = makeFakeDb();
  const provider = fakeProvider({ rows: [SAMPLE_ROW], rowCount: 1, source: "runtime_apps_script" });

  await refresh("Q-TEST-2", USER, { queryManager: qm, provider, db, store });

  const insertCall = store.calls.find((c) => c.fn === "bulkInsertRows");
  const createCall = store.calls.find((c) => c.fn === "createRefresh");
  assert.equal(insertCall.refreshId, createCall.id);
});

test("C: the current pointer changes only after successful completion - swapCurrent happens after markCompleted, never before", async () => {
  const qm = makeFakeQueryManager();
  const store = makeFakeStore();
  const db = makeFakeDb();
  const provider = fakeProvider({ rows: [SAMPLE_ROW], rowCount: 1, source: "runtime_apps_script" });

  await refresh("Q-TEST-3", USER, { queryManager: qm, provider, db, store });

  const order = store.calls.map((c) => c.fn);
  assert.ok(order.indexOf("markCompleted") < order.indexOf("swapCurrent"));

  const snapshot = await getCurrentSnapshot({ store });
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].pid, "1");
});

test("D: a failed provider call leaves the previous snapshot untouched - current pointer never moves", async () => {
  const qm = makeFakeQueryManager();
  const store = makeFakeStore();
  const db = makeFakeDb();

  // Seed a known-good generation first.
  await refresh("Q-SEED", USER, { queryManager: qm, provider: fakeProvider({ rows: [SAMPLE_ROW], rowCount: 1, source: "runtime_apps_script" }), db, store });
  const before = await getCurrentSnapshot({ store });

  await refresh("Q-TEST-4", USER, { queryManager: qm, provider: throwingProvider(new Error("Apps Script request failed")), db, store });

  const failCall = qm.calls.find((c) => c.fn === "failQuery" && c.queryId === "Q-TEST-4");
  assert.ok(failCall);
  assert.match(failCall.error, /Apps Script request failed/);
  const after = await getCurrentSnapshot({ store });
  assert.deepEqual(after, before, "a failed refresh must never overwrite the last good snapshot");
});

test("E: a failed batch insert (MySQL transaction throws) rolls back the new generation and never swaps the pointer", async () => {
  const qm = makeFakeQueryManager();
  const store = makeFakeStore();
  const db = makeFakeDb({ failInTransaction: true });

  await refresh("Q-SEED-2", USER, { queryManager: qm, provider: fakeProvider({ rows: [SAMPLE_ROW], rowCount: 1, source: "runtime_apps_script" }), db: makeFakeDb(), store });
  const before = await getCurrentSnapshot({ store });

  await refresh("Q-TEST-5", USER, { queryManager: qm, provider: fakeProvider({ rows: [SAMPLE_ROW], rowCount: 1, source: "runtime_apps_script" }), db, store });

  const failCall = qm.calls.find((c) => c.fn === "failQuery" && c.queryId === "Q-TEST-5");
  assert.ok(failCall);
  assert.match(failCall.error, /simulated MySQL insertion failure/);
  const after = await getCurrentSnapshot({ store });
  assert.deepEqual(after, before, "the previous generation must remain current after a failed insert");
  assert.ok(store.calls.some((c) => c.fn === "markFailed"), "the refresh row must still be marked FAILED even though the transaction rolled back");
});

test("F: getCurrentSnapshot/getLastAttempt/getStatus read purely from the store - no fetch is ever triggered by a read", async () => {
  const store = makeFakeStore();
  let fetchCalled = false;
  const qm = makeFakeQueryManager();
  const provider = { fetchAsrsDump: async () => { fetchCalled = true; return { rows: [SAMPLE_ROW], rowCount: 1, source: "runtime_apps_script" }; } };
  await refresh("Q-TEST-6", USER, { queryManager: qm, provider, db: makeFakeDb(), store });
  fetchCalled = false;

  await getCurrentSnapshot({ store });
  await getLastAttempt({ store });
  await getStatus({ store });
  assert.equal(fetchCalled, false, "reading status/snapshot must never itself trigger a fetch");
});

test("getCurrentSnapshot returns null / getStatus is NO_SNAPSHOT before any refresh has ever completed", async () => {
  const store = makeFakeStore();
  assert.equal(await getCurrentSnapshot({ store }), null);
  assert.equal(await getStatus({ store }), "NO_SNAPSHOT");
  assert.equal(await getLastAttempt({ store }), null);
});

test("status lifecycle: CURRENT after success, STALE_PREVIOUS after a subsequent failure (old snapshot preserved)", async () => {
  const qm = makeFakeQueryManager();
  const store = makeFakeStore();
  const db = makeFakeDb();

  await refresh("Q-OK-1", USER, { queryManager: qm, provider: fakeProvider({ rows: [SAMPLE_ROW], rowCount: 1, source: "runtime_apps_script" }), db, store });
  assert.equal(await getStatus({ store }), "CURRENT");
  const goodSnapshot = await getCurrentSnapshot({ store });

  await refresh("Q-FAIL-1", USER, { queryManager: qm, provider: throwingProvider(new Error("Apps Script HTTP 500")), db, store });
  assert.equal(await getStatus({ store }), "STALE_PREVIOUS");
  assert.deepEqual(await getCurrentSnapshot({ store }), goodSnapshot);
  const attempt = await getLastAttempt({ store });
  assert.equal(attempt.ok, false);
  assert.match(attempt.reason, /HTTP 500/);
});

test("timeout: an AbortError/TimeoutError not caused by the user is reported via timeoutQuery, never failQuery, and the refresh row is still marked FAILED", async () => {
  const qm = makeFakeQueryManager();
  const store = makeFakeStore();
  const timeoutErr = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  await refresh("Q-TEST-7", USER, { queryManager: qm, provider: throwingProvider(timeoutErr), db: makeFakeDb(), store });
  assert.ok(qm.calls.some((c) => c.fn === "timeoutQuery"));
  assert.ok(!qm.calls.some((c) => c.fn === "failQuery"));
  assert.ok(store.calls.some((c) => c.fn === "markFailed"));
});

test("K: concurrent refresh() calls are rejected - a second call while one is in flight fails immediately without touching the store", async () => {
  const qm = makeFakeQueryManager();
  const store = makeFakeStore();
  const db = makeFakeDb();
  const gated = controllableProvider();

  const first = refresh("Q-CONC-1", USER, { queryManager: qm, provider: gated, db, store });
  assert.equal(isRunning(), true);

  await refresh("Q-CONC-2", USER, { queryManager: qm, provider: fakeProvider({ rows: [], rowCount: 0, source: "runtime_apps_script" }), db, store });

  const secondFail = qm.calls.find((c) => c.fn === "failQuery" && c.queryId === "Q-CONC-2");
  assert.ok(secondFail);
  assert.match(secondFail.error, /already in progress/);
  assert.equal(store.calls.filter((c) => c.fn === "createRefresh").length, 1, "the rejected second call must never create a refresh row of its own");

  // Release the first (gated) refresh and wait for it to actually finish,
  // so `running` (module-level, shared across every test in this process)
  // is guaranteed reset to false before the next test runs.
  gated.release();
  await first;
  assert.equal(isRunning(), false);
});

test("cleanup failure never turns a successful refresh into a reported failure", async () => {
  const qm = makeFakeQueryManager();
  const store = makeFakeStore();
  store.cleanupOldGenerations = async () => { throw new Error("cleanup boom"); };
  const db = makeFakeDb();

  await refresh("Q-TEST-8", USER, { queryManager: qm, provider: fakeProvider({ rows: [SAMPLE_ROW], rowCount: 1, source: "runtime_apps_script" }), db, store });

  // Give the fire-and-forget cleanup promise a tick to reject/settle.
  await new Promise((r) => setImmediate(r));
  assert.ok(qm.calls.some((c) => c.fn === "completeQuery"), "the refresh itself must still be reported COMPLETED");
  assert.ok(!qm.calls.some((c) => c.fn === "failQuery"));
});
