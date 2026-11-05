// Local-First Phase 1 tests for server/features/locked-tote-info/classificationTimestampsMemory.js -
// mirrors server/test/classificationTimestamps.test.js's own scenarios
// (same T1/T2/T3 policy: first_seen_at set once and never reset,
// last_seen_at always advances, discrepancy_marked_at never touched) but
// against the local-store-backed adapter instead of real MySQL. No MySQL
// connection anywhere in this file.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.ASO_LOCAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aso-clstimestamps-test-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const localStore = require("../../../platform/storage/localStore");
const classificationTimestampsMemory = require("../../../features/locked-tote-info/classificationTimestampsMemory");

test.after(() => {
  fs.rmSync(process.env.ASO_LOCAL_STORE_DIR, { recursive: true, force: true });
});

const T1 = "2026-08-22T13:19:07.000Z";
const T2 = "2026-08-22T13:25:07.000Z";
const T3 = "2026-08-22T13:31:07.000Z";

test("first touch creates first_seen_at = last_seen_at = the given timestamp", async () => {
  const result = await classificationTimestampsMemory.touchMany(["TS1"], T1);
  assert.equal(result.get("TS1"), T1);
  const rows = localStore.readCollection("classification_tote_state", []);
  const row = rows.find((r) => r.tote_id === "TS1");
  assert.equal(row.first_seen_at, T1);
  assert.equal(row.last_seen_at, T1);
});

test("a second touch does not change first_seen_at, but last_seen_at advances", async () => {
  await classificationTimestampsMemory.touchMany(["TS2"], T1);
  const result = await classificationTimestampsMemory.touchMany(["TS2"], T2);
  assert.equal(result.get("TS2"), T1);
  const rows = localStore.readCollection("classification_tote_state", []);
  const row = rows.find((r) => r.tote_id === "TS2");
  assert.equal(row.first_seen_at, T1);
  assert.equal(row.last_seen_at, T2);
});

test("reappearance after an absence preserves the ORIGINAL first_seen_at", async () => {
  await classificationTimestampsMemory.touchMany(["TS3"], T1);
  // Round 2 absent (not called). Round 3: reappears.
  const result = await classificationTimestampsMemory.touchMany(["TS3"], T3);
  assert.equal(result.get("TS3"), T1);
  const rows = localStore.readCollection("classification_tote_state", []);
  const row = rows.find((r) => r.tote_id === "TS3");
  assert.equal(row.first_seen_at, T1);
  assert.equal(row.last_seen_at, T3);
});

test("this state persists to disk and survives being reloaded (simulated restart)", async () => {
  await classificationTimestampsMemory.touchMany(["TS4"], T1);
  const rows = localStore.readCollection("classification_tote_state", []);
  assert.ok(rows.some((r) => r.tote_id === "TS4" && r.first_seen_at === T1));
});

test("discrepancy_marked_at is never written by touchMany - stays whatever localStore already had", async () => {
  // Simulate a future discrepancy-history phase having populated this field
  // directly in the store, exactly as the MySQL suite simulates via a raw
  // UPDATE.
  const rows = localStore.readCollection("classification_tote_state", []);
  rows.push({ tote_id: "TS5", first_seen_at: T1, last_seen_at: T1, discrepancy_marked_at: T2 });
  localStore.writeCollection("classification_tote_state", rows);

  const result = await classificationTimestampsMemory.touchMany(["TS5"], T3);
  assert.equal(result.get("TS5"), T2, "Locked Since must resolve to discrepancy_marked_at, not first_seen_at");
  const after = localStore.readCollection("classification_tote_state", []);
  const row = after.find((r) => r.tote_id === "TS5");
  assert.equal(row.discrepancy_marked_at, T2, "must remain untouched");
  assert.equal(row.first_seen_at, T1, "must also remain untouched");
  assert.equal(row.last_seen_at, T3, "last_seen_at still advances normally");
});

test("touchMany([], ...) is a no-op and returns an empty Map", async () => {
  const result = await classificationTimestampsMemory.touchMany([], T1);
  assert.equal(result.size, 0);
});

// ── getMany() - read-only Locked Since lookup (Auto Preview/Dry-Run) ─────

test("getMany() returns the same lockedSince a touchMany() call already established, without writing anything", async () => {
  await classificationTimestampsMemory.touchMany(["TS6"], T1);
  const before = localStore.readCollection("classification_tote_state", []);

  const result = await classificationTimestampsMemory.getMany(["TS6"]);
  assert.equal(result.get("TS6"), T1);

  const after = localStore.readCollection("classification_tote_state", []);
  assert.deepEqual(before, after, "getMany() must never write to the store");
});

test("getMany() omits totes never seen by Classification, rather than returning null entries", async () => {
  const result = await classificationTimestampsMemory.getMany(["TS-NEVER-SEEN"]);
  assert.equal(result.has("TS-NEVER-SEEN"), false);
});

test("getMany([]) is a no-op and returns an empty Map", async () => {
  const result = await classificationTimestampsMemory.getMany([]);
  assert.equal(result.size, 0);
});
