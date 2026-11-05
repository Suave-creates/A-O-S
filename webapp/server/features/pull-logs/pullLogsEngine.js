// Pull Logs history - READ-ONLY. Looks up finished Manual and Auto pull sessions for a date range (IST
// calendar days), filtered by kind / outcome / a tote or employee ID, one page at a time; and writes the
// same range as a CSV with one row per tote. The live "operations" feed still serves the latest 100.
// Nothing here can start, stop or call a tote.

const auditLog = require("../../platform/audit/auditLog");
const { toEntries, OPERATION_META, OPERATION_ACTIONS } = require("../../platform/audit/operationLog");

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const PAGE_MAX = 100;
const EXPORT_MAX = 5000; // sessions per CSV - a year of pulls is well under this
const DAY_MS = 86400000;

// IST midnight of a YYYY-MM-DD day, as an ISO (UTC) string - audit_logs.created_at is stored that way.
const istMidnight = (day) => new Date(`${day}T00:00:00+05:30`);

function badRequest(message) {
  const e = new Error(message);
  e.code = 400;
  return e;
}

// Query string -> { actions, fromIso, toIso, q }. from/to are inclusive IST days.
function parseFilters(query) {
  const from = String(query.from || "");
  const to = String(query.to || from);
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw badRequest("from and to must be dates (YYYY-MM-DD)");
  const start = istMidnight(from);
  const end = new Date(istMidnight(to).getTime() + DAY_MS);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw badRequest("from and to must be real dates");
  if (end <= start) throw badRequest("from must not be after to");
  if ((end - start) / DAY_MS > MAX_DAYS) throw badRequest(`pick at most ${MAX_DAYS} days`);

  const kind = String(query.kind || "ALL").toUpperCase();
  const status = String(query.status || "ALL").toUpperCase();
  const actions = OPERATION_ACTIONS.filter((a) => {
    const m = OPERATION_META[a];
    return (kind === "ALL" || m.kind === kind) && (status === "ALL" || m.overallStatus === status);
  });
  const q = String(query.q || "").trim().slice(0, 64);
  return { actions, fromIso: start.toISOString(), toIso: end.toISOString(), q };
}

function summarise(counts) {
  const s = { sessions: 0, totes: 0, manual: { sessions: 0, totes: 0 }, auto: { sessions: 0, totes: 0 }, stopped: 0 };
  for (const [action, c] of Object.entries(counts)) {
    const m = OPERATION_META[action];
    if (!m) continue;
    const k = m.kind === "AUTO" ? s.auto : s.manual;
    k.sessions += c.sessions;
    k.totes += c.totes;
    s.sessions += c.sessions;
    s.totes += c.totes;
    if (m.overallStatus === "STOPPED") s.stopped += c.sessions;
  }
  return s;
}

// One page of sessions, newest first. `before` is the auditLogId of the last session already shown.
async function history(query, connectionStatus) {
  const f = parseFilters(query);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), PAGE_MAX);
  const beforeId = query.before != null && query.before !== "" ? parseInt(query.before, 10) : null;
  if (beforeId != null && !Number.isFinite(beforeId)) throw badRequest("before must be a session id");
  if (!f.actions.length) return { entries: [], nextBefore: null, summary: summarise({}) };

  const rows = await auditLog.listByActionsInRange(f.actions, { ...f, beforeId, limit: limit + 1 });
  const more = rows.length > limit;
  const entries = toEntries(rows.slice(0, limit), connectionStatus);
  // the totals only change with the filter, so the next pages skip them
  const summary = beforeId == null ? summarise(await auditLog.countByActionsInRange(f.actions, f)) : undefined;
  return { entries, nextBefore: more ? entries[entries.length - 1].auditLogId : null, summary };
}

const IST = { timeZone: "Asia/Kolkata", hour12: false };
const istDate = (iso) => new Date(iso).toLocaleDateString("en-CA", IST); // YYYY-MM-DD
const istTime = (iso) => new Date(iso).toLocaleTimeString("en-GB", IST); // HH:MM:SS
const cell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const CSV_HEAD = ["Date (IST)", "Time (IST)", "Kind", "Session", "Employee", "Purpose", "Mode", "Session totes",
  "Tote ID", "Priority", "Zone", "Instance", "Attempt", "Result", "Reason"];

// Every session in the range (up to EXPORT_MAX), one CSV row per tote; a session without tote detail
// still gets one row so it is never silently missing.
async function exportCsv(query, connectionStatus) {
  const f = parseFilters(query);
  const lines = [CSV_HEAD.join(",")];
  if (!f.actions.length) return { csv: lines.join("\r\n"), truncated: false };
  const rows = await auditLog.listByActionsInRange(f.actions, { ...f, limit: EXPORT_MAX + 1 });
  const truncated = rows.length > EXPORT_MAX;
  for (const e of toEntries(rows.slice(0, EXPORT_MAX), connectionStatus)) {
    const head = [istDate(e.timestamp), istTime(e.timestamp), e.kind, e.overallStatus, e.employeeId, e.purpose || "", e.mode || "", e.totalItems];
    const details = e.details.length ? e.details : [{}];
    for (const d of details) {
      lines.push([...head, d.toteId, d.priorityAtSelection, d.zone, d.instanceCode, d.attempt, d.verdict, d.reason].map(cell).join(","));
    }
  }
  return { csv: lines.join("\r\n"), truncated };
}

module.exports = { parseFilters, history, exportCsv, EXPORT_MAX };
