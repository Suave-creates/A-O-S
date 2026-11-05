// The cycle-count trail of one site day (06:00 -> 06:00 IST) for Locked Tote Analytics: the discrepancy reports
// and every GTP stock-check line, read with the same GET_GRAFANA_CC_METRICS capability the Dashboard uses.
//
// Kept compact (short keys, only what the analytics reads) and stored in cc_day_rows once the day is closed - a
// closed day never changes, so it is read from Grafana once. The open day is read fresh, at most every
// OPEN_DAY_TTL_MS. A missing closed day is filled by fillDays(): one day at a time with a pause between Grafana
// reads, so building a month of history never loads the database link in a burst.
//
//   report:  { c: base tote, ms: epoch ms, st: station, u: user }        - SHORT discrepancy events only (a report)
//   line:    { c: base tote, t: check time (IST "YYYY-MM-DD HH:MM:SS"), st, u, sku, q: quantity, r: ALRIGHT|SHORT|EXCESS }

const defaultDb = require("../../platform/db");
const jsonBlob = require("../../platform/storage/jsonBlob");
const { waitForTerminal } = require("../../platform/queries/queryPoll");
const defaultCapabilityManager = require("../../integrations/capabilities/capabilityManager");
const { shiftWindowsForDate } = require("../../platform/time/shiftWindows");
const { isDateClosed } = require("../../platform/storage/historicalReportCache");
const { baseToteId } = require("../../platform/domain/classification");
const { rowMs } = require("../../platform/domain/stockCheck");
const dayCache = require("../../integrations/grafana/grafanaDayCache");

const OPEN_DAY_TTL_MS = 3 * 60 * 1000;
const FILL_PAUSE_MS = 10 * 1000; // between two Grafana reads while filling history

function compact(windows) {
  const reports = [];
  const lines = [];
  for (const key of ["A", "B", "C"]) {
    const w = windows[key] || {};
    for (const d of w.discRows || []) {
      if (d.discrepancyType !== "SHORT") continue; // SHORT = the tote was reported
      const ms = rowMs(d.createTime); // IST read as UTC by Grafana - see stockCheck.rowMs
      if (!d.container || !Number.isFinite(ms)) continue;
      reports.push({ c: baseToteId(d.container), ms, st: d.station || null, u: d.user || null });
    }
    for (const s of w.stockRows || []) {
      if (!s.container || !s.createTime) continue;
      lines.push({ c: baseToteId(s.container), t: String(s.createTime).slice(0, 19), st: s.station || null, u: s.user || null, sku: s.sku == null ? null : String(s.sku), q: Number(s.quantity) || 0, r: s.resultType || null });
    }
  }
  return { reports, lines };
}

async function fetchDay(dateStr, { user, capabilityManager = defaultCapabilityManager, wait = waitForTerminal } = {}) {
  const dispatch = await capabilityManager.requestCapability({ user, capabilityName: "GET_GRAFANA_CC_METRICS", params: { windows: shiftWindowsForDate(dateStr) } });
  if (!dispatch.ok) throw new Error(dispatch.reason || "GET_GRAFANA_CC_METRICS dispatch failed");
  const query = await wait(dispatch.query.query_id);
  if (query.status !== "COMPLETED") throw new Error(`GET_GRAFANA_CC_METRICS ended ${query.status}${query.error ? ": " + query.error : ""}`);
  const result = await capabilityManager.getResult(dispatch.query.query_id);
  if (!result || !result.windows) throw new Error("GET_GRAFANA_CC_METRICS returned no result");
  return compact(result.windows);
}

const openDay = new Map(); // dateStr -> { at, value }

// The stored closed days of a list of dates: Map dateStr -> {reports, lines}. Missing ones are simply absent.
async function readStored(dates, { db = defaultDb } = {}) {
  const out = new Map();
  if (!dates.length) return out;
  const rows = await db.query(`SELECT date_str, rows_json FROM cc_day_rows WHERE date_str IN (${dates.map(() => "?").join(",")})`, dates);
  for (const r of rows) out.set(r.date_str, await jsonBlob.unpack(r.rows_json));
  return out;
}

// The days of `dates` ready for analysis: stored closed days, plus the open day read fresh (memoised briefly).
// Returns { days: Map, missing: [closed dates not stored yet] }.
async function loadDays(dates, { user, db = defaultDb, now = Date.now() } = {}) {
  const closed = dates.filter((d) => isDateClosed(d, now));
  const open = dates.filter((d) => !isDateClosed(d, now));
  const days = await readStored(closed, { db });
  for (const d of open) {
    const hit = openDay.get(d);
    if (hit && now - hit.at < OPEN_DAY_TTL_MS) { days.set(d, hit.value); continue; }
    try {
      const value = compact((await dayCache.ccRows(user, d)).windows); // incremental: only the recent part of the day is read
      openDay.set(d, { at: now, value });
      days.set(d, value);
    } catch (e) {
      if (hit) days.set(d, hit.value); // the last read of today beats nothing
      else throw e;
    }
  }
  return { days, missing: closed.filter((d) => !days.has(d)) };
}

async function storeDay(dateStr, value, db) {
  await db.execute(
    `INSERT INTO cc_day_rows (date_str, rows_json, report_count, line_count, fetched_at) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE rows_json = VALUES(rows_json), report_count = VALUES(report_count), line_count = VALUES(line_count), fetched_at = VALUES(fetched_at)`,
    [dateStr, await jsonBlob.pack(value), value.reports.length, value.lines.length, new Date().toISOString()]
  );
}

// Reads and stores the given closed days that are not stored yet, oldest first, pausing between Grafana reads.
// Single-flight: a second call while one runs joins it (and its days are picked up by the next call).
let filling = null;
let progress = { total: 0, done: 0, failed: 0 };
function fillDays(dates, { user, db = defaultDb, pauseMs = FILL_PAUSE_MS, log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (filling) return filling;
  filling = (async () => {
    const stored = await readStoredDates(dates, db);
    const todo = dates.filter((d) => isDateClosed(d) && !stored.has(d)).sort();
    progress = { total: todo.length, done: 0, failed: 0 };
    for (let i = 0; i < todo.length; i++) {
      if (i > 0) await sleep(pauseMs);
      try {
        await storeDay(todo[i], await fetchDay(todo[i], { user }), db);
        progress.done++;
      } catch (e) {
        progress.failed++;
        log.warn(`[tote-analytics] ${todo[i]} not stored: ${e.message || e}`);
      }
    }
    if (todo.length) log.log(`[tote-analytics] stored ${progress.done} of ${todo.length} day(s) of cycle-count history.`);
    return progress;
  })().finally(() => { filling = null; });
  return filling;
}
async function readStoredDates(dates, db) {
  if (!dates.length) return new Set();
  const rows = await db.query(`SELECT date_str FROM cc_day_rows WHERE date_str IN (${dates.map(() => "?").join(",")})`, dates);
  return new Set(rows.map((r) => r.date_str));
}
const fillStatus = () => ({ running: !!filling, ...progress });

module.exports = { compact, fetchDay, loadDays, fillDays, fillStatus, readStored };
