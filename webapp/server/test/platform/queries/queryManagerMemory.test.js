// Tests for server/platform/queries/queryManagerMemory.js - the in-memory Query Manager
// adapter, compared against the observable contract queryManagerMysql.js
// guarantees (same function signatures, same status lifecycle, same field
// shapes, same error codes). No real MySQL connection anywhere in this
// file - process.env is set BEFORE any require() so config.localDevAuthEnabled
// is true for this file's own isolated test process (node --test runs each
// file in its own process - verified empirically before writing this file),
// which makes auditLog.record()'s existing dev-fallback activate instead of
// throwing on the genuinely-unreachable MySQL in this environment. No real
// Quadron/Grafana/Concinity call anywhere in this file either.
//
// ASO_LOCAL_STORE_DIR points localStore.js (Local-First Phase 1) at a
// throwaway temp directory for this process only, so this suite's rows
// never touch the real webapp/.local-dev-data/ and never see pre-existing
// data from it either - see server/test/queryManagerMemoryPersistence.test.js
// for the tests that actually exercise disk persistence/outbox behavior.

process.env.ASO_LOCAL_DEV = "true";
process.env.NODE_ENV = "development";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.ASO_LOCAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aso-qmm-test-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../../../config");
const queryManagerMemory = require("../../../platform/queries/queryManagerMemory");

test.after(() => {
  fs.rmSync(process.env.ASO_LOCAL_STORE_DIR, { recursive: true, force: true });
});

const ADMIN = { id: -1, role: "ADMIN" };
const OTHER_USER = { id: 2, role: "USER" };

test("config selected memory mode for this test process", () => {
  assert.equal(config.localDevAuthEnabled, true);
  assert.equal(config.queryManagerMode, "memory");
});

// ── createQuery ────────────────────────────────────────────────────────

test("createQuery: returns the exact row shape queryManagerMysql.js produces", async () => {
  const row = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_SHAPE", parameters: { toteId: "TL0000000001" } });
  assert.match(row.query_id, /^Q-\d{6}$/, "query_id must be formatted Q-XXXXXX, same as MySQL's LPAD(id,6,'0')");
  assert.equal(row.status, "QUEUED");
  assert.equal(row.user_id, -1);
  assert.equal(row.operation, "TEST_SHAPE");
  assert.equal(typeof row.parameters, "string", "parameters must be a JSON STRING, exactly like the MySQL column - not an object");
  assert.deepEqual(JSON.parse(row.parameters), { toteId: "TL0000000001" });
  assert.equal(row.started_at, null);
  assert.equal(row.completed_at, null);
  assert.equal(row.cancelled_at, null);
  assert.equal(row.error, null);
  assert.ok(row.created_at);
});

test("createQuery: defaults parameters to {} when omitted, matching MySQL's JSON.stringify(parameters||{})", async () => {
  const row = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_DEFAULT_PARAMS" });
  assert.equal(row.parameters, "{}");
});

test("createQuery: employee_id is populated from config.seedAdminId (the one identity this mode ever produces)", async () => {
  const row = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_EMPLOYEE_ID" });
  assert.equal(row.employee_id, config.seedAdminId);
});

test("createQuery: each call gets a distinct, incrementing query_id", async () => {
  const a = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_INCREMENT" });
  const b = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_INCREMENT" });
  assert.notEqual(a.query_id, b.query_id);
});

// ── Lifecycle: QUEUED -> RUNNING -> COMPLETED/FAILED/CANCELLED ──────────

test("markRunning: transitions QUEUED -> RUNNING and sets started_at once", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_MARK_RUNNING" });
  queryManagerMemory.registerJob(created.query_id, new AbortController()); // simulates a real in-flight job, not a post-restart stale row
  await queryManagerMemory.markRunning(created.query_id);
  const afterFirst = await queryManagerMemory.getQuery(created.query_id);
  assert.equal(afterFirst.status, "RUNNING");
  const firstStartedAt = afterFirst.started_at;
  assert.ok(firstStartedAt);

  await new Promise((r) => setTimeout(r, 5));
  await queryManagerMemory.markRunning(created.query_id); // called again, e.g. idempotently
  const afterSecond = await queryManagerMemory.getQuery(created.query_id);
  assert.equal(afterSecond.started_at, firstStartedAt, "started_at must not be overwritten on a second markRunning call - mirrors MySQL's COALESCE(started_at, ?)");
});

test("completeQuery: sets status COMPLETED and completed_at, clears the job registry", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_COMPLETE" });
  queryManagerMemory.registerJob(created.query_id, new AbortController());
  await queryManagerMemory.completeQuery(created.query_id);
  const row = await queryManagerMemory.getQuery(created.query_id);
  assert.equal(row.status, "COMPLETED");
  assert.ok(row.completed_at);
  assert.equal(row.cancelled_at, null);
  assert.equal(row.error, null);
});

test("failQuery: sets status FAILED, completed_at, and the error message (stringified)", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_FAIL" });
  await queryManagerMemory.failQuery(created.query_id, new Error("boom"));
  const row = await queryManagerMemory.getQuery(created.query_id);
  assert.equal(row.status, "FAILED");
  assert.equal(row.error, "Error: boom");
});

test("failQuery: a missing/falsy error becomes 'Unknown error', matching MySQL's String(error||'Unknown error')", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_FAIL_UNKNOWN" });
  await queryManagerMemory.failQuery(created.query_id);
  const row = await queryManagerMemory.getQuery(created.query_id);
  assert.equal(row.error, "Unknown error");
});

test("timeoutQuery: sets status TIMEOUT with the fixed backend-gave-up message", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_TIMEOUT" });
  await queryManagerMemory.timeoutQuery(created.query_id);
  const row = await queryManagerMemory.getQuery(created.query_id);
  assert.equal(row.status, "TIMEOUT");
  assert.match(row.error, /Backend gave up waiting/);
});

test("timeoutQuery: the message is capability-agnostic - never names one specific capability (e.g. 'Apps Script'), since this function is shared by every capability (Grafana/Quadron/NexS single-PID and batch/Apps Script)", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "GET_QUADRON_INVENTORY" });
  await queryManagerMemory.timeoutQuery(created.query_id);
  const row = await queryManagerMemory.getQuery(created.query_id);
  assert.doesNotMatch(row.error, /Apps Script/i, "a GET_QUADRON_INVENTORY timeout must never be reported as an Apps Script timeout");
});

test("finalizeCancelled: sets status CANCELLED and cancelled_at, not completed_at", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_FINALIZE_CANCEL" });
  await queryManagerMemory.finalizeCancelled(created.query_id);
  const row = await queryManagerMemory.getQuery(created.query_id);
  assert.equal(row.status, "CANCELLED");
  assert.ok(row.cancelled_at);
  assert.equal(row.completed_at, null);
});

// ── registerJob / unregisterJob / stale reconciliation ───────────────────

test("registerJob/unregisterJob: purely in-memory bookkeeping, independent of the row itself", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_REGISTER_JOB" });
  const controller = new AbortController();
  const job = queryManagerMemory.registerJob(created.query_id, controller);
  assert.equal(job.wasCancelledByUser(), false);
  assert.equal(job.signal, controller.signal);
  queryManagerMemory.unregisterJob(created.query_id);
});

test("reconcileStale (via getQuery): a QUEUED/RUNNING row with no live job registry entry is surfaced as FAILED with the restart message", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_STALE" });
  await queryManagerMemory.markRunning(created.query_id);
  // Deliberately never registerJob() - simulates a backend restart, where
  // the row is still RUNNING in storage but no live AbortController exists.
  const row = await queryManagerMemory.getQuery(created.query_id);
  assert.equal(row.status, "FAILED");
  assert.equal(row.error, "Backend restarted before this query finished");
});

test("reconcileStale: a row WITH a live registered job is left alone (not falsely reconciled)", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_NOT_STALE" });
  await queryManagerMemory.markRunning(created.query_id);
  queryManagerMemory.registerJob(created.query_id, new AbortController());
  const row = await queryManagerMemory.getQuery(created.query_id);
  assert.equal(row.status, "RUNNING", "must not be reconciled to FAILED while a live job is registered");
});

test("reconcileStale applies inside listQueries() too, not just getQuery()", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_STALE_LIST" });
  await queryManagerMemory.markRunning(created.query_id);
  const rows = await queryManagerMemory.listQueries({ userId: -1, isAdmin: true, limit: 500 });
  const found = rows.find((r) => r.query_id === created.query_id);
  assert.equal(found.status, "FAILED");
});

// Phase 7, Issue 2: an AUTO_ENGINE_SESSION row left RUNNING by an interrupted
// backend restart (no live registerJob() entry, same as any other operation)
// must reconcile to FAILED, and a Cancel attempt against it afterward must
// be safely rejected (409, "already FAILED") rather than crashing or acting
// on a registry entry that no longer exists - proving cancelQuery()'s
// ACTIVE_STATUSES check runs BEFORE it ever touches the registry.
test("cancel after backend reconciliation: an AUTO_ENGINE_SESSION reconciled to FAILED cannot be cancelled, and cancelQuery() never touches a missing registry entry", async () => {
  const admin = { id: -1, role: "ADMIN" };
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "AUTO_ENGINE_SESSION", parameters: {} });
  await queryManagerMemory.markRunning(created.query_id);
  // Deliberately never registerJob() - simulates AutoEngine.sessions having
  // been wiped by a real backend restart while the DB row still says RUNNING.

  const reconciled = await queryManagerMemory.getQuery(created.query_id);
  assert.equal(reconciled.status, "FAILED");

  const result = await queryManagerMemory.cancelQuery(created.query_id, admin);
  assert.equal(result.ok, false);
  assert.equal(result.code, 409);
  assert.match(result.reason, /already FAILED/);
});

// ── findActiveByParam - duplicate-in-flight guard (PULL_QUADRON_TOTE) ────

test("findActiveByParam: finds a QUEUED query matching operation+param", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "PULL_QUADRON_TOTE", parameters: { toteId: "TL0000009999" } });
  const found = await queryManagerMemory.findActiveByParam("PULL_QUADRON_TOTE", "toteId", "TL0000009999");
  assert.ok(found);
  assert.equal(found.query_id, created.query_id);
});

test("findActiveByParam: finds a RUNNING query too", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "PULL_QUADRON_TOTE", parameters: { toteId: "TL0000008888" } });
  await queryManagerMemory.markRunning(created.query_id);
  const found = await queryManagerMemory.findActiveByParam("PULL_QUADRON_TOTE", "toteId", "TL0000008888");
  assert.ok(found);
});

test("findActiveByParam: does NOT match a CANCEL_REQUESTED query - mirrors MySQL's status IN ('QUEUED','RUNNING') exactly, deliberately narrower than ACTIVE_STATUSES", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "PULL_QUADRON_TOTE", parameters: { toteId: "TL0000007777" } });
  await queryManagerMemory.markRunning(created.query_id);
  queryManagerMemory.registerJob(created.query_id, new AbortController());
  await queryManagerMemory.cancelQuery(created.query_id, ADMIN); // -> CANCEL_REQUESTED (controller registered, not finalized)
  const row = await queryManagerMemory.getQuery(created.query_id);
  assert.equal(row.status, "CANCEL_REQUESTED");
  const found = await queryManagerMemory.findActiveByParam("PULL_QUADRON_TOTE", "toteId", "TL0000007777");
  assert.equal(found, null, "a CANCEL_REQUESTED query must not block a fresh duplicate pull for the same tote");
});

test("findActiveByParam: does not match a COMPLETED/FAILED/CANCELLED query", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "PULL_QUADRON_TOTE", parameters: { toteId: "TL0000006666" } });
  await queryManagerMemory.completeQuery(created.query_id);
  const found = await queryManagerMemory.findActiveByParam("PULL_QUADRON_TOTE", "toteId", "TL0000006666");
  assert.equal(found, null);
});

test("findActiveByParam: does not match a different operation or a different param value", async () => {
  await queryManagerMemory.createQuery({ userId: -1, operation: "PULL_QUADRON_TOTE", parameters: { toteId: "TL0000005555" } });
  assert.equal(await queryManagerMemory.findActiveByParam("SOME_OTHER_OP", "toteId", "TL0000005555"), null);
  assert.equal(await queryManagerMemory.findActiveByParam("PULL_QUADRON_TOTE", "toteId", "TL0000000000"), null);
});

// ── cancelQuery ────────────────────────────────────────────────────────

test("cancelQuery: 404 for an unknown query id", async () => {
  const result = await queryManagerMemory.cancelQuery("Q-999999", ADMIN);
  assert.equal(result.ok, false);
  assert.equal(result.code, 404);
});

test("cancelQuery: 403 when a non-admin, non-owner user tries to cancel someone else's query", async () => {
  const created = await queryManagerMemory.createQuery({ userId: 999, operation: "TEST_CANCEL_403" });
  const result = await queryManagerMemory.cancelQuery(created.query_id, OTHER_USER);
  assert.equal(result.ok, false);
  assert.equal(result.code, 403);
});

test("cancelQuery: 409 when the query is already terminal", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_CANCEL_409" });
  await queryManagerMemory.completeQuery(created.query_id);
  const result = await queryManagerMemory.cancelQuery(created.query_id, ADMIN);
  assert.equal(result.ok, false);
  assert.equal(result.code, 409);
});

test("cancelQuery: with a registered job, moves to CANCEL_REQUESTED and aborts the controller (does not finalize immediately)", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_CANCEL_WITH_JOB" });
  const controller = new AbortController();
  queryManagerMemory.registerJob(created.query_id, controller);
  const result = await queryManagerMemory.cancelQuery(created.query_id, ADMIN);
  assert.equal(result.ok, true);
  assert.equal(result.query.status, "CANCEL_REQUESTED");
  assert.equal(controller.signal.aborted, true, "the AbortController must actually be aborted");
});

test("cancelQuery: with NO registered job (still QUEUED, never started), finalizes directly to CANCELLED", async () => {
  const created = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_CANCEL_NO_JOB" });
  const result = await queryManagerMemory.cancelQuery(created.query_id, ADMIN);
  assert.equal(result.ok, true);
  assert.equal(result.query.status, "CANCELLED");
});

test("cancelQuery: the owning (non-admin) user may cancel their own query", async () => {
  const created = await queryManagerMemory.createQuery({ userId: 2, operation: "TEST_CANCEL_OWNER" });
  const result = await queryManagerMemory.cancelQuery(created.query_id, OTHER_USER);
  assert.equal(result.ok, true);
});

// ── listQueries ────────────────────────────────────────────────────────

test("listQueries: isAdmin=true returns queries from every user; isAdmin=false only the requesting user's own", async () => {
  await queryManagerMemory.createQuery({ userId: 111, operation: "TEST_LIST_SCOPING" });
  await queryManagerMemory.createQuery({ userId: 222, operation: "TEST_LIST_SCOPING" });

  const admin = await queryManagerMemory.listQueries({ userId: -1, isAdmin: true, limit: 500 });
  const scoped = admin.filter((r) => r.operation === "TEST_LIST_SCOPING");
  assert.equal(scoped.length, 2);

  const userOnly = await queryManagerMemory.listQueries({ userId: 111, isAdmin: false, limit: 500 });
  const userScoped = userOnly.filter((r) => r.operation === "TEST_LIST_SCOPING");
  assert.equal(userScoped.length, 1);
  assert.equal(userScoped[0].user_id, 111);
});

test("listQueries: newest first (descending by id), matching MySQL's ORDER BY q.id DESC", async () => {
  const a = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_LIST_ORDER" });
  const b = await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_LIST_ORDER" });
  const rows = await queryManagerMemory.listQueries({ userId: -1, isAdmin: true, limit: 500 });
  const scoped = rows.filter((r) => r.operation === "TEST_LIST_ORDER");
  assert.deepEqual(scoped.map((r) => r.query_id), [b.query_id, a.query_id]);
});

test("listQueries: respects limit", async () => {
  for (let i = 0; i < 5; i++) await queryManagerMemory.createQuery({ userId: -1, operation: "TEST_LIST_LIMIT" });
  const rows = await queryManagerMemory.listQueries({ userId: -1, isAdmin: true, limit: 2 });
  assert.ok(rows.length <= 2);
});

// ── No real Quadron mutation possible via this module ────────────────────
const REQUIRES_PULL_OR_CAPABILITY_MODULE = /require\(\s*["'][^"']*(totePullEngine|autoEngine|quadronPull|capabilityManager|pullQuadronTote)["']\s*\)/;

test("queryManagerMemory.js has no code path touching pull/capability-dispatch modules", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../../../platform/queries/queryManagerMemory.js"), "utf8");
  assert.doesNotMatch(src, REQUIRES_PULL_OR_CAPABILITY_MODULE);
});
