// Local-First Phase 1 tests for server/platform/audit/auditLog.js's local-store
// fallback (requirements 5/6/18: completed Manual/Auto operation records
// persist locally and survive a restart; Pull Logs can be built from
// the local store). No real MySQL connection succeeds in this environment
// (config.dbHost is not a reachable server from here), so record() always
// exercises its existing dev-fallback catch branch - exactly the same
// ASO_LOCAL_DEV catch branch, now additionally persisting to disk. No real Quadron/Grafana/
// Concinity/NexS call anywhere in this file.

process.env.ASO_LOCAL_DEV = "true";
process.env.NODE_ENV = "development";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.ASO_LOCAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aso-auditlog-test-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../../../config");
const outbox = require("../../../platform/audit/outbox");
const { toOperationLogEntry } = require("../../../platform/audit/operationLog");

test.after(() => {
  fs.rmSync(process.env.ASO_LOCAL_STORE_DIR, { recursive: true, force: true });
});

function requireFreshAuditLog() {
  delete require.cache[require.resolve("../../../platform/audit/auditLog")];
  return require("../../../platform/audit/auditLog");
}

test("config selected local store mode for this test process", () => {
  assert.equal(config.localStoreMode, "local");
});

test("record() persists a Manual session's TOTE_ENGINE_SESSION_COMPLETED locally, with the hardcoded local-dev identity", async () => {
  const auditLog = requireFreshAuditLog();
  await auditLog.record(-1, "TOTE_ENGINE_SESSION_COMPLETED", {
    sessionId: "Q-000001",
    completedTotes: 3,
    totalTotes: 3,
    zoneConfig: { multiZone: false },
    results: [{ toteId: "TL1", verdict: "INSERTED" }],
  });

  const rows = await auditLog.list(10);
  const row = rows.find((r) => r.action === "TOTE_ENGINE_SESSION_COMPLETED");
  assert.ok(row, "the completed session must be readable back via list()");
  assert.equal(row.employee_id, config.seedAdminId);
  assert.equal(row.role, "ADMIN");
  assert.equal(row.user_id, -1);
  assert.ok(row.created_at);
  const detail = JSON.parse(row.detail);
  assert.equal(detail.sessionId, "Q-000001");
  assert.equal(detail.completedTotes, 3);
});

test("record() with an operation-log-eligible action also appends an outbox entry (entity_type audit_log)", async () => {
  const auditLog = requireFreshAuditLog();
  const before = outbox.list().length;
  await auditLog.record(-1, "AUTO_ENGINE_SESSION_COMPLETED", { sessionId: "Q-000002", results: [] });
  const after = outbox.list();
  assert.equal(after.length, before + 1);
  const entry = after[after.length - 1];
  assert.equal(entry.entity_type, "audit_log");
  assert.equal(entry.payload.action, "AUTO_ENGINE_SESSION_COMPLETED");
  assert.equal(entry.sync_status, "PENDING");
});

test("record() with a non-operation action (LOGIN) persists locally but does NOT append an outbox entry", async () => {
  const auditLog = requireFreshAuditLog();
  const before = outbox.list().length;
  await auditLog.record(-1, "LOGIN", { employeeId: "ADMIN001" });
  assert.equal(outbox.list().length, before, "LOGIN is not a syncable operation");
  const rows = await auditLog.list(50);
  assert.ok(rows.some((r) => r.action === "LOGIN"), "LOGIN must still be persisted for local audit continuity");
});

test("all four Manual/Auto session actions append exactly one outbox entry each", async () => {
  const auditLog = requireFreshAuditLog();
  const actions = [
    "TOTE_ENGINE_SESSION_COMPLETED",
    "TOTE_ENGINE_SESSION_STOPPED",
    "AUTO_ENGINE_SESSION_COMPLETED",
    "AUTO_ENGINE_SESSION_STOPPED",
  ];
  for (const action of actions) {
    const before = outbox.list().filter((e) => e.payload.action === action).length;
    await auditLog.record(-1, action, { sessionId: `Q-${action}`, results: [] });
    const after = outbox.list().filter((e) => e.payload.action === action).length;
    assert.equal(after, before + 1, `${action} must append exactly one outbox entry`);
  }
});

test("audit trail survives a simulated backend restart", async () => {
  const auditLog1 = requireFreshAuditLog();
  await auditLog1.record(-1, "TOTE_ENGINE_SESSION_COMPLETED", { sessionId: "Q-RESTART-1", results: [] });

  const auditLog2 = requireFreshAuditLog(); // simulated restart
  const rows = await auditLog2.list(50);
  assert.ok(rows.some((r) => JSON.parse(r.detail).sessionId === "Q-RESTART-1"), "the row must still exist after restart");
});

test("listByActions() filters to exactly the requested actions, most recent first, respecting limit", async () => {
  const auditLog = requireFreshAuditLog();
  await auditLog.record(-1, "TOTE_ENGINE_SESSION_COMPLETED", { sessionId: "Q-FILTER-1", results: [] });
  await auditLog.record(-1, "LOGIN", { employeeId: "ADMIN001" });
  await auditLog.record(-1, "TOTE_ENGINE_SESSION_STOPPED", { sessionId: "Q-FILTER-2", results: [] });

  const rows = await auditLog.listByActions(["TOTE_ENGINE_SESSION_COMPLETED", "TOTE_ENGINE_SESSION_STOPPED"], 200);
  assert.ok(rows.every((r) => r.action === "TOTE_ENGINE_SESSION_COMPLETED" || r.action === "TOTE_ENGINE_SESSION_STOPPED"));
  assert.ok(!rows.some((r) => r.action === "LOGIN"));
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].id >= rows[i].id, "must be ordered most-recent-first");
  }
});

test("Operation Logs can be fully built from the local store (listByActions + toOperationLogEntry, as the Pull Logs feed does)", async () => {
  const auditLog = requireFreshAuditLog();
  await auditLog.record(-1, "TOTE_ENGINE_SESSION_COMPLETED", {
    sessionId: "Q-OPLOG-1",
    totalTotes: 2,
    zoneConfig: { multiZone: false },
    results: [
      { toteId: "TL1", zone: "Z1", attempt: 1, verdict: "INSERTED" },
      { toteId: "TL2", zone: "Z1", attempt: 1, verdict: "RELEASED" },
    ],
  });

  const rows = await auditLog.listByActions(["TOTE_ENGINE_SESSION_COMPLETED", "TOTE_ENGINE_SESSION_STOPPED"], 50);
  const row = rows.find((r) => r.action === "TOTE_ENGINE_SESSION_COMPLETED" && JSON.parse(r.detail).sessionId === "Q-OPLOG-1");
  assert.ok(row);

  const entry = toOperationLogEntry({ ...row, detail: JSON.parse(row.detail) }, { concinity: { connected: true, identity: "ADMIN001" } });
  assert.ok(entry);
  assert.equal(entry.sessionId, "Q-OPLOG-1");
  assert.equal(entry.operationType, "Manual Tote Pull");
  assert.equal(entry.totalItems, 2);
  assert.equal(entry.statusCounts.INSERTED, 1);
  assert.equal(entry.statusCounts.RELEASED, 1);
});
