// Unit tests for server/features/locked-tote-info/classificationEngine.js - the Locked Tote
// Information refresh lifecycle (LOCKED_TOTE_INFO_REFRESH). qm/db/
// requestCapability/wait/getResult/touchLockedSince are all injected fakes
// - no real capability dispatch, no runtime, no network, no real MySQL
// call anywhere in this file.

const test = require("node:test");
const assert = require("node:assert/strict");
const classificationEngine = require("../../../features/locked-tote-info/classificationEngine");
const lockedSinceTracker = require("../../../features/locked-tote-info/lockedSinceTracker");

const USER = { id: 1, employeeId: "EMP001", role: "USER" };

function makeFakeQueryManager() {
  const calls = [];
  return {
    calls,
    async markRunning(queryId) {
      calls.push({ fn: "markRunning", queryId });
    },
    async completeQuery(queryId) {
      calls.push({ fn: "completeQuery", queryId });
    },
    async failQuery(queryId, error) {
      calls.push({ fn: "failQuery", queryId, error });
    },
    registerJob(queryId, controller) {
      calls.push({ fn: "registerJob", queryId });
      return { signal: controller.signal, wasCancelledByUser: () => false };
    },
    unregisterJob(queryId) {
      calls.push({ fn: "unregisterJob", queryId });
    },
  };
}

function makeFakeDb() {
  const inserts = [];
  const rows = []; // [{query_id, result_json, row_count, created_at}], newest last
  return {
    inserts,
    rows,
    async execute(sql, params) {
      if (/INSERT INTO locked_tote_snapshots/.test(sql)) {
        const [query_id, result_json, row_count, created_at] = params;
        inserts.push({ query_id, result_json, row_count, created_at });
        rows.push({ id: rows.length + 1, query_id, result_json, row_count, created_at });
      }
      return { insertId: rows.length };
    },
    async query(sql, params) {
      if (/ORDER BY id DESC LIMIT 1/.test(sql) && /locked_tote_snapshots/.test(sql)) {
        return rows.length ? [rows[rows.length - 1]] : [];
      }
      if (/WHERE query_id = \?/.test(sql)) {
        const match = rows.find((r) => r.query_id === params[0]);
        return match ? [match] : [];
      }
      return [];
    },
  };
}

// Builds a fake requestCapability/wait/getResult triple. `sources` maps
// capabilityName -> either an array of rows (success) or an Error
// (dispatch/terminal failure), letting a test simulate one source failing
// independently of the others.
function fakeCapabilities(sources) {
  const results = new Map(); // queryId -> rows
  let counter = 0;

  const requestCapability = async ({ capabilityName }) => {
    const outcome = sources[capabilityName];
    if (outcome instanceof Error) {
      return { ok: false, code: 502, reason: outcome.message };
    }
    counter++;
    const queryId = `Q-FAKE-${counter}`;
    results.set(queryId, outcome || []);
    return { ok: true, query: { query_id: queryId, status: "RUNNING" } };
  };

  const wait = async (queryId) => ({ query_id: queryId, status: "COMPLETED" });
  const getResult = (queryId) => ({ rows: results.get(queryId) || [] });

  return { requestCapability, wait, getResult };
}

// Quadron inventory rows holding stock for these totes - a locked tote counts only when Quadron confirms it.
const stocked = (...ids) => ids.map((toteId) => ({ toteId, quadronQty: 5, partitions: [] }));

// A fresh, in-memory-only "Locked Since" store per call - reuses the real
// lockedSinceTracker.js (not a reimplementation), backed by a plain Map
// instead of MySQL, matching how classificationTimestamps.js itself
// delegates to the same pure functions in production.
function makeTouchLockedSince() {
  const store = new Map();
  return async (toteIds, seenAtIso) => lockedSinceTracker.touchMany(store, toteIds, seenAtIso);
}

test("a full successful refresh classifies, persists to MySQL, and becomes the current snapshot", async () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  const { requestCapability, wait, getResult } = fakeCapabilities({
    GET_GRAFANA_LOCKED_TOTES: [{ toteId: "TS0000000001", zone: "5" }],
    GET_GRAFANA_SUPERVISOR_DUMP: [],
    GET_QUADRON_INVENTORY: stocked("TS0000000001", "TS0000000002"),
  });
  const snapshot = await classificationEngine.refresh({ queryId: "Q-1", user: USER, requestCapability, wait, getResult, touchLockedSince: makeTouchLockedSince(), qm, db });
  assert.equal(snapshot.totes.length, 1);
  assert.equal(snapshot.totes[0].priority, "P2");
  assert.equal(snapshot.degraded.supervisor, false);
  assert.equal(snapshot.degraded.inventory, false);
  assert.equal(snapshot.refreshedBy, "EMP001");
  assert.equal(snapshot.queryId, "Q-1");
  assert.deepEqual(qm.calls.map((c) => c.fn), ["registerJob", "markRunning", "completeQuery", "unregisterJob"]);
  assert.equal(db.inserts.length, 1);
  assert.equal(db.inserts[0].query_id, "Q-1");

  const current = await classificationEngine.getCurrentSnapshot({ db });
  assert.deepEqual(current, snapshot);
});

test("Locked Dump failure aborts the refresh, fails the query, and does NOT persist anything or touch the previous current snapshot", async () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  // First, establish a real current snapshot.
  const good = fakeCapabilities({ GET_GRAFANA_LOCKED_TOTES: [{ toteId: "TS0000000001" }], GET_GRAFANA_SUPERVISOR_DUMP: [], GET_QUADRON_INVENTORY: stocked("TS0000000001", "TS0000000002") });
  const previous = await classificationEngine.refresh({ queryId: "Q-GOOD", user: USER, requestCapability: good.requestCapability, wait: good.wait, getResult: good.getResult, touchLockedSince: makeTouchLockedSince(), qm, db });

  const bad = fakeCapabilities({
    GET_GRAFANA_LOCKED_TOTES: new Error("No online runtime"),
    GET_GRAFANA_SUPERVISOR_DUMP: [],
    GET_QUADRON_INVENTORY: stocked("TS0000000001", "TS0000000002"),
  });
  await assert.rejects(
    () => classificationEngine.refresh({ queryId: "Q-BAD", user: USER, requestCapability: bad.requestCapability, wait: bad.wait, getResult: bad.getResult, touchLockedSince: makeTouchLockedSince(), qm, db }),
    /Locked Tote Dump unavailable/
  );
  const failCall = qm.calls.find((c) => c.fn === "failQuery" && c.queryId === "Q-BAD");
  assert.ok(failCall);
  assert.equal(db.inserts.length, 1, "the failed refresh must never insert a row");

  const current = await classificationEngine.getCurrentSnapshot({ db });
  assert.deepEqual(current, previous, "the previous snapshot must remain current after a failed refresh");
});

test("Supervisor Dump failure degrades gracefully - refresh still succeeds, SD classification just unavailable", async () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  const { requestCapability, wait, getResult } = fakeCapabilities({
    GET_GRAFANA_LOCKED_TOTES: [{ toteId: "TS0000000001" }],
    GET_GRAFANA_SUPERVISOR_DUMP: new Error("Grafana tab not open"),
    GET_QUADRON_INVENTORY: stocked("TS0000000001", "TS0000000002"),
  });
  const snapshot = await classificationEngine.refresh({ queryId: "Q-2", user: USER, requestCapability, wait, getResult, touchLockedSince: makeTouchLockedSince(), qm, db });
  assert.equal(snapshot.degraded.supervisor, true);
  assert.match(snapshot.degradedReasons.supervisor, /Grafana tab not open/);
  assert.equal(snapshot.degraded.inventory, false);
  assert.equal(snapshot.totes[0].priority, "P2"); // no SD possible without supervisor data
  assert.ok(qm.calls.some((c) => c.fn === "completeQuery"), "a degraded-but-successful refresh still completes the query, never fails it");
});

test("Quadron Inventory failure fails the refresh and keeps the last snapshot - locked totes are counted from Quadron only", async () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  const good = fakeCapabilities({ GET_GRAFANA_LOCKED_TOTES: [{ toteId: "TS0000000001" }], GET_GRAFANA_SUPERVISOR_DUMP: [], GET_QUADRON_INVENTORY: stocked("TS0000000001") });
  const previous = await classificationEngine.refresh({ queryId: "Q-3A", user: USER, requestCapability: good.requestCapability, wait: good.wait, getResult: good.getResult, touchLockedSince: makeTouchLockedSince(), qm, db });
  const bad = fakeCapabilities({ GET_GRAFANA_LOCKED_TOTES: [{ toteId: "TS0000000001" }], GET_GRAFANA_SUPERVISOR_DUMP: [], GET_QUADRON_INVENTORY: new Error("No Concinity tab open") });
  await assert.rejects(
    () => classificationEngine.refresh({ queryId: "Q-3B", user: USER, requestCapability: bad.requestCapability, wait: bad.wait, getResult: bad.getResult, touchLockedSince: makeTouchLockedSince(), qm, db }),
    /Quadron Inventory unavailable/
  );
  assert.ok(qm.calls.some((c) => c.fn === "failQuery" && c.queryId === "Q-3B"));
  assert.deepEqual(await classificationEngine.getCurrentSnapshot({ db }), previous);
});

test("only totes Quadron holds with stock are counted; missing or empty ones are kept apart as unconfirmed", async () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  const { requestCapability, wait, getResult } = fakeCapabilities({
    GET_GRAFANA_LOCKED_TOTES: [{ toteId: "TS0000000001" }, { toteId: "TS0000000002" }, { toteId: "TS0000000003" }],
    GET_GRAFANA_SUPERVISOR_DUMP: [{ toteId: "TS0000000003" }],
    GET_QUADRON_INVENTORY: [{ toteId: "TS0000000001", quadronQty: 4, partitions: [] }, { toteId: "TS0000000002", quadronQty: 0, partitions: [] }],
  });
  const snapshot = await classificationEngine.refresh({ queryId: "Q-QC", user: USER, requestCapability, wait, getResult, touchLockedSince: makeTouchLockedSince(), qm, db });
  assert.deepEqual(snapshot.totes.map((t) => [t.toteId, t.quadronVerdict, t.quadronQty]), [["TS0000000001", "MATCH", 4]]);
  assert.deepEqual(snapshot.unconfirmed.map((t) => [t.toteId, t.quadronVerdict]).sort(), [["TS0000000002", "EMPTY_IN_QUADRON"], ["TS0000000003", "MISSING_IN_QUADRON"]]);
  assert.equal(snapshot.summary.total, 1);
  assert.equal(snapshot.summary.sdCount, 0, "a supervisor tote Quadron does not hold is not counted");
  assert.equal(snapshot.summary.unconfirmedCount, 2);
  assert.equal(snapshot.summary.lockedCount, 3, "lockedCount stays the raw Locked Tote Dump size");
  assert.ok(snapshot.unconfirmed.every((t) => t.lockedSince), "unconfirmed totes still get a lockedSince");
});

test("a terminal but non-COMPLETED status (e.g. TIMEOUT) is treated as that source failing, not as an unhandled rejection", async () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  const requestCapability = async ({ capabilityName }) => ({ ok: true, query: { query_id: `Q-${capabilityName}`, status: "RUNNING" } });
  const wait = async (queryId) => (queryId.includes("SUPERVISOR") ? { query_id: queryId, status: "TIMEOUT" } : { query_id: queryId, status: "COMPLETED" });
  const getResult = () => ({ rows: [{ toteId: "TS0000000001" }] });
  const snapshot = await classificationEngine.refresh({ queryId: "Q-4", user: USER, requestCapability, wait, getResult, touchLockedSince: makeTouchLockedSince(), qm, db });
  assert.equal(snapshot.degraded.supervisor, true);
  assert.match(snapshot.degradedReasons.supervisor, /TIMEOUT/);
});

test("summary counts in the returned snapshot match the sum of its own totes[].priority tallies, and totalInventory sums totalToteInv", async () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  const { requestCapability, wait, getResult } = fakeCapabilities({
    GET_GRAFANA_LOCKED_TOTES: [{ toteId: "TS0000000001" }, { toteId: "TS0000000002" }],
    GET_GRAFANA_SUPERVISOR_DUMP: [{ toteId: "TS0000000001" }],
    GET_QUADRON_INVENTORY: [{ toteId: "TS0000000002", quadronQty: 7, partitions: [] }],
  });
  const snapshot = await classificationEngine.refresh({ queryId: "Q-5", user: USER, requestCapability, wait, getResult, touchLockedSince: makeTouchLockedSince(), qm, db });
  const tally = { SD: 0, P0: 0, P1: 0, P2: 0 };
  for (const t of snapshot.totes) tally[t.priority]++;
  assert.equal(snapshot.summary.sdCount, tally.SD);
  assert.equal(snapshot.summary.p2Count, tally.P2);
  assert.equal(snapshot.summary.totalInventory, 7, "totalInventory must sum only the totes with a real (non-null) totalToteInv");
});

test("a refresh wholesale replaces the previous snapshot rather than merging with it", async () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  const first = fakeCapabilities({ GET_GRAFANA_LOCKED_TOTES: [{ toteId: "TS0000000001" }], GET_GRAFANA_SUPERVISOR_DUMP: [], GET_QUADRON_INVENTORY: stocked("TS0000000001", "TS0000000002") });
  await classificationEngine.refresh({ queryId: "Q-6A", user: USER, requestCapability: first.requestCapability, wait: first.wait, getResult: first.getResult, touchLockedSince: makeTouchLockedSince(), qm, db });

  const second = fakeCapabilities({ GET_GRAFANA_LOCKED_TOTES: [{ toteId: "TS0000000002" }], GET_GRAFANA_SUPERVISOR_DUMP: [], GET_QUADRON_INVENTORY: stocked("TS0000000001", "TS0000000002") });
  const snapshot2 = await classificationEngine.refresh({ queryId: "Q-6B", user: USER, requestCapability: second.requestCapability, wait: second.wait, getResult: second.getResult, touchLockedSince: makeTouchLockedSince(), qm, db });

  assert.equal(snapshot2.totes.length, 1);
  assert.equal(snapshot2.totes[0].toteId, "TS0000000002");
  const current = await classificationEngine.getCurrentSnapshot({ db });
  assert.equal(current.totes.length, 1, "TS0000000001 from the first refresh must not linger");
});

test("registerJob is called synchronously, before any await - a caller re-reading query status immediately after firing refresh() must see a registry entry already present", () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  const { requestCapability, wait, getResult } = fakeCapabilities({ GET_GRAFANA_LOCKED_TOTES: [{ toteId: "TS0000000001" }], GET_GRAFANA_SUPERVISOR_DUMP: [], GET_QUADRON_INVENTORY: stocked("TS0000000001", "TS0000000002") });
  const p = classificationEngine.refresh({ queryId: "Q-SYNC", user: USER, requestCapability, wait, getResult, touchLockedSince: makeTouchLockedSince(), qm, db });
  assert.equal(qm.calls[0].fn, "registerJob", "registerJob must be the very first call, synchronously, before any await");
  return p; // let the background work finish before the next test runs
});

test("getResult(queryId) returns one specific past run's full snapshot, or null if not found", async () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  const { requestCapability, wait, getResult } = fakeCapabilities({ GET_GRAFANA_LOCKED_TOTES: [{ toteId: "TS0000000001" }], GET_GRAFANA_SUPERVISOR_DUMP: [], GET_QUADRON_INVENTORY: stocked("TS0000000001", "TS0000000002") });
  const snapshot = await classificationEngine.refresh({ queryId: "Q-7", user: USER, requestCapability, wait, getResult, touchLockedSince: makeTouchLockedSince(), qm, db });
  const fetched = await classificationEngine.getResult("Q-7", { db });
  assert.deepEqual(fetched, snapshot);
  assert.equal(await classificationEngine.getResult("Q-DOES-NOT-EXIST", { db }), null);
});

test("getCurrentSnapshot() returns null when no refresh has ever completed", async () => {
  const db = makeFakeDb();
  assert.equal(await classificationEngine.getCurrentSnapshot({ db }), null);
});

// ═══════════════════════════════════════════════════════════════════════
// Locked Since wiring - the actual firstSeenAt/never-reset POLICY is
// unit-tested exhaustively in lockedSinceTracker.test.js. These tests only
// prove classificationEngine.refresh() actually calls touchLockedSince and
// merges its result onto each returned tote correctly.
// ═══════════════════════════════════════════════════════════════════════

test("every returned tote carries a lockedSince value from touchLockedSince", async () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  const { requestCapability, wait, getResult } = fakeCapabilities({
    GET_GRAFANA_LOCKED_TOTES: [{ toteId: "TS0000000001" }],
    GET_GRAFANA_SUPERVISOR_DUMP: [],
    GET_QUADRON_INVENTORY: stocked("TS0000000001", "TS0000000002"),
  });
  const snapshot = await classificationEngine.refresh({ queryId: "Q-8", user: USER, requestCapability, wait, getResult, touchLockedSince: makeTouchLockedSince(), qm, db });
  assert.equal(snapshot.totes[0].lockedSince, snapshot.generatedAt, "first-ever observation's lockedSince equals this refresh's own timestamp");
});

test("a second refresh for the same tote keeps its original lockedSince, not the new refresh's timestamp", async () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  const touchLockedSince = makeTouchLockedSince(); // same store reused across both refreshes below

  const first = fakeCapabilities({ GET_GRAFANA_LOCKED_TOTES: [{ toteId: "TS0000000001" }], GET_GRAFANA_SUPERVISOR_DUMP: [], GET_QUADRON_INVENTORY: stocked("TS0000000001", "TS0000000002") });
  const snap1 = await classificationEngine.refresh({ queryId: "Q-9A", user: USER, requestCapability: first.requestCapability, wait: first.wait, getResult: first.getResult, touchLockedSince, qm, db });

  // Deliberate gap so the two refreshes' own generatedAt timestamps cannot
  // coincidentally collide - otherwise a bug that reset lockedSince to the
  // new refresh's timestamp could pass this assertion by accident.
  await new Promise((resolve) => setTimeout(resolve, 5));

  const second = fakeCapabilities({ GET_GRAFANA_LOCKED_TOTES: [{ toteId: "TS0000000001" }], GET_GRAFANA_SUPERVISOR_DUMP: [], GET_QUADRON_INVENTORY: stocked("TS0000000001", "TS0000000002") });
  const snap2 = await classificationEngine.refresh({ queryId: "Q-9B", user: USER, requestCapability: second.requestCapability, wait: second.wait, getResult: second.getResult, touchLockedSince, qm, db });

  assert.notEqual(snap2.generatedAt, snap1.generatedAt, "test setup sanity check - the two refreshes must have distinct timestamps");
  assert.equal(snap2.totes[0].lockedSince, snap1.totes[0].lockedSince, "lockedSince must not change on a repeat observation");
});

// Checks actual require() statements only (not prose in comments, which
// legitimately mention these module names to document the constraint).
const REQUIRES_PULL_MODULE = /require\(\s*["'][^"']*(totePullEngine|quadronPullLock|pullQuadronTote)["']\s*\)/;

test("nothing in this module has a code path that touches a pull-related module", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../../../features/locked-tote-info/classificationEngine.js"), "utf8");
  assert.doesNotMatch(src, REQUIRES_PULL_MODULE);
});

test("the route file has no code path that touches a pull-related module", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../../../features/locked-tote-info/lockedToteInfo.routes.js"), "utf8");
  assert.doesNotMatch(src, REQUIRES_PULL_MODULE);
});
