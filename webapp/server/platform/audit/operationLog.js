// Pure shaping of an audit_logs row into a grouped operation-log entry -
// ONE parent record per operation (e.g. a 50-tote Manual session), with the
// full per-tote detail nested underneath, never one top-level entry per
// tote. Reuses the exact same connection-status identity the header
// component shows (see connectionStatus.js) - the caller passes in one
// shared `connectionStatus` snapshot; this file never computes its own.

// Which audit actions are "operations" the log surfaces, and what each one
// means. Adding a future operation type (Auto Tote Pull, a NexS bulk
// action, ...) means adding one more entry here - never a schema change,
// since this reads the same `audit_logs` table every other audit action
// already writes to.
// `kind` is what the Pull Logs screen filters and badges on: MANUAL (operator-typed tote list) vs AUTO
// (priority-based Auto Puller).
const OPERATION_META = {
  TOTE_ENGINE_SESSION_COMPLETED: { system: "concinity", kind: "MANUAL", operationType: "Manual Tote Pull", overallStatus: "COMPLETED" },
  TOTE_ENGINE_SESSION_STOPPED: { system: "concinity", kind: "MANUAL", operationType: "Manual Tote Pull", overallStatus: "STOPPED" },
  AUTO_ENGINE_SESSION_COMPLETED: { system: "concinity", kind: "AUTO", operationType: "Auto Tote Pull", overallStatus: "COMPLETED" },
  AUTO_ENGINE_SESSION_STOPPED: { system: "concinity", kind: "AUTO", operationType: "Auto Tote Pull", overallStatus: "STOPPED" },
};
// Every audit action the Pull Logs feed reads - Manual and Auto together.
const OPERATION_ACTIONS = Object.keys(OPERATION_META);

// Defense in depth only - the underlying data (toteId/zone/attempt/verdict/
// rawMessage, all sourced from PULL_QUADRON_TOTE's own validated result
// shape) never carries a token/password/cookie in the first place. This
// scan exists so a future regression upstream fails loudly here instead of
// silently shipping a suspicious log entry.
const SUSPICIOUS_PATTERN = /(authorization|bearer\s|jwt|password|cookie)/i;

function summarizeResults(results) {
  const summary = {};
  for (const r of results || []) {
    const key = r.verdict || r.terminal;
    if (!key) continue;
    summary[key] = (summary[key] || 0) + 1;
  }
  return summary;
}

// auditRow: { id, created_at, employee_id, role, action, detail } - detail
// already parsed from JSON (the caller owns parsing/try-catch, since that's
// I/O-shape handling, not this pure function's job).
function toOperationLogEntry(auditRow, connectionStatus) {
  const meta = OPERATION_META[auditRow.action];
  if (!meta) return null; // not an operation-log-eligible audit action

  const detail = auditRow.detail || {};
  const results = Array.isArray(detail.results) ? detail.results : [];
  const zoneConfig = detail.zoneConfig || null;
  const status = connectionStatus && connectionStatus[meta.system];

  const entry = {
    auditLogId: auditRow.id,
    sessionId: detail.sessionId || null,
    timestamp: auditRow.created_at,
    employeeId: auditRow.employee_id,
    role: auditRow.role,
    system: meta.system,
    accountIdentity: status ? status.identity : "Not connected",
    connected: status ? !!status.connected : false,
    kind: meta.kind,
    operationType: meta.operationType,
    purpose: detail.purpose === "PURGE" ? "PURGE" : null, // Manual sessions called to purge totes
    mode: zoneConfig ? (zoneConfig.multiZone ? "Multi-Zone" : "Single-Zone") : null,
    totalItems: detail.totalTotes != null ? detail.totalTotes : results.length,
    statusCounts: summarizeResults(results),
    overallStatus: meta.overallStatus,
    details: results.map((r) => ({
      toteId: r.toteId,
      priorityAtSelection: r.priorityAtSelection ?? null, // Auto-only - null for Manual, which has no priority concept
      zone: r.zone,
      instanceCode: r.instanceCode ?? null,
      attempt: r.attempt,
      verdict: r.verdict || r.terminal,
      reason: r.rawMessage || r.reason || null,
    })),
  };

  if (SUSPICIOUS_PATTERN.test(JSON.stringify(entry))) {
    // Fail safe rather than ever return a suspicious-looking log entry.
    throw new Error(`Refusing to build operation log entry for audit_logs id=${auditRow.id}: suspicious content detected`);
  }
  return entry;
}

// Raw audit_logs rows (detail still a JSON string) -> the grouped operation-log entries the screens show.
// Shared by the live feeds; the routes build the same shape with toOperationLogEntry directly.
function toEntries(rows, connectionStatus) {
  return rows
    .map((row) => {
      let detail = {};
      try {
        detail = row.detail ? JSON.parse(row.detail) : {};
      } catch (e) {
        detail = {};
      }
      return toOperationLogEntry({ ...row, detail }, connectionStatus);
    })
    .filter(Boolean);
}

module.exports = { toOperationLogEntry, toEntries, summarizeResults, OPERATION_META, OPERATION_ACTIONS };
