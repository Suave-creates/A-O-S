// The ONE data layer for the Dashboard (live, today) and the One Pager Report
// (historical, any date). Both ask the same functions for the same numbers -
// the only difference is which site day they pass in. That is what keeps the
// two screens consistent, and it is where reliability is handled once:
//   - every Grafana call goes through the bounded, retrying pool
//     (integrations/grafana/grafanaQueryDirect.js);
//   - a section that still fails falls back to its last good value, flagged
//     `stale` (see withLastGood) instead of turning into "Data unavailable";
//   - a CLOSED site day is served from the historical cache (never changes);
//   - the OPEN site day is read incrementally (integrations/grafana/grafanaDayCache.js: only the recent part of
//     the day goes to Grafana); a closed day's first read is a full read - the day's final tally - and is
//     compared with what the live cache held (logged).
//
// Site day = 06:00 IST -> 06:00 IST next day (shifts A 06-14, B 14-22, C 22-06).
// Before 06:00 IST "today" is still yesterday's site day (shift C running).

const defaultQueryManager = require("../../platform/queries/queryManager");
const { waitForTerminal } = require("../../platform/queries/queryPoll");
const defaultCapabilityManager = require("../../integrations/capabilities/capabilityManager");
const { shiftWindowsForDate, hourWindowsForDate, siteDayIST } = require("../../platform/time/shiftWindows");
const { combineShifts } = require("./ccMetrics");
const defaultHistoricalReportCache = require("../../platform/storage/historicalReportCache");
const purgeMarksStore = require("../../platform/storage/purgeMarks");
const dayCache = require("../../integrations/grafana/grafanaDayCache");

const IST_OFFSET_MS = 5.5 * 3600000;
const SHIFT_KEYS = ["A", "B", "C"];

// ── Last known good ──────────────────────────────────────────────────────
// A section whose fresh fetch fails is served from its last successful value
// (marked stale, with why and since when) rather than vanishing. Only when
// there has never been a good value does the failure propagate.
const lastGood = new Map();

async function withLastGood(key, fn) {
  try {
    const value = await fn();
    lastGood.set(key, { value, at: new Date().toISOString() });
    return value;
  } catch (e) {
    const hit = lastGood.get(key);
    if (!hit) throw e;
    return { ...hit.value, stale: true, staleReason: e.message || String(e), staleSince: hit.at };
  }
}

// ── Capability dispatch ──────────────────────────────────────────────────
async function dispatchAndWait(user, capabilityName, params, deps = {}) {
  const cm = deps.capabilityManager || defaultCapabilityManager;
  const wait = deps.waitForTerminal || waitForTerminal;
  const dispatch = await cm.requestCapability({ user, capabilityName, params });
  if (!dispatch.ok) {
    const err = new Error(dispatch.reason || `${capabilityName} dispatch failed`);
    err.code = dispatch.code || 502;
    throw err;
  }
  const query = await wait(dispatch.query.query_id);
  if (query.status !== "COMPLETED") {
    const err = new Error(`${capabilityName} ended in status ${query.status}${query.error ? `: ${query.error}` : ""}`);
    err.code = 502;
    throw err;
  }
  return cm.getResult(dispatch.query.query_id);
}

// One Query Manager row per section run (visible in Active Queries), with the
// closed-day cache check first - a closed day can never change, so a hit
// returns without creating a row or touching Grafana.
async function runSection({ user, dateStr, qm = defaultQueryManager, cache = defaultHistoricalReportCache, kind, operation, work, bypassCache = false }) {
  const closed = !bypassCache && cache.isDateClosed(dateStr);
  if (closed) {
    const cached = await cache.get(kind, dateStr);
    if (cached) return cached;
  }
  const q = await qm.createQuery({ userId: user.id, operation, parameters: { dateStr } });
  qm.registerJob(q.query_id, new AbortController()); // registered before any await (see reconcileStale())
  try {
    await qm.markRunning(q.query_id);
    const report = { dateStr, generatedAt: new Date().toISOString(), ...(await work()) };
    await qm.completeQuery(q.query_id);
    if (closed && !report.incomplete) cache.set(kind, dateStr, report).catch(() => {}); // best-effort: a cache write must never fail a good report
    return report;
  } catch (e) {
    await qm.failQuery(q.query_id, e.message || String(e));
    throw e;
  } finally {
    qm.unregisterJob(q.query_id);
  }
}

// The final tally of a closed day (its full read) against what the live day cache held for it. Logged only -
// the full read is what gets saved. live(): the same shape built from the cache, or null when it has no full day.
function compareWithLiveCache(label, dateStr, finalShifts, live, keys) {
  Promise.resolve()
    .then(live)
    .then((cached) => {
      if (!cached) return;
      const diffs = keys.filter((k) => cached[k] && finalShifts[k] && cached[k].Total !== finalShifts[k].Total).map((k) => `${k} ${cached[k].Total} -> ${finalShifts[k].Total}`);
      if (diffs.length) console.warn(`[day-cache] ${dateStr} ${label}: the final full read differs from the live cache (${diffs.join(", ")}) - the full read is kept.`);
      else console.log(`[day-cache] ${dateStr} ${label}: the final full read matches the live cache.`);
    })
    .catch(() => {});
}
const rowOf = (w) => ({ A: w.A, B: w.B, C: w.C, Total: w.A + w.B + w.C });

// ── Shift-level sections (the numbers on the tiles and the One Pager) ──────

// withRows: also return the raw per-shift rows (for the Dashboard's detail
// popups). Never cached - rows are large and only the open day asks for them.
function runCcMetricsForDate(user, dateStr, qm, cache, { withRows = false } = {}) {
  return runSection({
    // "ccMetricsV4": CC Done excludes Bermuda and Purged totes and the shape carries shortQty / purgedTotes (see ccMetrics.js);
    // closed days cached under an older definition must never be served, so the cache key changed.
    user, dateStr, qm, cache, kind: "ccMetricsV4", operation: "DASHBOARD_CC_METRICS", bypassCache: withRows,
    work: async () => {
      const open = !(cache || defaultHistoricalReportCache).isDateClosed(dateStr); // callers may pass no cache
      const result = open ? await dayCache.ccRows(user, dateStr) : await dispatchAndWait(user, "GET_GRAFANA_CC_METRICS", { windows: shiftWindowsForDate(dateStr) });
      if (!result || !result.windows) throw new Error("GET_GRAFANA_CC_METRICS returned no result");
      const purgeMarks = await purgeMarksStore.loadRecent(); // totes pulled for PURGE: told apart from Bermuda
      const shifts = combineShifts(result.windows, purgeMarks);
      if (!open) {
        compareWithLiveCache("cycle count", dateStr, shifts, async () => {
          const got = await dayCache.peek(dateStr, "cc:v1", false);
          return got && combineShifts(dayCache.assembleRows(got), purgeMarks);
        }, ["ccDone", "bermudaTotes", "purgedTotes", "shortQty", "discrepancies"]);
      }
      return withRows ? { shifts, rows: result.windows, purgeMarks } : { shifts };
    },
  });
}

function runCompactionForDate(user, dateStr, qm, cache) {
  return runSection({
    user, dateStr, qm, cache, kind: "compaction", operation: "DASHBOARD_COMPACTION",
    work: async () => {
      const open = !(cache || defaultHistoricalReportCache).isDateClosed(dateStr); // callers may pass no cache
      const windows = shiftWindowsForDate(dateStr);
      const read = (cap) => (open ? dayCache.shiftCounts(user, dateStr, cap) : dispatchAndWait(user, cap, { windows }));
      const [compactionResult, toteFreedResult] = await Promise.all([read("GET_GRAFANA_COMPACTION_COUNT"), read("GET_GRAFANA_TOTES_FREED_COUNT")]);
      const shifts = { compaction: rowOf(compactionResult.windows), toteFreed: rowOf(toteFreedResult.windows) };
      if (!open) {
        compareWithLiveCache("compaction", dateStr, shifts, async () => {
          const [c, f] = await Promise.all(["GET_GRAFANA_COMPACTION_COUNT", "GET_GRAFANA_TOTES_FREED_COUNT"].map((cap) => dayCache.peek(dateStr, `${cap}:v1`, true)));
          return c && f && { compaction: rowOf(dayCache.assembleCounts(c, true)), toteFreed: rowOf(dayCache.assembleCounts(f, true)) };
        }, ["compaction", "toteFreed"]);
      }
      return { shifts };
    },
  });
}

// Pure helpers the ASRS Production section (and its unit tests) rely on.
function sumHoursRow(hoursByShift) {
  const sum8 = (arr) => arr.reduce((s, v) => s + v, 0);
  const A = sum8(hoursByShift.A);
  const B = sum8(hoursByShift.B);
  const C = sum8(hoursByShift.C);
  return { A, B, C, Total: A + B + C };
}
// The combined rows add up every department given (JIT, NJIT, FR0, FR0-Bulk - operator-confirmed 2026-11-04:
// "everything will be combined", although FR0-Bulk counts items, not orders). A missing department (null) is skipped.
function combineAsrsProductionTotal(...rows) {
  const ok = rows.filter(Boolean);
  const add = (k) => ok.reduce((a, r) => a + r[k], 0);
  return { A: add("A"), B: add("B"), C: add("C"), Total: add("Total") };
}
function pickingOverallRow(...hoursByDept) {
  const ok = hoursByDept.filter(Boolean);
  const hours = [];
  for (let h = 0; h < 8; h++) hours.push(ok.reduce((a, d) => a + d.A[h] + d.B[h] + d.C[h], 0));
  return { hours, total: hours.reduce((s, v) => s + v, 0) };
}

// ASRS Production for a site day, hour by hour per shift: JIT, NJIT (completed orders), FR0 (completed orders)
// and FR0-Bulk (items picked). JIT / NJIT must succeed; if FR0 or FR0-Bulk fails, the rest is still returned
// with that department null and named in `incomplete` - and a closed day is then not cached, so it is read again.
function runAsrsProductionForDate(user, dateStr, qm, cache) {
  return runSection({
    // "asrsProductionV2": the shape gained fr0 / bulk - closed days cached before that must not be served
    user, dateStr, qm, cache, kind: "asrsProductionV2", operation: "DASHBOARD_ASRS_PRODUCTION",
    work: async () => {
      const open = !(cache || defaultHistoricalReportCache).isDateClosed(dateStr); // callers may pass no cache
      const hourWindows = hourWindowsForDate(dateStr);
      const settle = (p) => p.then((v) => v, () => null);
      const read = (cap) => (open ? dayCache.hourlyCounts(user, dateStr, cap) : dispatchAndWait(user, cap, { hourWindows }));
      const [jitResult, njitResult, fr0Result, bulkResult] = await Promise.all([
        read("GET_GRAFANA_ASRS_PRODUCTION_JIT"),
        read("GET_GRAFANA_ASRS_PRODUCTION_NJIT"),
        settle(read("GET_GRAFANA_ASRS_PRODUCTION_FR0")),
        settle(read("GET_GRAFANA_ASRS_PRODUCTION_BULK_ITEMS")),
      ]);
      const hours = { jit: jitResult.hours, njit: njitResult.hours, fr0: fr0Result ? fr0Result.hours : null, bulk: bulkResult ? bulkResult.hours : null };
      const rows = { jit: sumHoursRow(hours.jit), njit: sumHoursRow(hours.njit), fr0: hours.fr0 ? sumHoursRow(hours.fr0) : null, bulk: hours.bulk ? sumHoursRow(hours.bulk) : null };
      const incomplete = [!hours.fr0 && "FR0", !hours.bulk && "FR0-Bulk"].filter(Boolean);
      if (!open) {
        const caps = { jit: "GET_GRAFANA_ASRS_PRODUCTION_JIT", njit: "GET_GRAFANA_ASRS_PRODUCTION_NJIT", fr0: "GET_GRAFANA_ASRS_PRODUCTION_FR0", bulk: "GET_GRAFANA_ASRS_PRODUCTION_BULK_ITEMS" };
        const keys = Object.keys(caps).filter((k) => rows[k]);
        compareWithLiveCache("ASRS production", dateStr, rows, async () => {
          const out = {};
          for (const k of keys) {
            const got = await dayCache.peek(dateStr, `${caps[k]}:v1`, false);
            if (!got) return null;
            out[k] = sumHoursRow(dayCache.assembleCounts(got, false));
          }
          return out;
        }, keys);
      }
      return {
        shifts: { ...rows, total: combineAsrsProductionTotal(rows.jit, rows.njit, rows.fr0, rows.bulk) },
        hours,
        pickingOverall: pickingOverallRow(hours.jit, hours.njit, hours.fr0, hours.bulk),
        ...(incomplete.length ? { incomplete } : {}),
      };
    },
  });
}

// ── Hourly view (detail popups): "since 06:00, hour by hour" ──────────────
// Flat list of the site day's 24 hours with their window and status.
function dayHours(dateStr, now = Date.now()) {
  const windows = hourWindowsForDate(dateStr);
  const out = [];
  for (const shift of SHIFT_KEYS) {
    windows[shift].forEach((w, i) => {
      const startHourIST = new Date(w.from + IST_OFFSET_MS).getUTCHours();
      const endHourIST = new Date(w.to + IST_OFFSET_MS).getUTCHours();
      out.push({
        shift, index: i, from: w.from, to: w.to,
        label: `${String(startHourIST).padStart(2, "0")}-${String(endHourIST).padStart(2, "0")}`,
        status: w.to <= now ? "closed" : w.from > now ? "future" : "current",
      });
    });
  }
  return out;
}

// Closed hours never change, so each is queried once per process and kept.
const closedHourMemo = new Map();

// Hourly Compaction / Totes Freed. Only hours that are neither future nor
// already memoised hit Grafana; with a warm memo a refresh is one hour's query.
// Returns the 24 hours; the array also carries .lastEvent (ms, IST wall-clock labelled UTC,
// see dashboardDetail.js) when asked via withLastEvent and the day has no events at all.
async function hourlyScalar({ user, dateStr, capabilityName, memoKind, now = Date.now(), withLastEvent = false, deps = {} }) {
  const hours = dayHours(dateStr, now);
  const windows = { A: [], B: [], C: [] };
  let needed = 0;
  for (const h of hours) {
    const memoKey = `${memoKind}:${dateStr}:${h.shift}${h.index}`;
    const memo = h.status === "closed" ? closedHourMemo.get(memoKey) : undefined;
    const skip = h.status === "future" || memo !== undefined;
    if (!skip) needed += 1;
    windows[h.shift].push({ from: h.from, to: h.to, skip });
  }
  let fetched = null;
  let lastEvent;
  if (needed > 0) {
    const result = await dispatchAndWait(user, capabilityName, { hourWindows: windows }, deps);
    fetched = result.hours;
  }
  const out = hours.map((h) => {
    const memoKey = `${memoKind}:${dateStr}:${h.shift}${h.index}`;
    let value = null;
    if (h.status !== "future") {
      const memo = closedHourMemo.get(memoKey);
      value = memo !== undefined ? memo : fetched ? fetched[h.shift][h.index] : null;
      if (h.status === "closed" && value !== null && memo === undefined) closedHourMemo.set(memoKey, value);
    }
    return { shift: h.shift, label: h.label, from: h.from, to: h.to, status: h.status, value };
  });
  // A genuine all-zero day: ask (cheaply - every hour skipped) when the table last recorded anything.
  if (withLastEvent && out.every((h) => !h.value)) {
    const skipAll = { A: [], B: [], C: [] };
    for (const h of hours) skipAll[h.shift].push({ from: h.from, to: h.to, skip: true });
    const result = await dispatchAndWait(user, capabilityName, { hourWindows: skipAll, withLastEvent: true }, deps);
    lastEvent = result.lastEvent;
  }
  out.lastEvent = lastEvent == null ? null : lastEvent;
  return out;
}

// Test hook.
function _resetForTests() {
  lastGood.clear();
  closedHourMemo.clear();
}

module.exports = {
  siteDayIST,
  withLastGood,
  dispatchAndWait,
  dayHours,
  hourlyScalar,
  runCcMetricsForDate,
  runCompactionForDate,
  runAsrsProductionForDate,
  sumHoursRow,
  combineAsrsProductionTotal,
  pickingOverallRow,
  IST_OFFSET_MS,
  _resetForTests,
};
