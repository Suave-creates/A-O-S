// Tote Purge orchestration - the ONLY place in this module that performs
// network/capability I/O. Wires the pure stages in server/features/tote-purge/purge/*.js
// together with the three EXISTING canonical data sources:
//   1. nexsAsrsDumpEngine.getCurrentSnapshot() (async, MySQL-backed) - ASRS Dump (already fetched, never re-fetched here)
//   2. nexsBlockedInventoryProvider.fetchBlockedInventoryBatch() - ONE
//      GET_NEXS_BLOCKED_INVENTORY_BATCH capability dispatch for every
//      unique candidate PID (NEXS batch-capability refactor - previously
//      one GET_NEXS_BLOCKED_INVENTORY capability dispatch, and one Query
//      Manager row, PER unique PID; bounded concurrency lives in
//      capabilities/nexsBlockedInventoryBatchDirect.js)
//   3. capabilitySource.fetchCapabilitySource("GET_QUADRON_INVENTORY")  - the existing Quadron provider path
//
// data sources -> normalized data -> pure purge classification -> Quadron
// validation -> report, per the approved architecture. No tote-dispatch
// module (toteDispatchLoop/totePullEngine/autoEngine/quadronPull/
// pullQuadronTote) is imported anywhere in this file or its pure
// dependencies - Tote Purge never calls a tote, never touches the Auto
// queue, never creates a Manual session, never mutates classification
// state. Read-only, analysis-only, exactly like nexsAsrsDumpEngine.js's own
// refresh lifecycle (same currentSnapshot/lastAttempt/getStatus pattern,
// same QueryManager register/markRunning/complete/fail lifecycle - no
// second query-tracking mechanism).

const queryManager = require("../../platform/queries/queryManager");
const nexsAsrsDumpEngine = require("../nexs-asrs-dump/nexsAsrsDumpEngine");
const defaultBlockedInventoryProvider = require("../../integrations/nexs/nexsBlockedInventoryProvider");
const { fetchCapabilitySource } = require("../../integrations/capabilities/capabilitySource");
const purgeAggregate = require("./purge/purgeAggregate");
const purgeClassify = require("./purge/purgeClassify");
const purgeQuadronValidate = require("./purge/purgeQuadronValidate");
const purgeReport = require("./purge/purgeReport");
const { getServiceReadiness } = require("../../integrations/logins/connectionStatus");

// Real prerequisite check - NEVER the cosmetic header connection-status
// flag (server/features/connection-status/connectionStatus.js's getConnectionStatus() is a display
// concern). Passive and read-only: only verifies the shared NexS and
// Concinity accounts are configured, and never logs in (a NexS login would
// kick out any other active session on that account).
async function defaultCheckReadiness() {
  return getServiceReadiness();
}

let currentReport = null; // the last SUCCESSFUL report only
let lastAttempt = null; // { at, ok, reason, queryId } - every attempt, success or failure
let running = false; // single-flight guard, mirrors legacy's purgeState.running
// While a run is going: where it is and about how long is left, for everyone watching the Tote Purge tab.
//   { by, startedAt, phase: "dump"|"blocked"|"retry"|"quadron", done, total, etaMs }
let progress = null;
// NexS blocked-inventory lookups per second before this run has measured its own (2026-11-04: ~25 PIDs/s, 5 at a
// time), and the time the Quadron check + report take after them (~15 s measured).
const DEFAULT_PIDS_PER_SEC = 25;
const AFTER_BLOCKED_MS = 15 * 1000;
// One more try when the first fails, like the NexS lookups' second pass: on 2026-11-05 ~8% of Quadron reads timed
// out, and each failure left every candidate of a minutes-long run unvalidated.
async function fetchQuadronWithRetry(fetchQuadron, user) {
  const attempt = () =>
    Promise.resolve()
      .then(() => fetchQuadron({ user, capabilityName: "GET_QUADRON_INVENTORY" }))
      .catch((e) => ({ ok: false, rows: [], reason: e.message || String(e) }));
  const first = await attempt();
  if (first.ok) return first;
  const second = await attempt();
  return second.ok ? second : { ...second, reason: `${second.reason} (failed twice; first try: ${first.reason})` };
}

function getProgress() {
  return running ? progress : null;
}

function getCurrentReport() {
  return currentReport;
}
function getLastAttempt() {
  return lastAttempt;
}
function isRunning() {
  return running;
}
// "CURRENT" / "STALE_PREVIOUS" / "NO_SNAPSHOT" - same convention as
// nexsAsrsDumpEngine.getStatus(): never silently presents a stale report as
// fresh.
function getStatus() {
  if (!currentReport) return "NO_SNAPSHOT";
  if (lastAttempt && !lastAttempt.ok) return "STALE_PREVIOUS";
  return "CURRENT";
}

// generate(queryId, user, {filters, facilityCode}, deps) - deps are
// injectable purely for testing (no real capability/QueryManager
// call needed to unit-test orchestration wiring); production callers pass
// only {filters, facilityCode}.
async function generate(
  queryId,
  user,
  { filters, facilityCode } = {},
  {
    qm = queryManager,
    getSnapshot = nexsAsrsDumpEngine.getCurrentSnapshot,
    fetchBlockedInventoryBatch = defaultBlockedInventoryProvider.fetchBlockedInventoryBatch,
    fetchQuadron = fetchCapabilitySource,
    checkReadiness = defaultCheckReadiness,
  } = {}
) {
  // Synchronous, before any await - queryManagerMysql.reconcileStale()
  // treats any QUEUED/RUNNING query with no live registry entry as an
  // abandoned job from a crashed/restarted process and immediately fails
  // it with a misleading "Backend restarted" reason. Without this,
  // totePurge.routes.js's own POST /generate handler triggers that false
  // positive on EVERY call: it reads this query's status right back via
  // getQuery() to build its 202 response, moments after this function
  // starts - before generate() has done anything else - and (with no
  // registry entry) that read alone was enough to permanently misreport
  // the run as FAILED even though the real work then completes
  // successfully in the background a moment later and silently overwrites
  // it (confirmed live). See toteUtilisationJob.js for the identical
  // pattern/reasoning. This OUTER TOTE_PURGE_GENERATE controller's signal
  // is deliberately not threaded into fetchBlockedInventoryBatch/fetchQuadron
  // below - see server/platform/queries/cancellationSupport.js for why TOTE_PURGE_GENERATE
  // itself is reported as not cancellation-supported. The INNER
  // GET_NEXS_BLOCKED_INVENTORY_BATCH capability call this function makes IS
  // independently, genuinely cancellable (it is capability-backed, with its
  // own AbortController and Active Queries row) - an operator can cancel
  // that one row directly while a Purge run is in progress.
  const controller = new AbortController();
  qm.registerJob(queryId, controller);

  running = true;
  progress = { by: (user && user.employeeId) || null, startedAt: new Date().toISOString(), phase: "dump", done: 0, total: 0, etaMs: null };
  try {
    await qm.markRunning(queryId);

    // Real prerequisites, checked upfront and together - never the cosmetic
    // header connection-status badge (see connectionStatus.js). Failing
    // here, before the per-PID loop, gives one clear combined reason
    // instead of hundreds of individually-skipped PIDs when a whole
    // capability is unavailable.
    const snapshot = await getSnapshot();
    const { nexsReady, quadronReady } = await checkReadiness();
    const problems = [];
    if (!snapshot || !Array.isArray(snapshot.rows) || !snapshot.rows.length) {
      problems.push("No NEXS ASRS Tote Dump snapshot available - refresh NEXS ASRS Tote Dump first.");
    }
    if (!nexsReady) {
      problems.push("NexS Blocked Inventory is not available (the shared NexS login, NEXS_DIRECT_USERNAME/NEXS_DIRECT_PASSWORD, is not configured).");
    }
    if (!quadronReady) {
      problems.push("Quadron Inventory is not available (the shared Concinity login, CONCINITY_DIRECT_USERNAME/CONCINITY_DIRECT_PASSWORD, is not configured).");
    }
    if (problems.length) {
      throw new Error(problems.join(" "));
    }

    const { pidAgg, toteAgg } = purgeAggregate.aggregateAsrsRows(snapshot.rows);
    const { pre, resolvedFilters } = purgeClassify.preFilterCandidates({ pidAgg, toteAgg }, filters);

    let kept = [];
    let apiSkipped = [];
    let quadronOk = false;
    let quadronReason = null;

    if (pre.length) {
      // ONE capability dispatch, ONE Active Queries row, regardless of
      // whether there are 10, 100, or 1,000 unique candidate PIDs - see
      // this file's header comment. classifyByBlocked() below is unchanged;
      // it only ever sees a blockedMap keyed by pid, exactly as before.
      // Quadron is a different host from NexS, so its one big read runs alongside the NexS lookups instead of
      // after them - the run no longer waits for it, and a retry fits inside the NexS phase. Fetched even if
      // `kept` ends up empty, so quadronAvailable always reflects a real attempt for this run.
      const quadronPromise = fetchQuadronWithRetry(fetchQuadron, user);
      const uniquePids = [...new Set(pre.map((c) => c.pid))];
      // progress + estimated time: the rate measured so far in this run (the default until the first chunk lands)
      const phaseStart = Date.now();
      let firstPassMs = null;
      let rate = DEFAULT_PIDS_PER_SEC / 1000;
      progress = { ...progress, phase: "blocked", done: 0, total: uniquePids.length, etaMs: uniquePids.length / rate + AFTER_BLOCKED_MS };
      const onProgress = ({ done, total, retrying }) => {
        const elapsed = Date.now() - phaseStart - (retrying && firstPassMs != null ? firstPassMs : 0);
        if (!retrying && done >= total) firstPassMs = Date.now() - phaseStart;
        if (done > 0 && elapsed > 0) rate = done / elapsed;
        progress = { ...progress, phase: retrying ? "retry" : "blocked", done, total, etaMs: Math.max(0, (total - done) / rate) + AFTER_BLOCKED_MS };
      };
      const blockedMap = await fetchBlockedInventoryBatch({ user, pids: uniquePids, facilityCode: facilityCode || "NXS1", onProgress });
      progress = { ...progress, phase: "quadron", etaMs: AFTER_BLOCKED_MS };

      const classified = purgeClassify.classifyByBlocked(pre, blockedMap, resolvedFilters);
      kept = classified.kept;
      apiSkipped = classified.apiSkipped;

      const quadronResult = await quadronPromise;
      quadronOk = quadronResult.ok;
      quadronReason = quadronResult.reason || null;
      purgeQuadronValidate.validateAllCandidates(kept, {
        quadronOk,
        quadronRows: quadronResult.rows || [],
        toteBarcodeMax: resolvedFilters.toteBarcodeMax,
      });
    }

    // buildSummary() already degrades correctly on empty input (0 pre-
    // candidates -> kept/mismatches/apiSkipped are all still [] here), so
    // no separate "empty" branch is needed - one code path either way.
    const mismatches = purgeReport.buildMismatches(kept);
    const summary = purgeReport.buildSummary(kept, mismatches, apiSkipped, quadronOk, quadronReason);
    const pidBreakdown = purgeReport.buildPidBreakdown(kept);

    currentReport = {
      summary,
      candidates: kept,
      mismatches,
      pidBreakdown,
      apiSkipped,
      filters: resolvedFilters,
      queryId,
      generatedAt: new Date().toISOString(),
      generatedBy: user.employeeId,
      asrsSnapshotRefreshedAt: snapshot.refreshedAt,
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
    progress = null;
  }
}

module.exports = { generate, getCurrentReport, getLastAttempt, getStatus, isRunning, getProgress };
