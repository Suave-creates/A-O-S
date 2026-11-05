// CNG Inv Validator - orchestrates the 3 capability dispatches this feature
// needs (GET_QUADRON_INVENTORY, GET_GRAFANA_TOTE_PARTITION_COUNTS,
// GET_NEXS_DISCREPANCY_REPORT_BATCH) and hands the results to
// cngReconcile.js's pure verdict computation. Mirrors dashboardEngine.js's
// own createQuery/registerJob/markRunning/requestCapability/waitForTerminal/
// completeQuery/failQuery shape exactly - ONE Query Manager row for the
// whole run, not one per capability.
//
// 100% read-only: every capability dispatched here is readOnly:true in the
// registry (see server/integrations/capabilities/registry.js) - this module has no code
// path that can create a pull session or dispatch PULL_QUADRON_TOTE.

const defaultCapabilityManager = require("../../integrations/capabilities/capabilityManager");
const { waitForTerminal } = require("../../platform/queries/queryPoll");
const defaultQueryManager = require("../../platform/queries/queryManager");
const { TOTE_ID_REGEX } = require("../../integrations/quadron/pullQuadronTote");
const { indexQuadronByBase, indexGrafanaByBase, indexNexsByBase, unionPartitionItems, computeRows } = require("./cngReconcile");

// Cancellation (operator-reported: Q-001900 "running rogue with no cancel
// option" - see server/platform/queries/cancellationSupport.js's own history of this
// exact gap on other backend-only jobs). This wrapper's own AbortController
// controls nothing by itself - each capability dispatch below is tracked as
// its own SEPARATE query with its own registry entry, so aborting THIS
// controller alone would only flip this query's own status while the real
// work (e.g. a live GET_NEXS_DISCREPANCY_REPORT_BATCH dispatch, the one
// that actually ran long on Q-001900) kept running underneath, unaware -
// the exact "fake cancel" trap this file's capabilityManager-mirroring
// shape otherwise falls into.
//
// Fix: track whichever inner capability quer(ies) are CURRENTLY in flight,
// and on abort, cascade a real qm.cancelQuery() to each of them - reusing
// the already-verified, race-safe capability cancellation path
// (queryManager.cancelQuery() -> that query's own AbortController.abort()
// -> capabilityManager's onAbort sends CAPABILITY_CANCEL to the runtime),
// not a second interruption mechanism. dispatchTrackedAndWait() below also
// checks the signal before starting each NEW dispatch, so a cancel that
// arrives between stages (not mid-dispatch) stops the next stage from ever
// starting.
async function run({
  queryId,
  user,
  totes,
  facility,
  focusMode = false,
  requestCapability = defaultCapabilityManager.requestCapability,
  wait = waitForTerminal,
  getResult: getCapabilityResult = defaultCapabilityManager.getResult,
  qm = defaultQueryManager,
}) {
  const controller = new AbortController();
  const job = qm.registerJob(queryId, controller);

  const inFlightInnerQueryIds = new Set();
  controller.signal.addEventListener("abort", () => {
    for (const innerId of inFlightInnerQueryIds) qm.cancelQuery(innerId, user).catch(() => {});
  });

  async function dispatchTrackedAndWait(capabilityName, params) {
    if (controller.signal.aborted) {
      const err = new Error("Cancelled");
      err.name = "AbortError";
      throw err;
    }
    const dispatch = await requestCapability({ user, capabilityName, params });
    if (!dispatch.ok) {
      const err = new Error(dispatch.reason || `${capabilityName} dispatch failed`);
      err.code = dispatch.code || 502;
      throw err;
    }
    const innerId = dispatch.query.query_id;
    inFlightInnerQueryIds.add(innerId);
    try {
      const query = await wait(innerId);
      if (query.status !== "COMPLETED") {
        const err = new Error(`${capabilityName} ended in status ${query.status}`);
        err.code = 502;
        if (query.status === "CANCELLED") err.name = "AbortError";
        throw err;
      }
      return dispatch;
    } finally {
      inFlightInnerQueryIds.delete(innerId);
    }
  }

  try {
    await qm.markRunning(queryId);

    // Quadron (always fetches the full live inventory, unfiltered - see
    // quadronInventory.js's own comment) and Grafana (chunked to exactly
    // these totes) are independent of each other - dispatch in parallel.
    const [quadronDispatch, grafanaDispatch] = await Promise.all([
      dispatchTrackedAndWait("GET_QUADRON_INVENTORY", {}),
      dispatchTrackedAndWait("GET_GRAFANA_TOTE_PARTITION_COUNTS", { totes }),
    ]);

    const quadronResult = getCapabilityResult(quadronDispatch.query.query_id);
    const grafanaResult = getCapabilityResult(grafanaDispatch.query.query_id);

    const quadronByBase = indexQuadronByBase(quadronResult && quadronResult.rows, totes);
    const grafanaByBase = indexGrafanaByBase(grafanaResult && grafanaResult.rows);

    // NexS is normally queried only for partitions Quadron/Grafana actually
    // revealed - never used to discover partitions itself (mirrors the
    // legacy algorithm). Focus Mode overrides this: it sweeps every
    // possible partition per tote type (PR1-8 for TL, PR1-20 for TS)
    // regardless of what Quadron/Grafana show, so real NexS data isn't
    // hidden just because those two are currently blank for a tote.
    const items = unionPartitionItems(totes, quadronByBase, grafanaByBase, focusMode);
    let nexsByBase = new Map();
    if (items.length) {
      const nexsDispatch = await dispatchTrackedAndWait("GET_NEXS_DISCREPANCY_REPORT_BATCH", { items, facilityCode: facility });
      const nexsResult = getCapabilityResult(nexsDispatch.query.query_id);
      nexsByBase = indexNexsByBase(nexsResult && nexsResult.results);
    }

    const rows = computeRows(totes, quadronByBase, grafanaByBase, nexsByBase, focusMode);
    const fetchedAt = new Date().toISOString();

    await qm.completeQuery(queryId);
    return { rows, fetchedAt };
  } catch (e) {
    if (e.name === "AbortError" && job.wasCancelledByUser()) {
      await qm.finalizeCancelled(queryId);
    } else {
      await qm.failQuery(queryId, e.message || String(e));
    }
    throw e;
  } finally {
    qm.unregisterJob(queryId);
  }
}

// Validates a raw, operator-supplied tote list before it's ever used to
// build a query - same discipline as totePullEngine.js's own tote
// validation, though this never dispatches a real pull.
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

module.exports = { run, validateTotes };
