// Integration tests for server/features/nexs-asrs-dump/nexsAsrsDumpMysqlStore.js - runs the
// REAL SQL from server/platform/db/migrations/0005_nexs_asrs_dump.sql against a
// real, isolated MySQL test database. Exactly the same TEST_DB_NAME safety
// gate api.test.js/classificationTimestamps.test.js/syncToCompany.test.js
// already use and trust - this suite will never run against
// DB_NAME/production_tracker. If TEST_DB_NAME is unavailable/inaccessible,
// this suite fails fast and cleanly (an environment-gated failure, not an
// application bug) - see the class of failures already documented for the
// other three TEST_DB_NAME-gated suites.
//
// db.close() is called in test.after() so this file's own MySQL pool is
// never left open past the test run (an unclosed pool otherwise keeps the
// Node process alive well past test completion under real connectivity -
// see the diagnosis that led to this being added deliberately here).

const testDbName = process.env.TEST_DB_NAME || "";
if (!/test/i.test(testDbName)) {
  throw new Error(
    `Refusing to run: TEST_DB_NAME is "${testDbName || "(unset)"}" - it must be set to a ` +
      `database name containing "test" (e.g. production_tracker_test). This suite will never ` +
      `run against DB_NAME/production_tracker. Provision a dedicated test database and set ` +
      `TEST_DB_NAME before running tests.`
  );
}
process.env.DB_NAME = testDbName;
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

let db, migrate, seedDevUsers, config, store;

test.before(async () => {
  db = require("../../../platform/db");
  migrate = require("../../../platform/db/migrate");
  seedDevUsers = require("../../../platform/db/seed");
  config = require("../../../config");
  store = require("../../../features/nexs-asrs-dump/nexsAsrsDumpMysqlStore");
  await migrate();
  await seedDevUsers();
});

test.after(async () => {
  await db.execute("DELETE FROM nexs_asrs_dump_current");
  await db.execute("DELETE FROM nexs_asrs_dump_rows");
  await db.execute("DELETE FROM nexs_asrs_dump_refreshes");
  await db.close();
});

async function getAdminUserId() {
  const rows = await db.query("SELECT id FROM users WHERE employee_id = ?", [config.seedAdminId]);
  return rows[0].id;
}

function sampleRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const tote = (i % 2 === 0 ? "TS" : "TL") + String(1000000000 + i).slice(-10);
    rows.push({
      pid: String(100000 + i),
      toteId: tote,
      partition: i % 3 === 0 ? null : "PR1",
      barcodeCount: (i % 20) + 1,
      location: `NXS1-ASRS-${tote}${i % 3 === 0 ? "" : "_PR1"}`,
      lastUpdatedAt: null,
      ingestedAt: null,
    });
  }
  return rows;
}

test("A/B: createRefresh + bulkInsertRows + markCompleted + swapCurrent produces a coherent generation whose rows are all tagged with the correct refresh_id", async () => {
  const userId = await getAdminUserId();
  const refreshId = await store.createRefresh({ queryId: "Q-TEST-A", refreshedBy: userId });
  assert.ok(Number.isInteger(refreshId));

  const rows = sampleRows(25);
  await db.transaction(async (tx) => {
    await store.bulkInsertRows(refreshId, rows, { tx });
    await store.markCompleted(refreshId, { rowCount: rows.length, totalBarcodeCount: 999, source: "runtime_apps_script", latestIngestedAt: null, latestUpdatedAt: null }, { tx });
    await store.swapCurrent(refreshId, { tx });
  });

  const stored = await store.getRowsForRefresh(refreshId);
  assert.equal(stored.length, 25);
  assert.ok(stored.every((r) => r.pid && r.tote_id));

  const meta = await store.getCurrentMeta();
  assert.equal(meta.id, refreshId);
  assert.equal(meta.status, "COMPLETED");
  assert.equal(meta.row_count, 25);
});

test("C: the current pointer changes ONLY after markCompleted+swapCurrent commit - a RUNNING refresh never becomes current", async () => {
  const before = await store.getCurrentMeta();
  const userId = await getAdminUserId();
  const refreshId = await store.createRefresh({ queryId: "Q-TEST-C", refreshedBy: userId });
  // Deliberately do NOT insert rows or call markCompleted/swapCurrent.
  const after = await store.getCurrentMeta();
  assert.equal(after ? after.id : null, before ? before.id : null, "current pointer must be unaffected by a merely-created RUNNING refresh");
  await store.markFailed(refreshId, "abandoned by test");
});

test("D/E: a rolled-back transaction leaves zero rows for that refresh_id and never touches the current pointer", async () => {
  const beforeMeta = await store.getCurrentMeta();
  const userId = await getAdminUserId();
  const refreshId = await store.createRefresh({ queryId: "Q-TEST-E", refreshedBy: userId });

  await assert.rejects(
    db.transaction(async (tx) => {
      await store.bulkInsertRows(refreshId, sampleRows(5), { tx });
      throw new Error("simulated mid-transaction failure");
    })
  );
  await store.markFailed(refreshId, "simulated mid-transaction failure");

  const rows = await store.getRowsForRefresh(refreshId);
  assert.equal(rows.length, 0, "the rolled-back generation must have zero rows, not a partial set");

  const afterMeta = await store.getCurrentMeta();
  assert.equal(afterMeta ? afterMeta.id : null, beforeMeta ? beforeMeta.id : null, "current pointer must be untouched by a failed attempt");
});

test("G: reconcileStaleRunning flips an orphaned RUNNING refresh to FAILED, with an explanatory reason", async () => {
  const userId = await getAdminUserId();
  const refreshId = await store.createRefresh({ queryId: "Q-TEST-G", refreshedBy: userId });
  await store.reconcileStaleRunning();

  const rows = await db.query("SELECT status, error FROM nexs_asrs_dump_refreshes WHERE id = ?", [refreshId]);
  assert.equal(rows[0].status, "FAILED");
  assert.match(rows[0].error, /restarted/i);
});

test("reconcileStaleRunning never touches a COMPLETED or already-FAILED refresh", async () => {
  const userId = await getAdminUserId();
  const refreshId = await store.createRefresh({ queryId: "Q-TEST-G2", refreshedBy: userId });
  await db.transaction(async (tx) => {
    await store.bulkInsertRows(refreshId, sampleRows(3), { tx });
    await store.markCompleted(refreshId, { rowCount: 3, totalBarcodeCount: 10, source: "runtime_apps_script" }, { tx });
    await store.swapCurrent(refreshId, { tx });
  });
  await store.reconcileStaleRunning();
  const rows = await db.query("SELECT status FROM nexs_asrs_dump_refreshes WHERE id = ?", [refreshId]);
  assert.equal(rows[0].status, "COMPLETED");
});

test("H/I/J: cleanupOldGenerations retains exactly the newest `keep` COMPLETED generations, never the current one, never a RUNNING one", async () => {
  const userId = await getAdminUserId();
  const generationIds = [];
  for (let i = 0; i < 5; i++) {
    const refreshId = await store.createRefresh({ queryId: `Q-TEST-H${i}`, refreshedBy: userId });
    await db.transaction(async (tx) => {
      await store.bulkInsertRows(refreshId, sampleRows(4), { tx });
      await store.markCompleted(refreshId, { rowCount: 4, totalBarcodeCount: 40, source: "runtime_apps_script" }, { tx });
      await store.swapCurrent(refreshId, { tx });
    });
    generationIds.push(refreshId);
  }
  // A RUNNING generation created after the last COMPLETED one - must never be a cleanup candidate.
  const runningId = await store.createRefresh({ queryId: "Q-TEST-H-RUNNING", refreshedBy: userId });

  const { deletedGenerations } = await store.cleanupOldGenerations(3);

  const currentId = generationIds[generationIds.length - 1];
  assert.ok(!deletedGenerations.includes(currentId), "must never delete the current generation");
  assert.ok(!deletedGenerations.includes(runningId), "must never delete a RUNNING generation");

  const keptRows = await store.getRowsForRefresh(currentId);
  assert.equal(keptRows.length, 4, "the current generation's rows must be untouched");

  const survivingCompleted = [];
  for (const id of generationIds) {
    const rows = await store.getRowsForRefresh(id);
    if (rows.length > 0) survivingCompleted.push(id);
  }
  assert.equal(survivingCompleted.length, 3, "exactly 3 COMPLETED generations should retain rows");

  // Metadata rows are never deleted by cleanup, regardless of retention.
  const metaRows = await db.query(
    `SELECT id FROM nexs_asrs_dump_refreshes WHERE id IN (${generationIds.map(() => "?").join(",")})`,
    generationIds
  );
  assert.equal(metaRows.length, generationIds.length, "refresh metadata history must never be pruned by cleanup");

  await store.markFailed(runningId, "test cleanup");
});

test("getLatestAttemptMeta ignores RUNNING refreshes - only reflects concluded attempts", async () => {
  const userId = await getAdminUserId();
  const refreshId = await store.createRefresh({ queryId: "Q-TEST-LATEST", refreshedBy: userId });
  const latestBefore = await store.getLatestAttemptMeta();
  assert.notEqual(latestBefore ? latestBefore.id : null, refreshId, "a RUNNING refresh must not be reported as the latest concluded attempt");
  await store.markFailed(refreshId, "test");
  const latestAfter = await store.getLatestAttemptMeta();
  assert.equal(latestAfter.id, refreshId);
  assert.equal(latestAfter.status, "FAILED");
});
