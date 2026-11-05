// ASRS Performance - the One Pager kept day by day (table asrs_performance_days, migration 0022), so a month
// can be read back as MTD totals and daily averages that move as each day is added.
//
// A day is stored as a small flat metrics object, not the whole report (a One Pager is megabytes of
// per-tote detail): flow figures that add up over a month (orders picked, CC done, compaction ...) and
// level figures that only average (locked totes, outside totes, utilisation ... as they stood when saved).
//
//   captureDay  - a full One Pager for that date (its shift figures are final once Shift C closes at 06:00;
//                 the level figures are whatever they are at that moment), flattened and stored
//   backfillDay - a past day: production / CC / compaction are rebuilt for that date (closed days are cached
//                 in historical_report_cache, so this is cheap); level figures come from a One Pager someone
//                 generated for that date at the time, or stay null - they cannot be rebuilt afterwards
//   fillMonth   - every missing day of a month up to yesterday; yesterday gets a full capture
// The 06:05 schedule lives in server/live/asrsPerformanceAuto.js. Read-only towards every other system.

const defaultDb = require("../../platform/db");
const defaultQueryManager = require("../../platform/queries/queryManager");
const jsonBlob = require("../../platform/storage/jsonBlob");
const { todayIST } = require("../../platform/time/shiftWindows");
const onePagerReportEngine = require("./onePagerReportEngine");

const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_MS = 86400000;

// figures that add up across days, and figures that only average
const FLOW = ["picked", "pickedJit", "pickedNjit", "pickedFr0", "pickedBulk", "pickedA", "pickedB", "pickedC", "ccDone", "discrepancies", "bermuda", "purged", "shortQty", "stationsRan", "stationsFlagged", "compaction", "toteFreed"];
const LEVEL = ["lockedTotal", "lockedP0", "lockedP1", "lockedP2", "lockedSd", "outsideTotal", "outside24", "utilPct", "totesInAsrs", "aisleAvg"];

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const sum8 = (arr) => (Array.isArray(arr) && arr.some((v) => v != null) ? arr.reduce((a, v) => a + (Number(v) || 0), 0) : null);
const addNull = (...vals) => (vals.some((v) => v != null) ? vals.reduce((a, v) => a + (v || 0), 0) : null);

// The shift sections (CC metrics, compaction, ASRS production - the shapes dashboardMetrics returns) -> flow figures.
function flowMetrics({ ccMetrics, compaction, asrsProduction }) {
  const cc = (ccMetrics && ccMetrics.shifts) || {};
  const cp = (compaction && compaction.shifts) || {};
  const hours = (asrsProduction && asrsProduction.hours) || {};
  const dept = (d) => addNull(...["A", "B", "C"].map((s) => sum8(hours[d] && hours[d][s])));
  const shift = (s) => addNull(...["jit", "njit", "fr0", "bulk"].map((d) => sum8(hours[d] && hours[d][s])));
  const total = (row) => (row ? num(row.Total) : null);
  const overall = asrsProduction && asrsProduction.pickingOverall ? num(asrsProduction.pickingOverall.total) : null;
  return {
    picked: overall != null ? overall : addNull(dept("jit"), dept("njit"), dept("fr0"), dept("bulk")), // all combined (FR0-Bulk in items)
    pickedJit: dept("jit"),
    pickedNjit: dept("njit"),
    pickedFr0: dept("fr0"),
    pickedBulk: dept("bulk"), // items picked, not orders
    pickedA: shift("A"),
    pickedB: shift("B"),
    pickedC: shift("C"),
    ccDone: total(cc.ccDone),
    discrepancies: total(cc.discrepancies),
    bermuda: total(cc.bermudaTotes),
    purged: total(cc.purgedTotes),
    shortQty: total(cc.shortQty),
    stationsRan: total(cc.ccStationsRan),
    stationsFlagged: total(cc.discrepancyStations),
    compaction: total(cp.compaction),
    toteFreed: total(cp.toteFreed),
  };
}

// A One Pager's right-now sections -> level figures.
function levelMetrics(report) {
  const lt = (report.lockedTotes && report.lockedTotes.summary) || {};
  const ot = report.outsideTote || {};
  const ut = (report.utilisation && report.utilisation.totals) || {};
  const tia = report.totesInAsrs || {};
  const ao = report.aisleOccupancy;
  return {
    lockedTotal: num(lt.total),
    lockedP0: num(lt.p0Count),
    lockedP1: num(lt.p1Count),
    lockedP2: num(lt.p2Count),
    lockedSd: num(lt.sdCount),
    outsideTotal: num(ot.total),
    outside24: num(ot.h24plus),
    utilPct: num(ut.util) != null ? Math.round(ut.util * 1000) / 10 : null,
    totesInAsrs: num(tia.total && tia.total.total),
    aisleAvg: num(ao && ao.occupancy && ao.occupancy.average),
  };
}

const metricsFromReport = (report) => ({ ...flowMetrics(report), ...levelMetrics(report) });
const emptyLevels = () => Object.fromEntries(LEVEL.map((k) => [k, null]));

async function store(db, dateStr, metrics, source, reportQueryId = null) {
  await db.execute(
    `INSERT INTO asrs_performance_days (date_str, metrics_json, source, report_query_id, captured_at) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE metrics_json = VALUES(metrics_json), source = VALUES(source), report_query_id = VALUES(report_query_id), captured_at = VALUES(captured_at)`,
    [dateStr, JSON.stringify(metrics), source, reportQueryId, new Date().toISOString()]
  );
}

// A full One Pager for dateStr, saved like any other (it shows on the One Pager screen as the latest report).
async function captureDay({ dateStr, user, source = "AUTO", qm = defaultQueryManager, db = defaultDb, engine = onePagerReportEngine }) {
  const q = await qm.createQuery({ userId: user.id, operation: "ONE_PAGER_REPORT", parameters: { reportDate: dateStr, asrsPerformance: source } });
  const report = await engine.generate({ queryId: q.query_id, user, reportDate: dateStr, qm, db });
  const metrics = metricsFromReport(report);
  await store(db, dateStr, metrics, source, q.query_id);
  return metrics;
}

// A One Pager row is megabytes, so each one is read and flattened once: id -> {reportDate, generatedAt, metrics}.
// Reports never change after they are written, so the memo never goes stale (it is only trimmed).
const reportMemo = new Map();
async function reportSummary(db, id) {
  if (reportMemo.has(id)) return reportMemo.get(id);
  const rows = await db.query("SELECT result_json FROM one_pager_reports WHERE id = ?", [id]);
  const report = rows[0] ? await jsonBlob.unpack(rows[0].result_json) : null;
  const value = report ? { reportDate: report.reportDate, generatedAt: report.generatedAt, metrics: metricsFromReport(report) } : null;
  reportMemo.set(id, value);
  if (reportMemo.size > 50) reportMemo.delete(reportMemo.keys().next().value);
  return value;
}

// The newest One Pager generated FOR dateStr, looked for among reports created from that IST day's start
// up to `until` (by default a week later: a report for a day is often generated the next morning, or days
// after by a catch-up). Its {reportDate, generatedAt, metrics}, or null when there is none.
async function reportGeneratedFor(db, dateStr, until) {
  const from = new Date(`${dateStr}T00:00:00+05:30`).toISOString();
  const to = until || new Date(Date.parse(from) + 7 * DAY_MS).toISOString();
  const ids = await db.query("SELECT id FROM one_pager_reports WHERE created_at >= ? AND created_at < ? ORDER BY id DESC LIMIT 25", [from, to]);
  for (const r of ids) {
    const found = await reportSummary(db, r.id);
    if (found && found.reportDate === dateStr) return found;
  }
  return null;
}

async function backfillDay({ dateStr, user, qm = defaultQueryManager, db = defaultDb, engine = onePagerReportEngine }) {
  const settle = (p) => p.then((v) => v, () => null); // a failed section stays null, never zero
  const [ccMetrics, compaction, asrsProduction] = await Promise.all([
    settle(engine.runCcMetricsForDate(user, dateStr, qm)),
    settle(engine.runCompactionForDate(user, dateStr, qm)),
    settle(engine.runAsrsProductionForDate(user, dateStr, qm)),
  ]);
  const earlier = await reportGeneratedFor(db, dateStr).catch(() => null);
  const levels = earlier ? Object.fromEntries(LEVEL.map((k) => [k, earlier.metrics[k]])) : emptyLevels();
  const metrics = { ...flowMetrics({ ccMetrics, compaction, asrsProduction }), ...levels };
  await store(db, dateStr, metrics, "BACKFILL");
  return metrics;
}

// ── reading ─────────────────────────────────────────────────────────────
function monthDays(month) {
  const [y, m] = month.split("-").map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}
const yesterdayIST = () => new Date(Date.parse(todayIST() + "T00:00:00Z") - DAY_MS).toISOString().slice(0, 10);

function badMonth(month) {
  if (!MONTH_RE.test(String(month || ""))) {
    const e = new Error("month must be YYYY-MM");
    e.code = 400;
    throw e;
  }
}

async function readRows(db, month) {
  const rows = await db.query("SELECT date_str, metrics_json, source, captured_at FROM asrs_performance_days WHERE date_str LIKE ? ORDER BY date_str", [`${month}-%`]);
  const byDate = new Map();
  for (const r of rows) {
    let m = {};
    try { m = JSON.parse(r.metrics_json); } catch (e) { m = {}; }
    byDate.set(r.date_str, { date: r.date_str, source: r.source, capturedAt: r.captured_at, m });
  }
  return byDate;
}

// MTD totals of the flow figures, and per-day averages of everything - each over the days that have it.
function summarise(days) {
  const out = { days: days.length, total: {}, avg: {}, counted: {} };
  for (const k of [...FLOW, ...LEVEL]) {
    const vals = days.map((d) => d.m[k]).filter((v) => typeof v === "number");
    out.counted[k] = vals.length;
    if (FLOW.includes(k)) out.total[k] = vals.length ? vals.reduce((a, v) => a + v, 0) : null;
    out.avg[k] = vals.length ? Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 10) / 10 : null;
  }
  return out;
}

// One month: every calendar day up to yesterday (or the whole month, once it is over) with its stored
// figures or null, and the month's summary. In the current month, `today` is today so far: the figures of
// the newest One Pager generated for today (null when none has been) - shown, but not in the MTD or the
// averages, since the day is not over and the 06:05 save replaces it tomorrow.
async function getMonth(month, { db = defaultDb } = {}) {
  badMonth(month);
  const last = yesterdayIST();
  const dates = monthDays(month).filter((d) => d <= last);
  const byDate = await readRows(db, month);
  const days = dates.map((d) => byDate.get(d) || { date: d, source: null, capturedAt: null, m: null });
  const todayStr = todayIST();
  let today = null;
  if (todayStr.startsWith(month)) {
    const found = await reportGeneratedFor(db, todayStr, new Date(Date.now() + 60000).toISOString()).catch(() => null);
    today = { date: todayStr, generatedAt: found ? found.generatedAt : null, m: found ? found.metrics : null };
  }
  return {
    month,
    days,
    today,
    missing: days.filter((d) => !d.m).map((d) => d.date),
    summary: summarise(days.filter((d) => d.m)),
  };
}

// Every missing day of `month` up to yesterday, oldest first, one at a time (each reads Grafana).
// Yesterday gets a full capture when it is missing, so its snapshot figures are not lost.
let filling = null;
async function fillMonth(month, { user, db = defaultDb, qm = defaultQueryManager, engine = onePagerReportEngine, log = console } = {}) {
  badMonth(month);
  if (filling) return filling;
  filling = (async () => {
    const yesterday = yesterdayIST();
    const have = await readRows(db, month);
    const todo = monthDays(month).filter((d) => d <= yesterday && !have.has(d));
    let done = 0;
    for (const dateStr of todo) {
      try {
        if (dateStr === yesterday) await captureDay({ dateStr, user, source: "CATCHUP", qm, db, engine });
        else await backfillDay({ dateStr, user, qm, db, engine });
        done++;
      } catch (e) {
        log.warn(`[asrs-performance] ${dateStr} not saved: ${e.message || e}`);
      }
    }
    if (todo.length) log.log(`[asrs-performance] ${month}: ${done} of ${todo.length} missing day(s) saved.`);
    return { month, missing: todo.length, saved: done };
  })().finally(() => { filling = null; });
  return filling;
}
const isFilling = () => !!filling;

const CSV_COLS = [["date", "Date"], ["source", "Saved by"], ...FLOW.map((k) => [k, k]), ...LEVEL.map((k) => [k, k])];
function toCsv(data) {
  const cell = (v) => (v == null ? "" : /[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [CSV_COLS.map((c) => c[1]).join(",")];
  for (const d of data.days) lines.push(CSV_COLS.map(([k]) => cell(k === "date" ? d.date : k === "source" ? d.source : d.m ? d.m[k] : null)).join(","));
  lines.push(CSV_COLS.map(([k]) => cell(k === "date" ? "MTD total" : k === "source" ? "" : data.summary.total[k])).join(","));
  lines.push(CSV_COLS.map(([k]) => cell(k === "date" ? "Daily average" : k === "source" ? "" : data.summary.avg[k])).join(","));
  return lines.join("\r\n");
}

module.exports = { FLOW, LEVEL, flowMetrics, levelMetrics, metricsFromReport, summarise, monthDays, captureDay, backfillDay, getMonth, fillMonth, isFilling, yesterdayIST, toCsv };
