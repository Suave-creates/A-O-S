// Outside Tote Analysis (Tracker) - orchestrates the capability dispatches
// this feature needs: GET_GRAFANA_TOTE_FINDER always; GET_GRAFANA_TRACKER_HISTORY
// only if any tote classified as Bad Tracker; GET_QUADRON_INVENTORY +
// GET_NEXS_BLOCKED_INVENTORY_BATCH only if any tote is an Outside Tote/Bad
// Tracker candidate. Mirrors cngValidator.js's own
// createQuery/registerJob/markRunning/requestCapability/waitForTerminal/
// completeQuery/failQuery shape - ONE Query Manager row for the whole run.
//
// 100% read-only: every capability dispatched here is readOnly:true in the
// registry - this module has no code path that can create a pull session
// or dispatch PULL_QUADRON_TOTE.

const defaultCapabilityManager = require("../../integrations/capabilities/capabilityManager");
const { waitForTerminal } = require("../../platform/queries/queryPoll");
const defaultQueryManager = require("../../platform/queries/queryManager");
const { TOTE_ID_REGEX } = require("../../integrations/quadron/pullQuadronTote");
const {
  isCandidateStatus,
  buildBaseRows,
  applyLastGood,
  applyBlockedAndPurgeSafety,
  pickOutCandidates,
  filterStaleByFinder,
  mergeContainerTrackingFields,
} = require("./trackerReconcile");

// Auto Mode (see runAuto() below) - fixed per the user's own spec, not
// env-tunable (this is a business rule, not an infra setting).
const AUTO_STALE_MS = 12 * 3600000; // totes with Updated older than this, at the moment Auto Mode runs, are the target set
const FINDER_CHUNK_SIZE = 200; // GET_GRAFANA_TOTE_FINDER dispatched sequentially in chunks of this size - see runAuto()'s own comment on why sequential

async function dispatchAndWait({ requestCapability, wait, getResult, user, capabilityName, params }) {
  const dispatch = await requestCapability({ user, capabilityName, params });
  if (!dispatch.ok) {
    const err = new Error(dispatch.reason || `${capabilityName} dispatch failed`);
    err.code = dispatch.code || 502;
    throw err;
  }
  const query = await wait(dispatch.query.query_id);
  if (query.status !== "COMPLETED") {
    const err = new Error(`${capabilityName} ended in status ${query.status}`);
    err.code = 502;
    throw err;
  }
  return getResult(dispatch.query.query_id);
}

// Everything after the initial GET_GRAFANA_TOTE_FINDER dispatch - status
// classification, Bad-Tracker last-good-location lookup, and Quadron/NexS
// blocked-inventory/purge-safety for Outside Tote/Bad Tracker candidates.
// Shared by run() (manual - finder dispatched for the caller's own tote
// list) and runAuto() (Auto Mode - finder already dispatched, chunked, for
// the discovered/stale tote list) so both modes reclassify at the exact same
// depth ("current logics").
// skipNexs: classify status only - no Quadron/NexS blocked-inventory enrichment. Callers that
// just COUNT Outside Totes (Dashboard tile, One Pager) pass it so they never need a NexS login.
async function classifyTotes({ totes, finderRows, scanRows, facility, requestCapability, wait, getResult: getCapabilityResult, user, skipNexs = false }) {
  let rows = buildBaseRows(totes, finderRows, scanRows);

  const badTrackers = [...new Set(rows.filter((r) => r.status === "Bad Tracker" && r.tracker).map((r) => r.tracker))];
  if (badTrackers.length) {
    const historyResult = await dispatchAndWait({
      requestCapability, wait, getResult: getCapabilityResult, user,
      capabilityName: "GET_GRAFANA_TRACKER_HISTORY", params: { trackers: badTrackers },
    });
    rows = applyLastGood(rows, historyResult && historyResult.rows);
  }

  const hasCandidates = rows.some((r) => isCandidateStatus(r.status));
  if (hasCandidates && !skipNexs) {
    const quadronResult = await dispatchAndWait({ requestCapability, wait, getResult: getCapabilityResult, user, capabilityName: "GET_QUADRON_INVENTORY", params: {} });
    const quadronRows = (quadronResult && quadronResult.rows) || [];

    const allSkus = new Set();
    for (const r of rows) {
      if (!isCandidateStatus(r.status)) continue;
      const row = quadronRows.find((q) => q.toteId === r.tote);
      for (const p of (row && row.partitions) || []) if (p.sku) allSkus.add(p.sku);
    }

    let blockedBySku = new Map();
    if (allSkus.size) {
      const nexsResult = await dispatchAndWait({
        requestCapability, wait, getResult: getCapabilityResult, user,
        capabilityName: "GET_NEXS_BLOCKED_INVENTORY_BATCH", params: { pids: [...allSkus], facilityCode: facility },
      });
      for (const r of (nexsResult && nexsResult.results) || []) {
        blockedBySku.set(r.pid, r.status === "ok" ? r.blockedInventory : null);
      }
    }
    rows = applyBlockedAndPurgeSafety(rows, quadronRows, blockedBySku);
  }

  return rows;
}

async function run({
  queryId,
  user,
  totes,
  facility,
  requestCapability = defaultCapabilityManager.requestCapability,
  wait = waitForTerminal,
  getResult: getCapabilityResult = defaultCapabilityManager.getResult,
  qm = defaultQueryManager,
}) {
  const controller = new AbortController();
  qm.registerJob(queryId, controller);

  try {
    await qm.markRunning(queryId);

    const finderResult = await dispatchAndWait({ requestCapability, wait, getResult: getCapabilityResult, user, capabilityName: "GET_GRAFANA_TOTE_FINDER", params: { totes } });
    const rows = await classifyTotes({
      totes,
      finderRows: finderResult && finderResult.finderRows,
      scanRows: finderResult && finderResult.scanRows,
      facility, requestCapability, wait, getResult: getCapabilityResult, user,
    });

    const fetchedAt = new Date().toISOString();
    await qm.completeQuery(queryId);
    return { rows, fetchedAt };
  } catch (e) {
    await qm.failQuery(queryId, e.message || String(e));
    throw e;
  } finally {
    qm.unregisterJob(queryId);
  }
}

// Auto Mode - no caller-supplied tote list. Discovers every Location='OUT'
// tote system-wide (GET_GRAFANA_CONTAINER_TRACKING), narrows to the ones
// whose GET_GRAFANA_TOTE_FINDER Updated timestamp is more than 12h stale as
// of right now, then reclassifies that final list through the exact same
// classifyTotes() depth run() uses for a manual list - "reclassify those
// totes as per current logics", never a separate/lighter code path.
async function runAuto({
  queryId,
  user,
  facility,
  skipNexs = false,
  requestCapability = defaultCapabilityManager.requestCapability,
  wait = waitForTerminal,
  getResult: getCapabilityResult = defaultCapabilityManager.getResult,
  qm = defaultQueryManager,
}) {
  const controller = new AbortController();
  qm.registerJob(queryId, controller);

  try {
    await qm.markRunning(queryId);

    const containerResult = await dispatchAndWait({
      requestCapability, wait, getResult: getCapabilityResult, user,
      capabilityName: "GET_GRAFANA_CONTAINER_TRACKING", params: {},
    });
    const containerRows = (containerResult && containerResult.rows) || [];
    const discovered = pickOutCandidates(containerRows);

    if (!discovered.length) {
      const fetchedAt = new Date().toISOString();
      await qm.completeQuery(queryId);
      return { rows: [], fetchedAt, discovered: 0, stale: 0 };
    }

    // Dispatched sequentially, in chunks - the runtime relays every Grafana
    // query through one shared, authenticated browser tab; overlapping
    // in-flight queries through that single tab can break it (see
    // public/js/dashboard.js's own comment on this exact constraint), so
    // each chunk is awaited before the next is dispatched, never in
    // parallel.
    let finderRows = [];
    let scanRows = [];
    for (let i = 0; i < discovered.length; i += FINDER_CHUNK_SIZE) {
      const chunk = discovered.slice(i, i + FINDER_CHUNK_SIZE);
      const chunkResult = await dispatchAndWait({
        requestCapability, wait, getResult: getCapabilityResult, user,
        capabilityName: "GET_GRAFANA_TOTE_FINDER", params: { totes: chunk },
      });
      if (chunkResult && chunkResult.finderRows) finderRows.push(...chunkResult.finderRows);
      if (chunkResult && chunkResult.scanRows) scanRows.push(...chunkResult.scanRows);
    }

    const stale = filterStaleByFinder(discovered, finderRows, Date.now() - AUTO_STALE_MS);
    if (!stale.length) {
      const fetchedAt = new Date().toISOString();
      await qm.completeQuery(queryId);
      return { rows: [], fetchedAt, discovered: discovered.length, stale: 0 };
    }

    let rows = await classifyTotes({
      totes: stale, finderRows, scanRows, facility, requestCapability, wait, getResult: getCapabilityResult, user, skipNexs,
    });
    rows = mergeContainerTrackingFields(rows, containerRows);

    const fetchedAt = new Date().toISOString();
    await qm.completeQuery(queryId);
    return { rows, fetchedAt, discovered: discovered.length, stale: stale.length };
  } catch (e) {
    await qm.failQuery(queryId, e.message || String(e));
    throw e;
  } finally {
    qm.unregisterJob(queryId);
  }
}

function validateTotes(totes) {
  if (!Array.isArray(totes) || totes.length === 0) {
    return { ok: false, reason: "totes must be a non-empty array" };
  }
  const invalid = totes.filter((t) => typeof t !== "string" || !TOTE_ID_REGEX.test(t));
  if (invalid.length) {
    return { ok: false, reason: `Invalid tote id(s): ${invalid.join(", ")}` };
  }
  return { ok: true };
}

module.exports = { run, runAuto, validateTotes, AUTO_STALE_MS, FINDER_CHUNK_SIZE };
