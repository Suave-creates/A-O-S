// Integration test for the tote_utilisation_results round trip - real SQL
// against a real, isolated MySQL test database. Exactly the same
// TEST_DB_NAME safety gate api.test.js/classificationTimestamps.test.js/
// syncToCompany.test.js/nexsAsrsDumpMysqlStore.test.js already use and
// trust - this suite will never run against DB_NAME/production_tracker.
// The schema itself (tote_utilisation_results) is UNCHANGED - this only
// proves runToteUtilisation()'s real INSERT and getResult()'s real SELECT
// still round-trip correctly against it.

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

let db, migrate, seedDevUsers, config, queryManagerMysql, job;

test.before(async () => {
  db = require("../../../platform/db");
  migrate = require("../../../platform/db/migrate");
  seedDevUsers = require("../../../platform/db/seed");
  config = require("../../../config");
  queryManagerMysql = require("../../../platform/queries/queryManagerMysql");
  job = require("../../../features/tote-utilisation/toteUtilisationJob");
  await migrate();
  await seedDevUsers();
});

test.after(async () => {
  await db.execute("DELETE FROM tote_utilisation_results");
  await db.execute("DELETE FROM queries");
  await db.close();
});

async function getAdminUserId() {
  const rows = await db.query("SELECT id FROM users WHERE employee_id = ?", [config.seedAdminId]);
  return rows[0].id;
}

test("runToteUtilisation persists a real row, getResult reads it back with the exact same structure", async () => {
  const userId = await getAdminUserId();
  const query = await queryManagerMysql.createQuery({ userId, operation: "TOTE_UTILISATION", parameters: {} });

  const engine = {
    getCurrentSnapshot: async () => ({
      rows: [
        { pid: "1", toteId: "TS0000000001", partition: null, barcodeCount: 5, location: "NXS1-ASRS-TS0000000001" },
        { pid: "1", toteId: "TS0000000002", partition: null, barcodeCount: 3, location: "NXS1-ASRS-TS0000000002" },
      ],
    }),
  };

  await job.runToteUtilisation(query.query_id, { smallFrame: 200 }, { nexsAsrsDumpEngine: engine });

  const finalQuery = await queryManagerMysql.getQuery(query.query_id);
  assert.equal(finalQuery.status, "COMPLETED");

  const result = await job.getResult(query.query_id);
  assert.ok(result);
  assert.equal(result.totals.totes, 2);
  assert.equal(result.stats.smallFrame.totes, 2);
  assert.equal(result.stats.smallFrame.qty, 8);

  const rows = await db.query("SELECT * FROM tote_utilisation_results WHERE query_id = ?", [query.query_id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].row_count, 2);
});

test("getResult returns null for a query_id with no persisted result", async () => {
  const result = await job.getResult("Q-DOES-NOT-EXIST");
  assert.equal(result, null);
});

test("listRecentResults (Phase 3C) returns real persisted runs, most recent first, with correct JSON_EXTRACT summaries", async () => {
  const userId = await getAdminUserId();
  const engine = {
    getCurrentSnapshot: async () => ({
      rows: [{ pid: "1", toteId: "TS0000000001", partition: null, barcodeCount: 4, location: "NXS1-ASRS-TS0000000001" }],
    }),
  };

  const q1 = await queryManagerMysql.createQuery({ userId, operation: "TOTE_UTILISATION", parameters: {} });
  await job.runToteUtilisation(q1.query_id, {}, { nexsAsrsDumpEngine: engine });
  const q2 = await queryManagerMysql.createQuery({ userId, operation: "TOTE_UTILISATION", parameters: {} });
  await job.runToteUtilisation(q2.query_id, {}, { nexsAsrsDumpEngine: engine });

  const history = await job.listRecentResults({ limit: 10 });
  assert.ok(history.length >= 2);
  assert.equal(history[0].queryId, q2.query_id, "most recent run first");
  assert.equal(history[1].queryId, q1.query_id);
  assert.equal(history[0].runBy, config.seedAdminId);
  assert.ok(history[0].totals);
  assert.equal(history[0].totals.totes, 1);
  assert.equal(history[0].mixedCount, 0);
  assert.ok(history[0].pipeline);
  assert.ok(history[0].caps);
  // Full per-tote detail must never be present in the summary list.
  assert.equal(history[0].detail, undefined);
});

test("listRecentResults shows another user's runs too (history is site-wide)", async () => {
  const userId = await getAdminUserId();
  const otherRows = await db.query("SELECT id FROM users WHERE employee_id = ?", [config.seedUserId]);
  const otherUserId = otherRows[0].id;

  const engine = {
    getCurrentSnapshot: async () => ({
      rows: [{ pid: "1", toteId: "TS0000000001", partition: null, barcodeCount: 1, location: null }],
    }),
  };
  const q = await queryManagerMysql.createQuery({ userId: otherUserId, operation: "TOTE_UTILISATION", parameters: {} });
  await job.runToteUtilisation(q.query_id, {}, { nexsAsrsDumpEngine: engine });

  const asOwner = await job.listRecentResults({ limit: 10 });
  assert.ok(asOwner.some((r) => r.queryId === q.query_id));

  const asDifferentUser = await job.listRecentResults({ limit: 10 });
  assert.ok(asDifferentUser.some((r) => r.queryId === q.query_id), "must see another user's run");

  const asAdmin = await job.listRecentResults({ userId, isAdmin: true, limit: 50 });
  assert.ok(asAdmin.some((r) => r.queryId === q.query_id), "ADMIN sees every user's runs");
});
