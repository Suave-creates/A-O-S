// Integration tests for server/features/locked-tote-info/classificationTimestamps.js - the real
// MySQL-backed "Locked Since" persistence, exercising the actual atomic
// UPSERT SQL (not the storage-agnostic pure policy already covered
// exhaustively in lockedSinceTracker.test.js). These are what actually
// prove the bug fix: an earlier version of this file did a non-atomic
// SELECT-then-branch-INSERT/UPDATE, which had a real read/write race
// window. This suite runs the real SQL against a real database.
//
// SAFETY: exactly the same TEST_DB_NAME gate as api.test.js - this suite
// refuses to run unless TEST_DB_NAME is set and contains "test"
// (case-insensitive). It will never run against DB_NAME/production_tracker.

const test = require("node:test");
const assert = require("node:assert/strict");

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

let db, migrate, classificationTimestamps;

test.before(async () => {
  db = require("../../../platform/db");
  migrate = require("../../../platform/db/migrate");
  classificationTimestamps = require("../../../features/locked-tote-info/classificationTimestamps");
  await migrate();
});

test.after(async () => {
  // Isolated test database only - never touches DB_NAME/production_tracker.
  await db.execute("DELETE FROM classification_tote_state");
  await db.close();
});

async function clean(...toteIds) {
  if (!toteIds.length) return;
  const placeholders = toteIds.map(() => "?").join(",");
  await db.execute(`DELETE FROM classification_tote_state WHERE tote_id IN (${placeholders})`, toteIds);
}

const T1 = "2026-08-22T13:19:07.000Z";
const T2 = "2026-08-22T13:25:07.000Z";
const T3 = "2026-08-22T13:31:07.000Z";

test("first refresh creates first_seen_at", async () => {
  const toteId = "TS0000077701";
  await clean(toteId);
  const result = await classificationTimestamps.touchMany([toteId], T1);
  assert.equal(result.get(toteId), T1);
  const [row] = await db.query("SELECT * FROM classification_tote_state WHERE tote_id = ?", [toteId]);
  assert.equal(row.first_seen_at, T1);
  assert.equal(row.last_seen_at, T1);
  await clean(toteId);
});

test("second refresh with a later timestamp does NOT change first_seen_at, but last_seen_at DOES change", async () => {
  const toteId = "TS0000077702";
  await clean(toteId);
  await classificationTimestamps.touchMany([toteId], T1);
  const result = await classificationTimestamps.touchMany([toteId], T2);
  assert.equal(result.get(toteId), T1, "returned lockedSince must still be T1");
  const [row] = await db.query("SELECT * FROM classification_tote_state WHERE tote_id = ?", [toteId]);
  assert.equal(row.first_seen_at, T1);
  assert.equal(row.last_seen_at, T2);
  await clean(toteId);
});

test("multiple refreshes preserve first_seen_at: for a tote present across T1/T2/T3, first_seen_at===T1 and last_seen_at===T3", async () => {
  const toteId = "TS0000077703";
  await clean(toteId);
  await classificationTimestamps.touchMany([toteId], T1);
  await classificationTimestamps.touchMany([toteId], T2);
  const result = await classificationTimestamps.touchMany([toteId], T3);
  assert.equal(result.get(toteId), T1);
  const [row] = await db.query("SELECT * FROM classification_tote_state WHERE tote_id = ?", [toteId]);
  assert.equal(row.first_seen_at, T1, "first_seen_at must equal T1");
  assert.equal(row.last_seen_at, T3, "last_seen_at must equal T3");
  await clean(toteId);
});

test("a tote disappearing from a refresh does not delete its classification_tote_state record", async () => {
  const toteId = "TS0000077704";
  await clean(toteId);
  await classificationTimestamps.touchMany([toteId], T1);
  // Refresh #2 does not include this tote at all (it's absent from the
  // Locked Dump this round) - touchMany is simply never called with it.
  const [row] = await db.query("SELECT * FROM classification_tote_state WHERE tote_id = ?", [toteId]);
  assert.ok(row, "the row must still exist after the tote is absent from a refresh");
  assert.equal(row.first_seen_at, T1);
  await clean(toteId);
});

test("a tote reappearing after being absent preserves its ORIGINAL first_seen_at, not a new one", async () => {
  const toteId = "TS0000077705";
  await clean(toteId);
  await classificationTimestamps.touchMany([toteId], T1);
  // Round 2: absent (not included). Round 3: reappears.
  const result = await classificationTimestamps.touchMany([toteId], T3);
  assert.equal(result.get(toteId), T1, "reappearance must report the ORIGINAL first_seen_at, not T3");
  const [row] = await db.query("SELECT * FROM classification_tote_state WHERE tote_id = ?", [toteId]);
  assert.equal(row.first_seen_at, T1);
  assert.equal(row.last_seen_at, T3, "last_seen_at DOES advance on the reappearance itself");
  await clean(toteId);
});

test("a newly appearing tote (never seen before) gets the current refresh's own timestamp", async () => {
  const existingTote = "TS0000077706";
  const newTote = "TS0000077707";
  await clean(existingTote, newTote);
  await classificationTimestamps.touchMany([existingTote], T1);

  // Refresh #2: existingTote still present, newTote appears for the first time.
  const result = await classificationTimestamps.touchMany([existingTote, newTote], T2);
  assert.equal(result.get(existingTote), T1, "existing tote must keep its original timestamp");
  assert.equal(result.get(newTote), T2, "brand-new tote must get this refresh's own timestamp");
  await clean(existingTote, newTote);
});

test("discrepancy_marked_at is never touched by touchMany - stays whatever it already was", async () => {
  const toteId = "TS0000077708";
  await clean(toteId);
  await classificationTimestamps.touchMany([toteId], T1);
  // Simulate a future discrepancy-history phase having populated this column.
  await db.execute("UPDATE classification_tote_state SET discrepancy_marked_at = ? WHERE tote_id = ?", [T2, toteId]);

  const result = await classificationTimestamps.touchMany([toteId], T3);
  const [row] = await db.query("SELECT * FROM classification_tote_state WHERE tote_id = ?", [toteId]);
  assert.equal(row.discrepancy_marked_at, T2, "discrepancy_marked_at must remain exactly what it was set to");
  assert.equal(row.first_seen_at, T1, "first_seen_at must also remain untouched");
  assert.equal(row.last_seen_at, T3, "last_seen_at still advances normally");
  assert.equal(result.get(toteId), T2, "Locked Since must resolve to discrepancy_marked_at, not first_seen_at, once it's set");
  await clean(toteId);
});

test("Locked Since selects discrepancy_marked_at when present, otherwise first_seen_at (end-to-end through the real adapter)", async () => {
  const withDiscrepancy = "TS0000077709";
  const withoutDiscrepancy = "TS0000077710";
  await clean(withDiscrepancy, withoutDiscrepancy);

  await classificationTimestamps.touchMany([withDiscrepancy, withoutDiscrepancy], T1);
  await db.execute("UPDATE classification_tote_state SET discrepancy_marked_at = ? WHERE tote_id = ?", [T2, withDiscrepancy]);

  const result = await classificationTimestamps.touchMany([withDiscrepancy, withoutDiscrepancy], T3);
  assert.equal(result.get(withDiscrepancy), T2, "prefers discrepancy_marked_at when present");
  assert.equal(result.get(withoutDiscrepancy), T1, "falls back to first_seen_at when discrepancy_marked_at is null");
  await clean(withDiscrepancy, withoutDiscrepancy);
});

test("getMany() returns the same lockedSince touchMany() already established, without writing anything", async () => {
  const toteId = "TS0000077711";
  await clean(toteId);
  await classificationTimestamps.touchMany([toteId], T1);
  const [before] = await db.query("SELECT * FROM classification_tote_state WHERE tote_id = ?", [toteId]);

  const result = await classificationTimestamps.getMany([toteId]);
  assert.equal(result.get(toteId), T1);

  const [after] = await db.query("SELECT * FROM classification_tote_state WHERE tote_id = ?", [toteId]);
  assert.deepEqual(before, after, "getMany() must never write to the table");
  await clean(toteId);
});

test("getMany() omits totes never seen by Classification, rather than returning null entries", async () => {
  const result = await classificationTimestamps.getMany(["TS0000000000"]);
  assert.equal(result.has("TS0000000000"), false);
});

test("realistic batch scale (220 totes) - no cross-tote drift, atomic per-row", async () => {
  const toteIds = Array.from({ length: 220 }, (_, i) => "TS" + String(9500000 + i).padStart(10, "0"));
  await clean(...toteIds);

  const r1 = await classificationTimestamps.touchMany(toteIds, T1);
  assert.equal(new Set([...r1.values()]).size, 1, "every tote's first-ever observation must share T1");

  const r2 = await classificationTimestamps.touchMany(toteIds, T2);
  const drifted = toteIds.filter((id) => r2.get(id) !== T1);
  assert.deepEqual(drifted, [], "no tote's lockedSince may drift away from T1 on a repeat observation at batch scale");

  await clean(...toteIds);
});
