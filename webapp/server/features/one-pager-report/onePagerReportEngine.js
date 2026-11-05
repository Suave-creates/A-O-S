// One Pager Report (2026-09-07) - combines every section of the legacy
// extension's own ASRS Daily Report one-pager (see the reference screenshot
// the operator supplied, asrs-daily-report-2026-09-06.png) using ONLY
// sources this webapp already has - never a second implementation of
// anything. Per the operator's own requirement, generation never depends on
// another tab having already been refreshed: every section is fetched
// fresh, right here, by reusing the SAME engines those tabs/Dashboard
// themselves call (classificationEngine/toteUtilisationJob/trackerEngine/
// dashboardEngine). All sections are independent of each other (none needs
// another's output), so they all run concurrently.
//
// Section -> source mapping. The Grafana-backed sections (CC metrics,
// compaction/tote freed, ASRS production) come from dashboardMetrics.js - the
// SAME functions the live Dashboard calls, just given the report's date instead
// of today. The rest reuse their own engines:
//   Current Locked Totes   -> classificationEngine.refresh()
//   Totes In ASRS          -> derived from toteUtilisationJob's own `stats`
//   Tote Utilisation       -> toteUtilisationJob.runToteUtilisation()
//   Outside Totes          -> trackerEngine.runAuto(), Outside Tote only, bucketed 12-24h / 24h+
//   Aisle Occupancy        -> dashboardEngine.getAisleOccupancy() (live; ignores reportDate)
// Reliability: a section that fails is retried once, then falls back to its last
// good value flagged `stale` (report.sectionStale) - "Data unavailable" is only
// shown when there has never been a good value.
//
// Known limitation, not papered over: cancelling the outer ONE_PAGER_REPORT
// query does not cascade into aborting the sub-fetches already in flight
// (each owns its own AbortController via its own sub-query, exactly as it
// would if the operator had triggered it from that tab/Dashboard directly) -
// they run to their own natural completion regardless. Acceptable today
// since none of them is a write/mutating operation.

const defaultQueryManager = require("../../platform/queries/queryManager");
const { waitForTerminal } = require("../../platform/queries/queryPoll");
const defaultClassificationEngine = require("../locked-tote-info/classificationEngine");
const defaultToteUtilisationJob = require("../tote-utilisation/toteUtilisationJob");
const defaultTrackerEngine = require("../tracker/trackerEngine");
const defaultDashboardEngine = require("../dashboard/dashboardEngine");
const { todayIST } = require("../../platform/time/shiftWindows");
const metrics = require("../dashboard/dashboardMetrics");
const { parseIstRawDigitsToUtcMs } = require("../../platform/time/istTimestamp");
const defaultDb = require("../../platform/db");
const jsonBlob = require("../../platform/storage/jsonBlob");
// The per-date Grafana sections (CC metrics, compaction, ASRS production) are the SAME
// functions the live Dashboard uses - one data layer, see dashboardMetrics.js.
const { runCcMetricsForDate, runCompactionForDate, runAsrsProductionForDate, sumHoursRow, combineAsrsProductionTotal, pickingOverallRow, withLastGood } = metrics;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The app-wide tote capacity defaults (TL Lens 300 / TL Frame 200 / TS Lens 200 / TS Frame 100 - operator-set,
// 2026-11-03), the same figures Tote Utilisation and the Dashboard use.
const DEFAULT_UTILISATION_CAPS = defaultToteUtilisationJob.DEFAULT_CAPS;

async function runLockedTotes(user, qm) {
  const q = await qm.createQuery({ userId: user.id, operation: "LOCKED_TOTE_INFO_REFRESH", parameters: {} });
  return defaultClassificationEngine.refresh({ queryId: q.query_id, user });
}

async function runUtilisation(user, caps, qm) {
  const q = await qm.createQuery({ userId: user.id, operation: "TOTE_UTILISATION", parameters: { caps } });
  defaultToteUtilisationJob.runToteUtilisation(q.query_id, caps).catch(() => {
    /* runToteUtilisation itself persists FAILED - the waitForTerminal below observes it */
  });
  const finalQuery = await waitForTerminal(q.query_id);
  if (finalQuery.status !== "COMPLETED") {
    const err = new Error(`Tote Utilisation ended in status ${finalQuery.status}${finalQuery.error ? `: ${finalQuery.error}` : ""}`);
    err.code = 502;
    throw err;
  }
  return defaultToteUtilisationJob.getResult(q.query_id);
}

// Same "never guess a bucket for an unparseable timestamp" discipline
// istTimestamp.js already established: null in, null out.
function ageBucketFor(updatedRaw, now) {
  const ms = parseIstRawDigitsToUtcMs(updatedRaw);
  if (ms == null) return null;
  const ageHours = (now - ms) / 3600000;
  if (ageHours < 12) return null; // same "under 12h isn't a reportable bucket" rule as tracker.js's hoursBucketLabel()
  return ageHours < 24 ? "h12to24" : "h24plus";
}

// Pure - exported for direct unit testing without touching trackerEngine at all.
function summarizeOutsideTote(rows, now = Date.now()) {
  const totes = { h12to24: [], h24plus: [] };
  for (const r of rows || []) {
    if (!r || r.status !== "Outside Tote") continue; // explicit operator instruction: Outside Tote only, never Bad Tracker
    const bucket = ageBucketFor(r.updated, now);
    if (bucket) totes[bucket].push(r.tote);
  }
  return {
    h12to24: totes.h12to24.length,
    h24plus: totes.h24plus.length,
    total: totes.h12to24.length + totes.h24plus.length,
    totes,
  };
}

async function runOutsideTote(user, qm) {
  const q = await qm.createQuery({ userId: user.id, operation: "TRACKER_RUN_AUTO", parameters: {} });
  const result = await defaultTrackerEngine.runAuto({ queryId: q.query_id, user, skipNexs: true }); // counts only - no NexS login needed
  return summarizeOutsideTote(result.rows);
}

async function runAisleOccupancy(user, qm) {
  const q = await qm.createQuery({ userId: user.id, operation: "DASHBOARD_AISLE_OCCUPANCY", parameters: {} });
  return defaultDashboardEngine.getAisleOccupancy({ queryId: q.query_id, user });
}

// Totes In ASRS (reference screenshot's own Frame/Lens x Large/Small table)
// is NOT a separate fetch - toteUtilisationJob's own `stats` already
// computed exactly this breakdown (see toteUtilisationJob.js's own comment:
// "exactly what the Dashboard's Tote Utilisation/Totes In ASRS sections
// need"). Pure - exported for direct unit testing.
function deriveTotesInAsrs(stats) {
  if (!stats) return null;
  const totesOf = (key) => (stats[key] && Number(stats[key].totes)) || 0;
  const large = { frame: totesOf("largeFrame"), lens: totesOf("largeLens") };
  const small = { frame: totesOf("smallFrame"), lens: totesOf("smallLens") };
  return {
    large: { ...large, total: large.frame + large.lens },
    small: { ...small, total: small.frame + small.lens },
    total: { frame: large.frame + small.frame, lens: large.lens + small.lens, total: large.frame + large.lens + small.frame + small.lens },
  };
}

// Wraps one section's fetch so its failure never propagates past this
// function - see generate()'s own comment on why sections must degrade
// fully independently.
async function runSection(fn, { retries = 1, retryDelayMs = 700 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return { ok: true, data: await fn() };
    } catch (e) {
      if (attempt >= retries) return { ok: false, reason: e.message || String(e) };
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
}

// generate({queryId, user, utilisationCaps}) -> the full report, persisted
// to one_pager_reports and tracked as a real Query Manager row
// (ONE_PAGER_REPORT), same as every other multi-step refresh in this app.
async function generate({ queryId, user, utilisationCaps, reportDate, qm = defaultQueryManager, db = defaultDb }) {
  const controller = new AbortController();
  qm.registerJob(queryId, controller);

  try {
    await qm.markRunning(queryId);
    const caps = { ...DEFAULT_UTILISATION_CAPS, ...(utilisationCaps || {}) };
    // Historical trio (Compaction/CC Metrics/Station Coverage) only -
    // everything else in this report is always live regardless of
    // reportDate (see this file's own header comment). Invalid input is
    // rejected loudly here, not silently coerced to today.
    const dateStr = reportDate || todayIST();
    if (!DATE_RE.test(dateStr)) {
      const err = new Error(`reportDate must be YYYY-MM-DD, got: ${reportDate}`);
      err.code = 400;
      throw err;
    }

    // Each section fails/degrades ENTIRELY independently - one section
    // failing (e.g. a runtime-dependent one, while the operator's runtime
    // happens to be offline) must never take down sections that already
    // succeeded (e.g. the direct-login-mode ones). Mirrors this app's own
    // established degradation pattern (classificationEngine.js's own
    // degraded/degradedReasons for its optional sources) rather than a bare
    // Promise.all, which would reject - and lose every other section's real,
    // already-fetched data - the instant any ONE section rejects.
    const [lockedTotesR, utilisationR, outsideToteR, ccMetricsR, compactionR, aisleOccupancyR, asrsProductionR] = await Promise.all([
      runSection(() => runLockedTotes(user, qm)),
      runSection(() => runUtilisation(user, caps, qm)),
      runSection(() => runOutsideTote(user, qm)),
      runSection(() => withLastGood(`cc:${dateStr}`, () => runCcMetricsForDate(user, dateStr, qm))),
      runSection(() => withLastGood(`compaction:${dateStr}`, () => runCompactionForDate(user, dateStr, qm))),
      runSection(() => withLastGood("aisle", () => runAisleOccupancy(user, qm))),
      runSection(() => withLastGood(`asrsProduction:${dateStr}`, () => runAsrsProductionForDate(user, dateStr, qm))),
    ]);

    const utilisation = utilisationR.ok ? utilisationR.data : null;
    const generatedAt = new Date().toISOString();
    const report = {
      generatedAt,
      reportDate: dateStr,
      lockedTotes: lockedTotesR.ok ? lockedTotesR.data : null,
      utilisation,
      totesInAsrs: utilisation ? deriveTotesInAsrs(utilisation.stats) : null,
      outsideTote: outsideToteR.ok ? outsideToteR.data : null,
      ccMetrics: ccMetricsR.ok ? ccMetricsR.data : null,
      compaction: compactionR.ok ? compactionR.data : null,
      aisleOccupancy: aisleOccupancyR.ok ? aisleOccupancyR.data : null,
      asrsProduction: asrsProductionR.ok ? asrsProductionR.data : null,
      utilisationCaps: caps,
      // Sections served from their last good value because the fresh fetch failed.
      sectionStale: Object.fromEntries(
        Object.entries({ ccMetrics: ccMetricsR, compaction: compactionR, aisleOccupancy: aisleOccupancyR, asrsProduction: asrsProductionR })
          .filter(([, r]) => r.ok && r.data && r.data.stale)
          .map(([k, r]) => [k, { reason: r.data.staleReason, since: r.data.staleSince }])
      ),
      // Never silently dropped - a section a caller/UI can check to render
      // "Data unavailable" (same convention as classificationEngine.js's
      // degradedReasons) rather than a fabricated empty table.
      sectionErrors: {
        lockedTotes: lockedTotesR.ok ? null : lockedTotesR.reason,
        utilisation: utilisationR.ok ? null : utilisationR.reason,
        outsideTote: outsideToteR.ok ? null : outsideToteR.reason,
        ccMetrics: ccMetricsR.ok ? null : ccMetricsR.reason,
        compaction: compactionR.ok ? null : compactionR.reason,
        aisleOccupancy: aisleOccupancyR.ok ? null : aisleOccupancyR.reason,
        asrsProduction: asrsProductionR.ok ? null : asrsProductionR.reason,
      },
    };

    await db.execute("INSERT INTO one_pager_reports (query_id, result_json, created_at) VALUES (?, ?, ?)", [
      queryId,
      await jsonBlob.pack(report),
      generatedAt,
    ]);
    await qm.completeQuery(queryId);
    return report;
  } catch (e) {
    await qm.failQuery(queryId, e.message || String(e));
    throw e;
  } finally {
    qm.unregisterJob(queryId);
  }
}

// getCurrentReport() -> the most recently COMPLETED report, or null if none
// has ever completed. Never triggers a generation - same "no report yet"
// contract every other *Engine.js getCurrentSnapshot() already uses.
async function getCurrentReport({ db = defaultDb } = {}) {
  const rows = await db.query("SELECT result_json FROM one_pager_reports ORDER BY id DESC LIMIT 1");
  return rows[0] ? jsonBlob.unpack(rows[0].result_json) : null;
}

module.exports = {
  generate,
  getCurrentReport,
  summarizeOutsideTote,
  deriveTotesInAsrs,
  runSection,
  sumHoursRow,
  combineAsrsProductionTotal,
  pickingOverallRow,
  DEFAULT_UTILISATION_CAPS,
  // Exported for onePagerReportBulkEngine.js - the ONLY other caller. Same
  // "never a second implementation" rule as the rest of this file: a bulk
  // (day-range) report reuses these exact per-date fetchers rather than
  // re-deriving CC Metrics/Compaction/ASRS Production from Grafana itself.
  runCcMetricsForDate,
  runCompactionForDate,
  runAsrsProductionForDate,
};
