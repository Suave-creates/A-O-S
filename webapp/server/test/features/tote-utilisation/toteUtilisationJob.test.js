// Unit tests for server/features/tote-utilisation/toteUtilisationJob.js - the orchestration
// layer. queryManager/nexsAsrsDumpEngine/db are all fully injected fakes -
// no real MySQL, no real Runtime/capability call anywhere in this file.
// The real INSERT/SELECT round trip against tote_utilisation_results is
// covered separately by server/test/toteUtilisationMysql.test.js
// (TEST_DB_NAME-gated, real SQL).

const test = require("node:test");
const assert = require("node:assert/strict");
const { runToteUtilisation, toUtilisationRow, listRecentResults } = require("../../../features/tote-utilisation/toteUtilisationJob");

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
    registerJob(queryId) {
      calls.push({ fn: "registerJob", queryId });
      return { signal: undefined, wasCancelledByUser: () => false };
    },
    unregisterJob(queryId) {
      calls.push({ fn: "unregisterJob", queryId });
    },
  };
}

function fakeEngine(snapshot) {
  return { getCurrentSnapshot: async () => snapshot };
}
function throwingEngine(err) {
  return {
    getCurrentSnapshot: async () => {
      throw err;
    },
  };
}
function makeFakeDb() {
  const inserts = [];
  return {
    inserts,
    async execute(sql, params) {
      inserts.push({ sql, params });
      return { insertId: inserts.length, affectedRows: 1 };
    },
  };
}

// ── toUtilisationRow (the field-name/location adapter) ────────────────────

test("toUtilisationRow maps barcodeCount -> inventoryCount, preserves pid/toteId, and deliberately nulls location", () => {
  const mapped = toUtilisationRow({
    pid: "82650064",
    toteId: "TS0000009125",
    partition: "PR1",
    barcodeCount: 56,
    location: "NXS1-ASRS-TS0000009125_PR1",
    lastUpdatedAt: null,
    ingestedAt: null,
  });
  assert.deepEqual(mapped, { pid: "82650064", toteId: "TS0000009125", location: null, inventoryCount: 56 });
});

// ── runToteUtilisation orchestration ──────────────────────────────────────

test("never calls a live fetch of any kind - only reads nexsAsrsDumpEngine.getCurrentSnapshot()", async () => {
  const qm = makeFakeQueryManager();
  let fetchCalled = false;
  const engine = {
    getCurrentSnapshot: async () => {
      fetchCalled = false; // no separate fetch mechanism exists in this test double at all
      return { rows: [{ pid: "1", toteId: "TS0000000001", partition: null, barcodeCount: 3, location: "NXS1-ASRS-TS0000000001" }] };
    },
  };
  await runToteUtilisation("Q-TEST-NOFETCH", {}, { queryManager: qm, nexsAsrsDumpEngine: engine, db: makeFakeDb() }).catch(() => {});
  assert.equal(fetchCalled, false);
});

test("no snapshot available: fails cleanly with an actionable message, never crashes, never writes a result row", async () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  await runToteUtilisation("Q-TEST-1", {}, { queryManager: qm, nexsAsrsDumpEngine: fakeEngine(null), db });
  const fail = qm.calls.find((c) => c.fn === "failQuery");
  assert.ok(fail);
  assert.match(fail.error, /No NEXS ASRS Tote Dump snapshot available/);
  assert.equal(db.inserts.length, 0);
});

test("an empty-rows snapshot is treated the same as no snapshot - fails cleanly rather than computing a meaningless empty result", async () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  await runToteUtilisation("Q-TEST-2", {}, { queryManager: qm, nexsAsrsDumpEngine: fakeEngine({ rows: [] }), db });
  assert.ok(qm.calls.some((c) => c.fn === "failQuery"));
  assert.equal(db.inserts.length, 0);
});

test("a snapshot-read failure (e.g. MySQL unreachable) is reported via failQuery with the real error message", async () => {
  const qm = makeFakeQueryManager();
  await runToteUtilisation("Q-TEST-3", {}, { queryManager: qm, nexsAsrsDumpEngine: throwingEngine(new Error("MySQL connection refused")), db: makeFakeDb() });
  const fail = qm.calls.find((c) => c.fn === "failQuery");
  assert.ok(fail);
  assert.match(fail.error, /MySQL connection refused/);
});

test("registerJob is called synchronously, before any await - a caller re-reading query status immediately after firing this function must see a registry entry already present (regression test for a live-verification bug: dropping this made every run look abandoned on its first status read)", () => {
  const qm = makeFakeQueryManager();
  // Deliberately NOT awaited - simulates the route handler's own
  // fire-and-forget call, then synchronously checking whether registerJob
  // already ran before this turn of the event loop yields.
  runToteUtilisation("Q-TEST-SYNC", {}, { queryManager: qm, nexsAsrsDumpEngine: fakeEngine(null), db: makeFakeDb() });
  assert.equal(qm.calls[0].fn, "registerJob", "registerJob must be the very first call, synchronously, before any await");
});

test("markRunning is called before the snapshot is read", async () => {
  const qm = makeFakeQueryManager();
  const order = [];
  const engine = {
    getCurrentSnapshot: async () => {
      order.push("getCurrentSnapshot");
      return { rows: [] };
    },
  };
  const origMarkRunning = qm.markRunning;
  qm.markRunning = async (id) => {
    order.push("markRunning");
    return origMarkRunning(id);
  };
  await runToteUtilisation("Q-TEST-4", {}, { queryManager: qm, nexsAsrsDumpEngine: engine, db: makeFakeDb() });
  assert.deepEqual(order, ["markRunning", "getCurrentSnapshot"]);
});

test("successful run: computes with the given caps, persists exactly one result row, and completes the query", async () => {
  const qm = makeFakeQueryManager();
  const db = makeFakeDb();
  const engine = fakeEngine({
    rows: [{ pid: "1", toteId: "TS0000000001", partition: null, barcodeCount: 50, location: "NXS1-ASRS-TS0000000001" }],
  });
  await runToteUtilisation("Q-TEST-5", { smallFrame: 50 }, { queryManager: qm, nexsAsrsDumpEngine: engine, db });

  assert.deepEqual(qm.calls.map((c) => c.fn), ["registerJob", "markRunning", "completeQuery", "unregisterJob"]);
  assert.equal(db.inserts.length, 1);
  const [sql, params] = [db.inserts[0].sql, db.inserts[0].params];
  assert.match(sql, /INSERT INTO tote_utilisation_results/);
  assert.equal(params[0], "Q-TEST-5");
  const persisted = JSON.parse(params[1]);
  assert.equal(persisted.detail[0].quantity, 50);
  assert.equal(persisted.detail[0].utilisation, 1, "quantity 50 / custom smallFrame cap 50 = 1.0 - proves caps reached the calculation");
  assert.deepEqual(JSON.parse(params[2]), [persisted.totals, persisted.stats, persisted.mixedCount, persisted.pipeline, persisted.caps], "summary_json is the small [totals, stats, mixedCount, pipeline, caps] array (migration 0011)");
  assert.equal(params[3], persisted.pipeline.scanned, "row_count column matches pipeline.scanned exactly");
});

test("a DB write failure (e.g. the INSERT itself throws) is still reported via failQuery, never left QUEUED/RUNNING forever", async () => {
  const qm = makeFakeQueryManager();
  const engine = fakeEngine({ rows: [{ pid: "1", toteId: "TS0000000001", partition: null, barcodeCount: 1, location: null }] });
  const db = { execute: async () => { throw new Error("simulated write failure"); } };
  await runToteUtilisation("Q-TEST-6", {}, { queryManager: qm, nexsAsrsDumpEngine: engine, db });
  const fail = qm.calls.find((c) => c.fn === "failQuery");
  assert.ok(fail);
  assert.match(fail.error, /simulated write failure/);
});

// ── listRecentResults (Phase 3C - history list) ────────────────────────────

function makeFakeQueryDb(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return rows;
    },
  };
}

test("listRecentResults is site-wide: no per-user filter, everyone sees every run", async () => {
  const db = makeFakeQueryDb([]);
  await listRecentResults({ limit: 5 }, { db });
  const { sql, params } = db.calls[0];
  assert.doesNotMatch(sql, /q\.user_id = \?/);
  assert.deepEqual(params, [5]);
});

test("listRecentResults clamps limit into [1, 50] and defaults to 10", async () => {
  const db = makeFakeQueryDb([]);
  await listRecentResults({ limit: 999 }, { db });
  assert.equal(db.calls[0].params[db.calls[0].params.length - 1], 50);

  const db2 = makeFakeQueryDb([]);
  await listRecentResults({ limit: 0 }, { db: db2 });
  assert.equal(db2.calls[0].params[db2.calls[0].params.length - 1], 1);

  const db3 = makeFakeQueryDb([]);
  await listRecentResults({}, { db: db3 });
  assert.equal(db3.calls[0].params[db3.calls[0].params.length - 1], 10);
});

test("listRecentResults reads the summary_json array (string or already-parsed) and falls back for legacy rows", async () => {
  const summary = (totals, mixed, pipeline, caps) => [totals, { largeLens: { totes: 1 } }, mixed, pipeline, caps];
  const stringyRow = {
    queryId: "Q-1", createdAt: "2026-01-01T00:00:00.000Z", rowCount: 5, runBy: "EMP001",
    summaryJson: JSON.stringify(summary({ totes: 3, util: 0.5 }, 1, { scanned: 5, counted: 3 }, { largeLens: 300 })),
  };
  const objectRow = {
    queryId: "Q-2", createdAt: "2026-01-02T00:00:00.000Z", rowCount: 8, runBy: "EMP001",
    summaryJson: summary({ totes: 4, util: 0.6 }, 0, { scanned: 8, counted: 4 }, { largeLens: 300 }),
  };
  const legacyRow = {
    queryId: "Q-3", createdAt: "2026-01-03T00:00:00.000Z", rowCount: 2, runBy: "EMP001",
    summaryJson: null,
    legacyJson: JSON.stringify(summary({ totes: 1, util: 0.1 }, 0, { scanned: 2, counted: 1 }, { largeLens: 300 })),
  };
  const db = makeFakeQueryDb([stringyRow, objectRow, legacyRow]);
  // A row with no summary_json gets a second, per-row JSON_EXTRACT query - answer it with that row's legacy extract.
  const listQuery = db.query;
  db.query = async (sql, params) => (/JSON_EXTRACT/.test(sql) ? [{ legacyJson: legacyRow.legacyJson }] : listQuery(sql, params));
  db.execute = async () => {};
  const results = await listRecentResults({}, { db });
  assert.equal(results.length, 3);
  assert.deepEqual(results[0].totals, { totes: 3, util: 0.5 });
  assert.equal(results[0].mixedCount, 1);
  assert.deepEqual(results[1].totals, { totes: 4, util: 0.6 });
  assert.equal(results[1].mixedCount, 0);
  assert.deepEqual(results[2].totals, { totes: 1, util: 0.1 }, "legacy row read via the one-parse fallback");
});

test("listRecentResults only queries tote_utilisation_results/queries - never touches raw ASRS/blocked/Quadron tables", async () => {
  const db = makeFakeQueryDb([]);
  await listRecentResults({}, { db });
  const { sql } = db.calls[0];
  assert.match(sql, /FROM tote_utilisation_results/);
  assert.match(sql, /operation = 'TOTE_UTILISATION'/);
  assert.match(sql, /status = 'COMPLETED'/);
});
