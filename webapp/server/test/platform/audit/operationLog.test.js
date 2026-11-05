// Pure unit tests for server/platform/audit/operationLog.js - the grouped operation
// log. No database, no network, no Quadron call.

const test = require("node:test");
const assert = require("node:assert/strict");
const { toOperationLogEntry, summarizeResults } = require("../../../platform/audit/operationLog");

const CONNECTED_STATUS = {
  grafana: { connected: true, identity: "Connected" },
  concinity: { connected: true, identity: "Connected" },
  nexs: { connected: false, identity: "Not connected" },
};

function toteResult(toteId, verdict, zone = "5", attempt = 1) {
  return { toteId, verdict, zone, attempt, queryId: `Q-${toteId}`, rawMessage: `Quadron says ${verdict}` };
}

function auditRow(overrides = {}) {
  return {
    id: 1,
    created_at: "2026-08-22T11:32:04.000Z",
    employee_id: "Ashutosh",
    role: "ADMIN",
    action: "TOTE_ENGINE_SESSION_COMPLETED",
    detail: {
      sessionId: "Q-000042",
      totalTotes: 3,
      completedTotes: 3,
      zoneConfig: { multiZone: true, zones: [{ id: "a", zone: "5", instanceCode: "LK-069", percentage: 100 }] },
      results: [toteResult("TS0000039053", "INSERTED"), toteResult("TS0000015045", "INSERTED"), toteResult("TL0000009207", "NOT_AVAILABLE")],
    },
    ...overrides,
  };
}

// ── Grouping: ONE parent record per operation, N details underneath ────

test("a 3-tote operation produces exactly ONE parent entry with exactly THREE nested details", () => {
  const entry = toOperationLogEntry(auditRow(), CONNECTED_STATUS);
  assert.equal(entry.totalItems, 3);
  assert.equal(entry.details.length, 3);
});

test("a 50-tote operation produces exactly ONE parent entry with exactly 50 nested details - not 50 top-level entries", () => {
  const results = Array.from({ length: 50 }, (_, i) => toteResult(`TL${String(i).padStart(10, "0")}`, "INSERTED"));
  const row = auditRow({ detail: { sessionId: "Q-000099", totalTotes: 50, results, zoneConfig: null } });
  const entry = toOperationLogEntry(row, CONNECTED_STATUS);

  assert.equal(entry.totalItems, 50);
  assert.equal(entry.details.length, 50);
  // Still exactly one entry - toOperationLogEntry() always returns a single
  // object, never an array, regardless of how many totes were involved.
  assert.equal(Array.isArray(entry), false);
});

// ── Summary counts match detail verdicts ────────────────────────────────

test("summary counts exactly match the verdicts present in the details", () => {
  const entry = toOperationLogEntry(auditRow(), CONNECTED_STATUS);
  assert.deepEqual(entry.statusCounts, { INSERTED: 2, NOT_AVAILABLE: 1 });

  const total = Object.values(entry.statusCounts).reduce((s, n) => s + n, 0);
  assert.equal(total, entry.details.length);
});

test("summarizeResults handles SKIPPED/CANCELLED per-tote terminals the same way as verdicts", () => {
  const results = [
    { toteId: "A", verdict: "INSERTED" },
    { toteId: "B", terminal: "SKIPPED" },
    { toteId: "C", terminal: "CANCELLED" },
  ];
  assert.deepEqual(summarizeResults(results), { INSERTED: 1, SKIPPED: 1, CANCELLED: 1 });
});

// ── Expand/collapse indicator data ──────────────────────────────────────

test("each detail row carries exactly what the expanded table needs: toteId, priorityAtSelection, zone, instanceCode, attempt, verdict, reason", () => {
  const entry = toOperationLogEntry(auditRow(), CONNECTED_STATUS);
  const first = entry.details[0];
  assert.deepEqual(Object.keys(first).sort(), ["attempt", "instanceCode", "priorityAtSelection", "reason", "toteId", "verdict", "zone"].sort());
  assert.equal(first.toteId, "TS0000039053");
  assert.equal(first.zone, "5");
  assert.equal(first.attempt, 1);
  assert.equal(first.verdict, "INSERTED");
  assert.equal(first.priorityAtSelection, null, "Manual results carry no priority - must be null, not undefined/omitted");
  assert.equal(first.instanceCode, null, "this fixture's raw result has no instanceCode field");
});

// ── User identity ────────────────────────────────────────────────────────

test("employee id and role come from the joined users row, not fabricated", () => {
  const entry = toOperationLogEntry(auditRow({ employee_id: "PriyaK", role: "USER" }), CONNECTED_STATUS);
  assert.equal(entry.employeeId, "PriyaK");
  assert.equal(entry.role, "USER");
});

// ── Connection identity matches the shared model exactly ───────────────

test("the log entry's account identity is EXACTLY the shared connection-status snapshot's value - not independently computed", () => {
  const connectedEntry = toOperationLogEntry(auditRow(), CONNECTED_STATUS);
  assert.equal(connectedEntry.accountIdentity, CONNECTED_STATUS.concinity.identity);
  assert.equal(connectedEntry.connected, CONNECTED_STATUS.concinity.connected);

  const disconnectedStatus = { ...CONNECTED_STATUS, concinity: { connected: false, identity: "Not connected" } };
  const disconnectedEntry = toOperationLogEntry(auditRow(), disconnectedStatus);
  assert.equal(disconnectedEntry.accountIdentity, "Not connected");
  assert.equal(disconnectedEntry.connected, false);
});

test("missing connection status entirely falls back to the safe disconnected state, never throws, never fabricates", () => {
  const entry = toOperationLogEntry(auditRow(), null);
  assert.equal(entry.accountIdentity, "Not connected");
  assert.equal(entry.connected, false);
});

// ── Never leak secrets ───────────────────────────────────────────────────

test("no JWT/token/password/cookie/authorization-header text appears anywhere in a log entry", () => {
  const row = auditRow({
    detail: {
      sessionId: "Q-000042",
      totalTotes: 1,
      results: [{ toteId: "TL0000002607", verdict: "INSERTED", zone: "5", attempt: 1, rawMessage: "queued ok" }],
    },
  });
  const entry = toOperationLogEntry(row, CONNECTED_STATUS);
  const text = JSON.stringify(entry).toLowerCase();
  for (const forbidden of ["authorization", "bearer ", "jwt", "password", "cookie"]) {
    assert.ok(!text.includes(forbidden), `entry must never contain "${forbidden}"`);
  }
});

test("a result that somehow carries a suspicious field causes a hard failure rather than a silent leak", () => {
  const row = auditRow({
    detail: {
      sessionId: "Q-000042",
      totalTotes: 1,
      results: [{ toteId: "TL0000002607", verdict: "INSERTED", zone: "5", attempt: 1, rawMessage: "Authorization: Bearer abc.def.ghi" }],
    },
  });
  assert.throws(() => toOperationLogEntry(row, CONNECTED_STATUS), /suspicious content/);
});

// ── Ineligible audit actions are filtered out, not mis-shaped ──────────

test("an audit row for an unrelated action returns null, not a malformed entry", () => {
  const entry = toOperationLogEntry(auditRow({ action: "LOGIN" }), CONNECTED_STATUS);
  assert.equal(entry, null);
});

// ── Mode reflects the zone config, not fabricated ───────────────────────

test("mode is 'Multi-Zone' or 'Single-Zone' based on the actual zoneConfig, null if absent", () => {
  const multi = toOperationLogEntry(auditRow(), CONNECTED_STATUS);
  assert.equal(multi.mode, "Multi-Zone");

  const single = toOperationLogEntry(
    auditRow({ detail: { ...auditRow().detail, zoneConfig: { multiZone: false, zone: "5", instanceCode: "LK-069" } } }),
    CONNECTED_STATUS
  );
  assert.equal(single.mode, "Single-Zone");

  const none = toOperationLogEntry(auditRow({ detail: { ...auditRow().detail, zoneConfig: null } }), CONNECTED_STATUS);
  assert.equal(none.mode, null);
});

// ── Auto Mode grouped logging ─────────────────────────────────────────────

function autoToteResult(toteId, verdict, priorityAtSelection, zone = "5", instanceCode = "LK-069", attempt = 1) {
  return { toteId, verdict, priorityAtSelection, zone, instanceCode, attempt, queryId: `Q-${toteId}`, rawMessage: `Quadron says ${verdict}` };
}

function autoAuditRow(overrides = {}) {
  return auditRow({
    action: "AUTO_ENGINE_SESSION_STOPPED",
    detail: {
      sessionId: "AQ-000007",
      totalTotes: 3,
      zoneConfig: { multiZone: false, zone: "5", instanceCode: "LK-069" },
      results: [
        autoToteResult("TS0000000001", "INSERTED", "SD"),
        autoToteResult("TS0000000002", "INSERTED", "P0"),
        autoToteResult("TS0000000003", "NOT_AVAILABLE", "P2"),
      ],
    },
    ...overrides,
  });
}

test("an Auto session is recognized as an operation-log-eligible action with operationType 'Auto Tote Pull'", () => {
  const entry = toOperationLogEntry(autoAuditRow(), CONNECTED_STATUS);
  assert.ok(entry, "AUTO_ENGINE_SESSION_STOPPED must be a recognized operation type");
  assert.equal(entry.operationType, "Auto Tote Pull");
  assert.equal(entry.system, "concinity");
});

test("every entry says whether it was a Manual or an Auto pull (Pull Logs filters and badges on kind)", () => {
  assert.equal(toOperationLogEntry(autoAuditRow(), CONNECTED_STATUS).kind, "AUTO");
  assert.equal(toOperationLogEntry(autoAuditRow({ action: "TOTE_ENGINE_SESSION_COMPLETED" }), CONNECTED_STATUS).kind, "MANUAL");
  assert.equal(toOperationLogEntry(autoAuditRow({ action: "TOTE_ENGINE_SESSION_STOPPED" }), CONNECTED_STATUS).kind, "MANUAL");
});

test("AUTO_ENGINE_SESSION_COMPLETED maps to overallStatus COMPLETED; AUTO_ENGINE_SESSION_STOPPED maps to STOPPED", () => {
  const stopped = toOperationLogEntry(autoAuditRow(), CONNECTED_STATUS);
  assert.equal(stopped.overallStatus, "STOPPED");
  const completed = toOperationLogEntry(autoAuditRow({ action: "AUTO_ENGINE_SESSION_COMPLETED" }), CONNECTED_STATUS);
  assert.equal(completed.overallStatus, "COMPLETED");
});

test("an Auto session's 50-tote run is still ONE grouped parent entry, exactly like Manual - never one row per tote", () => {
  const results = Array.from({ length: 50 }, (_, i) => autoToteResult(`TL${String(i).padStart(10, "0")}`, "INSERTED", i % 4 === 0 ? "P0" : "P2"));
  const entry = toOperationLogEntry(autoAuditRow({ detail: { sessionId: "AQ-BIG", totalTotes: 50, zoneConfig: null, results } }), CONNECTED_STATUS);
  assert.equal(entry.totalItems, 50);
  assert.equal(entry.details.length, 50);
});

test("Auto's per-tote detail exposes priorityAtSelection (the priority the tote actually had when the batch picked it)", () => {
  const entry = toOperationLogEntry(autoAuditRow(), CONNECTED_STATUS);
  assert.deepEqual(entry.details.map((d) => d.priorityAtSelection), ["SD", "P0", "P2"]);
  assert.equal(entry.details[0].instanceCode, "LK-069");
});

test("Auto's summary counts match its own per-tote verdicts, same aggregation Manual uses", () => {
  const entry = toOperationLogEntry(autoAuditRow(), CONNECTED_STATUS);
  assert.deepEqual(entry.statusCounts, { INSERTED: 2, NOT_AVAILABLE: 1 });
});

test("Auto and Manual entries never leak a JWT/token/password/cookie", () => {
  const entry = toOperationLogEntry(autoAuditRow(), CONNECTED_STATUS);
  const text = JSON.stringify(entry).toLowerCase();
  for (const bad of ["authorization", "bearer ", "jwt", "password", "cookie"]) {
    assert.ok(!text.includes(bad), `must not contain "${bad}"`);
  }
});

test("toEntries (used by the live operation-log feeds) turns raw rows with a JSON detail string into grouped entries", () => {
  const { toEntries } = require("../../../platform/audit/operationLog");
  const raw = auditRow({ detail: JSON.stringify(auditRow().detail) });
  const entries = toEntries([raw, auditRow({ id: 2, detail: "not json" })], CONNECTED_STATUS);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].totalItems, 3);
  assert.equal(entries[0].details.length, 3);
  assert.deepEqual(toEntries([], CONNECTED_STATUS), []);
});
