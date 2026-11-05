// One Pager Report - BULK (day-range) variant, 2026-09-14 (operator-
// requested: "bulk daywise individual report... in the last I want total
// and avg so I can make 15 days report"). Reuses onePagerReportEngine.js's
// own per-date fetchers (runCcMetricsForDate/runCompactionForDate/
// runAsrsProductionForDate) unchanged - never a second implementation of
// how CC Metrics/Compaction/ASRS Production are fetched.
//
// Deliberately covers ONLY the 3 sections onePagerReportEngine.js's own
// header comment already calls out as "Historical (reportDate's shifts)":
// ASRS Production, CC Metrics (CC Done/Discrepancies/Station Coverage), and
// Compaction/Tote Freed. Every other One Pager Report section (Locked
// Totes, Tote Utilisation, Totes In ASRS, Outside Totes, Aisle Occupancy)
// is a "right now" snapshot with no per-date meaning at all - see that
// file's header comment - so a day-range request for THOSE would just
// return today's live value 15 times over, which is not a real historical
// report and would be actively misleading. They are correctly left out of
// this file entirely rather than faked.
//
// One row per day, per metric, in calendar order, followed by a TOTAL row
// (column-wise sum across days) and an AVERAGE row (column-wise mean across
// only the days that actually had data for that column - a day whose
// section failed is EXCLUDED from both the sum and the average's
// denominator, never silently treated as 0, so a single bad day never
// silently drags the average down). Same single-current-report/lastAttempt/
// running lifecycle as purgeEngine.js (the closest existing precedent for
// "long-running, multi-fetch, fire-and-forget generate + poll" in this
// codebase) - no new persistence layer, nothing survives a server restart,
// which is fine for an on-demand compiled report like this one.

const queryManager = require("../../platform/queries/queryManager");
const onePagerReportEngine = require("./onePagerReportEngine");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BULK_DAYS = 62; // ~2 months - generous for the operator's own "15 days" use case, without letting one request fan out into hundreds of Grafana calls

// Pure - exported for direct unit testing. Throws (never silently clamps)
// on bad input, same "loud, not coerced" discipline as
// onePagerReportEngine.generate()'s own reportDate validation.
function enumerateDateRange(startDate, endDate) {
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw new Error(`startDate/endDate must be YYYY-MM-DD, got: ${startDate} / ${endDate}`);
  }
  const [sy, smo, sd] = startDate.split("-").map(Number);
  const [ey, emo, ed] = endDate.split("-").map(Number);
  const startMs = Date.UTC(sy, smo - 1, sd);
  const endMs = Date.UTC(ey, emo - 1, ed);
  if (endMs < startMs) {
    const err = new Error(`endDate (${endDate}) is before startDate (${startDate})`);
    err.code = 400;
    throw err;
  }
  const days = Math.round((endMs - startMs) / 86400000) + 1;
  if (days > MAX_BULK_DAYS) {
    const err = new Error(`Date range too large: ${days} days (max ${MAX_BULK_DAYS}) - narrow the range.`);
    err.code = 400;
    throw err;
  }
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startMs + i * 86400000);
    dates.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`);
  }
  return dates;
}

// null-aware sum/average over a column - a day with no value for this
// column (section failed that day) is skipped entirely, not counted as 0.
function sumCol(rows, key) {
  return rows.reduce((s, r) => (r[key] == null ? s : s + r[key]), 0);
}
function countCol(rows, key) {
  return rows.reduce((n, r) => (r[key] == null ? n : n + 1), 0);
}
function avg(total, count) {
  return count > 0 ? Math.round((total / count) * 10) / 10 : null;
}

// Pure - exported for direct unit testing. perDay: [{dateStr, row: {A,B,C,Total}|null}]
function buildBulkShiftTable(perDay) {
  const days = perDay.map((d) => ({
    dateStr: d.dateStr,
    A: d.row ? d.row.A : null,
    B: d.row ? d.row.B : null,
    C: d.row ? d.row.C : null,
    Total: d.row ? d.row.Total : null,
  }));
  const cols = ["A", "B", "C", "Total"];
  const totals = {};
  const counts = {};
  for (const c of cols) {
    totals[c] = sumCol(days, c);
    counts[c] = countCol(days, c);
  }
  return {
    days,
    total: { dateStr: "TOTAL", A: totals.A, B: totals.B, C: totals.C, Total: totals.Total },
    average: { dateStr: "AVERAGE", A: avg(totals.A, counts.A), B: avg(totals.B, counts.B), C: avg(totals.C, counts.C), Total: avg(totals.Total, counts.Total) },
  };
}

// Pure - exported for direct unit testing. perDay: [{dateStr, hours: number[8]|null, total: number|null}]
function buildBulkHoursTable(perDay) {
  const days = perDay.map((d) => ({ dateStr: d.dateStr, hours: d.hours && d.hours.length === 8 ? d.hours : [null, null, null, null, null, null, null, null], total: d.total == null ? null : d.total }));
  const hourTotals = [0, 0, 0, 0, 0, 0, 0, 0];
  const hourCounts = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const day of days) {
    for (let h = 0; h < 8; h++) {
      if (day.hours[h] != null) {
        hourTotals[h] += day.hours[h];
        hourCounts[h]++;
      }
    }
  }
  const grandTotal = sumCol(days, "total");
  const grandCount = countCol(days, "total");
  return {
    days,
    total: { dateStr: "TOTAL", hours: hourTotals, total: grandTotal },
    average: { dateStr: "AVERAGE", hours: hourTotals.map((t, i) => avg(t, hourCounts[i])), total: avg(grandTotal, grandCount) },
  };
}

// Pure - exported for direct unit testing. perDay: [{dateStr, data: <runAsrsProductionForDate result>|null}]
function buildAsrsProductionBulk(perDay) {
  const groups = [
    { key: "jit", shift: "A", label: "ASRS-JIT" },
    { key: "jit", shift: "B", label: "ASRS-JIT" },
    { key: "jit", shift: "C", label: "ASRS-JIT" },
    { key: "njit", shift: "A", label: "ASRS-FR1 (NJIT)" },
    { key: "njit", shift: "B", label: "ASRS-FR1 (NJIT)" },
    { key: "njit", shift: "C", label: "ASRS-FR1 (NJIT)" },
    { key: "fr0", shift: "A", label: "FR0" },
    { key: "fr0", shift: "B", label: "FR0" },
    { key: "fr0", shift: "C", label: "FR0" },
    { key: "bulk", shift: "A", label: "FR0-Bulk (items)" },
    { key: "bulk", shift: "B", label: "FR0-Bulk (items)" },
    { key: "bulk", shift: "C", label: "FR0-Bulk (items)" },
  ];
  const groupTables = groups.map((g) => ({
    label: g.label,
    shift: g.shift,
    table: buildBulkHoursTable(
      perDay.map((d) => ({
        dateStr: d.dateStr,
        hours: d.data && d.data.hours[g.key] ? d.data.hours[g.key][g.shift] : null, // FR0 / FR0-Bulk may be missing for a day
        total: d.data && d.data.shifts[g.key] ? d.data.shifts[g.key][g.shift] : null,
      }))
    ),
  }));
  const pickingOverall = buildBulkHoursTable(
    perDay.map((d) => ({
      dateStr: d.dateStr,
      hours: d.data && d.data.pickingOverall ? d.data.pickingOverall.hours : null,
      total: d.data && d.data.pickingOverall ? d.data.pickingOverall.total : null,
    }))
  );
  return { groups: groupTables, pickingOverall };
}

const CC_METRICS_METRICS = [
  { key: "ccDone", label: "CC Done" },
  { key: "bermudaTotes", label: "Bermuda Totes (all lines SHORT)" },
  { key: "purgedTotes", label: "Purged Totes (pulled for purge)" },
  { key: "shortQty", label: "Quantity Marked Short (units)" },
  { key: "discrepancies", label: "Discrepancies Marked" },
  { key: "ccStationsRan", label: "CC Stations Ran" },
  { key: "discrepancyStations", label: "Stations Flagged (SHORT)" },
];
// Pure - exported for direct unit testing. perDay: [{dateStr, data: <runCcMetricsForDate result>|null}]
function buildCcMetricsBulk(perDay) {
  return CC_METRICS_METRICS.map((m) => ({
    label: m.label,
    table: buildBulkShiftTable(perDay.map((d) => ({ dateStr: d.dateStr, row: d.data ? d.data.shifts[m.key] : null }))),
  }));
}

const COMPACTION_METRICS = [
  { key: "compaction", label: "Compaction" },
  { key: "toteFreed", label: "Tote Freed" },
];
// Pure - exported for direct unit testing. perDay: [{dateStr, data: <runCompactionForDate result>|null}]
function buildCompactionBulk(perDay) {
  return COMPACTION_METRICS.map((m) => ({
    label: m.label,
    table: buildBulkShiftTable(perDay.map((d) => ({ dateStr: d.dateStr, row: d.data ? d.data.shifts[m.key] : null }))),
  }));
}

let currentReport = null; // the last SUCCESSFUL bulk report only
let lastAttempt = null; // { at, ok, reason, queryId }
let running = false;

function getCurrentReport() {
  return currentReport;
}
function getLastAttempt() {
  return lastAttempt;
}
function isRunning() {
  return running;
}
function getStatus() {
  if (!currentReport) return "NO_SNAPSHOT";
  if (lastAttempt && !lastAttempt.ok) return "STALE_PREVIOUS";
  return "CURRENT";
}

// generate(queryId, user, {startDate, endDate}, deps) - deps injectable
// purely for testing. Every day's 3 sections are fetched concurrently
// (same "all independent sections run concurrently" philosophy as
// onePagerReportEngine.generate()); the ACTUAL external call concurrency is
// still bounded by capabilityManager's own per-workstation
// concurrencyLimiter regardless of how many days are requested, so a wide
// date range queues rather than floods the runtime.
async function generate(
  queryId,
  user,
  { startDate, endDate } = {},
  {
    qm = queryManager,
    runCcMetricsForDate = onePagerReportEngine.runCcMetricsForDate,
    runCompactionForDate = onePagerReportEngine.runCompactionForDate,
    runAsrsProductionForDate = onePagerReportEngine.runAsrsProductionForDate,
    runSection = onePagerReportEngine.runSection,
  } = {}
) {
  const controller = new AbortController();
  qm.registerJob(queryId, controller);
  running = true;
  try {
    await qm.markRunning(queryId);
    const dates = enumerateDateRange(startDate, endDate);

    const perDay = await Promise.all(
      dates.map(async (dateStr) => {
        const [ccMetricsR, compactionR, asrsProductionR] = await Promise.all([
          runSection(() => runCcMetricsForDate(user, dateStr, qm)),
          runSection(() => runCompactionForDate(user, dateStr, qm)),
          runSection(() => runAsrsProductionForDate(user, dateStr, qm)),
        ]);
        return {
          dateStr,
          ccMetrics: ccMetricsR.ok ? ccMetricsR.data : null,
          compaction: compactionR.ok ? compactionR.data : null,
          asrsProduction: asrsProductionR.ok ? asrsProductionR.data : null,
          sectionErrors: {
            ccMetrics: ccMetricsR.ok ? null : ccMetricsR.reason,
            compaction: compactionR.ok ? null : compactionR.reason,
            asrsProduction: asrsProductionR.ok ? null : asrsProductionR.reason,
          },
        };
      })
    );

    const asrsProductionBulk = buildAsrsProductionBulk(perDay.map((d) => ({ dateStr: d.dateStr, data: d.asrsProduction })));
    const ccMetricsBulk = buildCcMetricsBulk(perDay.map((d) => ({ dateStr: d.dateStr, data: d.ccMetrics })));
    const compactionBulk = buildCompactionBulk(perDay.map((d) => ({ dateStr: d.dateStr, data: d.compaction })));

    currentReport = {
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      dayCount: dates.length,
      // Per-day errors only (not the raw fetched data - already folded into
      // the 3 bulk tables above) so the UI can flag "N days had a problem"
      // without shipping the full duplicated per-day payload twice.
      days: perDay.map((d) => ({ dateStr: d.dateStr, sectionErrors: d.sectionErrors })),
      asrsProductionBulk,
      ccMetricsBulk,
      compactionBulk,
      generatedAt: new Date().toISOString(),
      generatedBy: user.employeeId,
      queryId,
    };
    lastAttempt = { at: currentReport.generatedAt, ok: true, queryId, reason: null };
    await qm.completeQuery(queryId);
  } catch (e) {
    const reason = e.message || String(e);
    lastAttempt = { at: new Date().toISOString(), ok: false, queryId, reason };
    await qm.failQuery(queryId, reason);
  } finally {
    qm.unregisterJob(queryId);
    running = false;
  }
}

module.exports = {
  generate,
  getCurrentReport,
  getLastAttempt,
  getStatus,
  isRunning,
  enumerateDateRange,
  buildBulkShiftTable,
  buildBulkHoursTable,
  buildAsrsProductionBulk,
  buildCcMetricsBulk,
  buildCompactionBulk,
  MAX_BULK_DAYS,
};
