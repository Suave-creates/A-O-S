// Locked Tote Analytics - gathers what toteAnalytics.analyse() needs for a range of site days and runs it:
//   the cycle-count trail of every day in range plus REPORT_WINDOW before it (ccDayRows: stored closed days,
//   today read fresh), AOS pull sessions (audit log), purge pulls, and the latest Locked Totes snapshot.
// Closed days not stored yet are read in the background, paced (ccDayRows.fillDays); until then the answer says
// which days are missing. Read-only towards every other system.

const defaultDb = require("../../platform/db");
const auditLog = require("../../platform/audit/auditLog");
const { toEntries, OPERATION_ACTIONS } = require("../../platform/audit/operationLog");
const { siteDayIST } = require("../../platform/time/shiftWindows");
const ccDayRows = require("./ccDayRows");
const classificationEngine = require("./classificationEngine");
const { analyse, REPORT_WINDOW_MS } = require("./toteAnalytics");

const DAY = 86400000;
const RANGES = { today: [0, 0], yesterday: [1, 1], "7d": [6, 0], "30d": [29, 0] }; // [days back to start, days back to end]
const LOOKBACK_DAYS = Math.ceil(REPORT_WINDOW_MS / DAY); // reports / repeats before the first day
const MEMO_MS = 60 * 1000;

const shiftDay = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const dayStartMs = (d) => Date.parse(`${d}T06:00:00+05:30`);
function daysBetween(a, b) { const out = []; for (let d = a; d <= b; d = shiftDay(d, 1)) out.push(d); return out; }

function rangeFor(key, now = Date.now()) {
  const r = RANGES[key];
  if (!r) { const e = new Error("range must be one of " + Object.keys(RANGES).join(", ")); e.code = 400; throw e; }
  const today = siteDayIST(now);
  const from = shiftDay(today, -r[0]);
  const to = shiftDay(today, -r[1]);
  return { key, from, to, fromMs: dayStartMs(from), toMs: Math.min(dayStartMs(to) + DAY, now) };
}

async function loadPulls(fromMs, toMs) {
  const rows = await auditLog.listByActionsInRange(OPERATION_ACTIONS, { fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString(), limit: 5000 });
  const out = [];
  for (const e of toEntries(rows, {})) {
    const ms = Date.parse(e.timestamp);
    for (const d of e.details) if (d.toteId) out.push({ tote: String(d.toteId).toUpperCase(), ms, kind: e.kind, employee: e.employeeId, purpose: e.purpose });
  }
  return out;
}

async function loadPurges(db, sinceMs) {
  const rows = await db.query("SELECT tote_id, pulled_at, purged_at FROM purge_pulls WHERE status = 'PURGED' AND pulled_at >= ?", [new Date(sinceMs).toISOString()]);
  const out = {};
  for (const r of rows) {
    const from = Date.parse(r.pulled_at), to = Date.parse(r.purged_at);
    if (Number.isFinite(from) && Number.isFinite(to) && (!out[r.tote_id] || from > out[r.tote_id].from)) out[r.tote_id] = { from, to };
  }
  return out;
}

async function loadLocked() {
  const snap = await classificationEngine.getCurrentSnapshot();
  const totes = new Map();
  if (!snap) return { at: null, totes };
  for (const t of snap.totes || []) {
    const ms = Date.parse(t.lockedSince);
    totes.set(String(t.toteId).toUpperCase(), { priority: t.priority || null, lockedSinceMs: Number.isFinite(ms) ? ms : null });
  }
  return { at: Date.parse(snap.generatedAt) || null, totes };
}

const memo = new Map(); // range key -> { at, value }

// fresh: someone pressed Refresh. Otherwise the last result for the range is served to everyone, however old
// (operator decision 2026-11-04: shared until a manual refresh); MEMO_MS only merges presses made close together.
async function getAnalytics(rangeKey, { user, db = defaultDb, now = Date.now(), fresh = false } = {}) {
  const range = rangeFor(rangeKey, now);
  const hit = memo.get(range.key);
  if (hit && (!fresh || now - hit.at < MEMO_MS)) return { ...hit.value, fill: ccDayRows.fillStatus() };

  const dates = daysBetween(shiftDay(range.from, -LOOKBACK_DAYS), range.to);
  const { days, missing } = await ccDayRows.loadDays(dates, { user, db, now });
  if (missing.length) ccDayRows.fillDays(missing, { user, db }).catch((e) => console.warn("[tote-analytics] fill failed:", e.message || e));

  const reports = [], lines = [];
  for (const v of days.values()) { reports.push(...v.reports); lines.push(...v.lines); }
  const lookFrom = dayStartMs(dates[0]);
  const [pulls, purges, locked] = await Promise.all([
    loadPulls(lookFrom - DAY, range.toMs + DAY).catch(() => []),
    loadPurges(db, lookFrom - DAY).catch(() => ({})),
    loadLocked().catch(() => ({ at: null, totes: new Map() })),
  ]);
  const result = analyse({ reports, lines, pulls, purges, locked, fromMs: range.fromMs, toMs: range.toMs, now });
  const inRange = new Set(daysBetween(range.from, range.to));
  const value = {
    range: { key: range.key, from: range.from, to: range.to },
    coverage: { days: inRange.size, missing: missing.filter((d) => inRange.has(d)), lookbackMissing: missing.filter((d) => !inRange.has(d)).length },
    generatedAt: new Date(now).toISOString(),
    ...result,
  };
  if (!missing.length) memo.set(range.key, { at: now, value });
  return { ...value, fill: ccDayRows.fillStatus() };
}

module.exports = { getAnalytics, rangeFor, RANGES };
