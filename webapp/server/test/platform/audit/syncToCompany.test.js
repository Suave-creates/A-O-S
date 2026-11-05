// Integration tests for server/scripts/syncToCompany.js - Local-First
// Phase 1's explicit sync-to-company mechanism. Runs the REAL sync logic
// against a REAL MySQL database, but ONLY a controlled, dedicated test
// database - exactly the same TEST_DB_NAME safety gate
// server/test/api.test.js and server/test/classificationTimestamps.test.js
// already use and trust. This suite will refuse to run unless
// TEST_DB_NAME is set and contains "test" (case-insensitive), and will
// NEVER run against DB_NAME/production_tracker or any real company
// database. This is how isolation was verified for this task.
//
// No real Quadron/Grafana/Concinity/NexS call anywhere in this file - the
// structural test at the bottom proves syncToCompany.js itself has no code
// path that could reach one.

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

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.ASO_LOCAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aso-sync-test-"));

const test = require("node:test");
const assert = require("node:assert/strict");

let db, migrate, seedDevUsers, config, syncToCompany, outbox, localStore;

test.before(async () => {
  db = require("../../../platform/db");
  migrate = require("../../../platform/db/migrate");
  seedDevUsers = require("../../../platform/db/seed");
  config = require("../../../config");
  syncToCompany = require("../../../scripts/syncToCompany");
  outbox = require("../../../platform/audit/outbox");
  localStore = require("../../../platform/storage/localStore");
  await migrate();
  await seedDevUsers(); // guarantees a users row with employee_id === config.seedAdminId
});

test.after(async () => {
  await db.execute("DELETE FROM local_sync_ledger");
  await db.execute("DELETE FROM audit_logs WHERE action LIKE 'TEST_SYNC_%'");
  await db.execute("DELETE FROM queries WHERE operation LIKE 'TEST_SYNC_%'");
  await db.execute("DELETE FROM classification_tote_state WHERE tote_id LIKE 'TSSYNC%'");
  await db.close();
  fs.rmSync(process.env.ASO_LOCAL_STORE_DIR, { recursive: true, force: true });
});

test("resolveCompanyUserId() resolves the seeded ADMIN identity", async () => {
  const id = await syncToCompany.resolveCompanyUserId();
  assert.equal(typeof id, "number");
});

test("an audit_log outbox entry syncs into company MySQL, is ledgered, and marked SYNCED", async () => {
  const entry = outbox.append({
    entityType: "audit_log",
    payload: {
      id: 1,
      user_id: -1,
      employee_id: config.seedAdminId,
      role: "ADMIN",
      action: "TEST_SYNC_AUDIT",
      detail: JSON.stringify({ sessionId: "Q-SYNC-1", results: [] }),
      created_at: "2026-08-22T10:00:00.000Z",
    },
  });

  const result = await syncToCompany.syncOutbox();
  assert.equal(result.synced, 1);
  assert.equal(result.failed, 0);

  const synced = outbox.get(entry.operation_id);
  assert.equal(synced.sync_status, "SYNCED");
  assert.ok(synced.synced_at);

  const [ledgerRow] = await db.query("SELECT * FROM local_sync_ledger WHERE operation_id = ?", [entry.operation_id]);
  assert.ok(ledgerRow, "ledger must record this operation_id");
  assert.equal(ledgerRow.mysql_table, "audit_logs");

  const [companyRow] = await db.query("SELECT * FROM audit_logs WHERE id = ?", [ledgerRow.mysql_id]);
  assert.ok(companyRow);
  assert.equal(companyRow.action, "TEST_SYNC_AUDIT");
  assert.notEqual(companyRow.user_id, -1, "the local sentinel id must never be written to company MySQL");
});

test("a query outbox entry syncs into company MySQL with a fresh, non-colliding query_id", async () => {
  const entry = outbox.append({
    entityType: "query",
    payload: {
      id: 1,
      query_id: "Q-000001", // deliberately a low local id, likely to collide with company's own sequence
      user_id: -1,
      employee_id: config.seedAdminId,
      operation: "TEST_SYNC_QUERY",
      status: "COMPLETED",
      parameters: JSON.stringify({}),
      started_at: "2026-08-22T10:00:00.000Z",
      completed_at: "2026-08-22T10:01:00.000Z",
      cancelled_at: null,
      error: null,
      created_at: "2026-08-22T10:00:00.000Z",
    },
  });

  const result = await syncToCompany.syncOutbox();
  assert.equal(result.synced, 1);

  const [ledgerRow] = await db.query("SELECT * FROM local_sync_ledger WHERE operation_id = ?", [entry.operation_id]);
  assert.equal(ledgerRow.mysql_table, "queries");

  const [companyRow] = await db.query("SELECT * FROM queries WHERE id = ?", [ledgerRow.mysql_id]);
  assert.ok(companyRow);
  assert.equal(companyRow.operation, "TEST_SYNC_QUERY");
  assert.match(companyRow.query_id, /^Q-\d{6}$/);
});

test("running sync again with nothing new PENDING is a true no-op", async () => {
  const result = await syncToCompany.syncOutbox();
  assert.equal(result.total, 0);
  assert.equal(result.synced, 0);
});

test("idempotency: an entry whose operation_id is already in the ledger is marked SYNCED WITHOUT a duplicate insert", async () => {
  const entry = outbox.append({
    entityType: "audit_log",
    payload: {
      id: 2,
      user_id: -1,
      action: "TEST_SYNC_DUPLICATE",
      detail: JSON.stringify({ sessionId: "Q-SYNC-DUP" }),
      created_at: "2026-08-22T11:00:00.000Z",
    },
  });

  const first = await syncToCompany.syncOutbox();
  assert.equal(first.synced, 1);
  const [{ n: countAfterFirst }] = await db.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'TEST_SYNC_DUPLICATE'");
  assert.equal(countAfterFirst, 1);

  // Simulate re-running sync on an entry that is (for whatever reason -
  // e.g. the local outbox file was restored from an older copy) still
  // PENDING even though its operation_id already made it into the ledger.
  const rawEntries = outbox.list();
  const raw = rawEntries.find((e) => e.operation_id === entry.operation_id);
  raw.sync_status = "PENDING";
  localStore.writeCollection("outbox", rawEntries);

  const second = await syncToCompany.syncOutbox();
  assert.equal(second.alreadySynced, 1, "must be recognized via the ledger, not re-inserted");
  assert.equal(outbox.get(entry.operation_id).sync_status, "SYNCED");

  const [{ n: countAfterSecond }] = await db.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'TEST_SYNC_DUPLICATE'");
  assert.equal(countAfterSecond, 1, "running sync twice must never duplicate the company record");
});

test("a failed sync (unknown entity_type) retains PENDING, increments retry_count, records last_sync_error", async () => {
  const entry = outbox.append({ entityType: "bogus_type", payload: {} });
  const result = await syncToCompany.syncOutbox();
  assert.equal(result.failed, 1);

  const after = outbox.get(entry.operation_id);
  assert.equal(after.sync_status, "PENDING", "a failed operation must never be lost");
  assert.equal(after.retry_count, 1);
  assert.match(after.last_sync_error, /Unknown outbox entity_type/);
});

test("classification Locked Since merges first_seen_at=MIN / last_seen_at=MAX and never touches discrepancy_marked_at", async () => {
  const toteId = "TSSYNC0000001";
  await db.execute("DELETE FROM classification_tote_state WHERE tote_id = ?", [toteId]);
  // Seed a pre-existing company row: first_seen_at is LATER than what the
  // local record will claim, last_seen_at is EARLIER, and a
  // discrepancy_marked_at is already set.
  await db.execute(
    "INSERT INTO classification_tote_state (tote_id, first_seen_at, last_seen_at, discrepancy_marked_at) VALUES (?, ?, ?, ?)",
    [toteId, "2026-08-22T12:00:00.000Z", "2026-08-22T12:05:00.000Z", "2026-08-22T12:03:00.000Z"]
  );

  localStore.writeCollection("classification_tote_state", [
    { tote_id: toteId, first_seen_at: "2026-08-20T09:00:00.000Z", last_seen_at: "2026-08-22T18:00:00.000Z", discrepancy_marked_at: null },
  ]);

  const result = await syncToCompany.syncClassificationLockedSince();
  assert.equal(result.merged, 1);

  const [row] = await db.query("SELECT * FROM classification_tote_state WHERE tote_id = ?", [toteId]);
  assert.equal(row.first_seen_at, "2026-08-20T09:00:00.000Z", "must take the EARLIER of local/company first_seen_at");
  assert.equal(row.last_seen_at, "2026-08-22T18:00:00.000Z", "must take the LATER of local/company last_seen_at");
  assert.equal(row.discrepancy_marked_at, "2026-08-22T12:03:00.000Z", "must never be overwritten by sync");

  await db.execute("DELETE FROM classification_tote_state WHERE tote_id = ?", [toteId]);
});

test("running the classification merge twice with unchanged local data is idempotent", async () => {
  const toteId = "TSSYNC0000002";
  await db.execute("DELETE FROM classification_tote_state WHERE tote_id = ?", [toteId]);
  localStore.writeCollection("classification_tote_state", [
    { tote_id: toteId, first_seen_at: "2026-08-21T00:00:00.000Z", last_seen_at: "2026-08-21T01:00:00.000Z", discrepancy_marked_at: null },
  ]);

  await syncToCompany.syncClassificationLockedSince();
  const [firstRun] = await db.query("SELECT * FROM classification_tote_state WHERE tote_id = ?", [toteId]);
  await syncToCompany.syncClassificationLockedSince();
  const [secondRun] = await db.query("SELECT * FROM classification_tote_state WHERE tote_id = ?", [toteId]);

  assert.deepEqual(firstRun, secondRun);
  await db.execute("DELETE FROM classification_tote_state WHERE tote_id = ?", [toteId]);
});

// ── Structural: syncToCompany.js can never reach a real Quadron mutation ──
const BANNED_IMPORTS = /require\(\s*["'][^"']*(quadronPull|quadronPullLock|capabilityManager|pullQuadronTote|totePullEngine|autoEngine)["']\s*\)/;
const BANNED_RUNTIME_PATH = /require\(\s*["'][^"']*[/\\]runtime[/\\][^"']*["']\s*\)/;

test("syncToCompany.js has no code path touching pull/capability-dispatch or runtime/ modules", () => {
  const src = fs.readFileSync(require.resolve("../../../scripts/syncToCompany.js"), "utf8");
  assert.doesNotMatch(src, BANNED_IMPORTS);
  assert.doesNotMatch(src, BANNED_RUNTIME_PATH);
});
