// ASRS Locations - orchestrates the single capability dispatch this feature
// needs (GET_GRAFANA_CONTAINER_TRACKING, already built for Outside Tote
// Analysis's Auto Mode - see trackerEngine.js's own runAuto()) and hands the
// result to the pure model in asrsLocationModel.js. Same registerJob/
// markRunning/dispatch/completeQuery/failQuery/unregisterJob shape as
// dashboardEngine.getAisleOccupancy() - ONE Query Manager row for the whole
// run, no params needed (this always replicates the whole ASRS).
//
// 100% read-only, same as every other capability dispatched here.

const defaultCapabilityManager = require("../../integrations/capabilities/capabilityManager");
const { waitForTerminal } = require("../../platform/queries/queryPoll");
const defaultQueryManager = require("../../platform/queries/queryManager");
const { buildOccupancyModel } = require("./asrsLocationModel");

async function getAsrsLocations({
  queryId,
  user,
  requestCapability = defaultCapabilityManager.requestCapability,
  wait = waitForTerminal,
  getResult: getCapabilityResult = defaultCapabilityManager.getResult,
  qm = defaultQueryManager,
}) {
  const controller = new AbortController();
  qm.registerJob(queryId, controller);

  try {
    await qm.markRunning(queryId);

    const dispatch = await requestCapability({ user, capabilityName: "GET_GRAFANA_CONTAINER_TRACKING", params: {} });
    if (!dispatch.ok) {
      const err = new Error(dispatch.reason || "GET_GRAFANA_CONTAINER_TRACKING dispatch failed");
      err.code = dispatch.code || 502;
      throw err;
    }

    const capQueryId = dispatch.query.query_id;
    const query = await wait(capQueryId);
    if (query.status !== "COMPLETED") {
      const err = new Error(`GET_GRAFANA_CONTAINER_TRACKING ended in status ${query.status}`);
      err.code = 502;
      throw err;
    }

    const result = getCapabilityResult(capQueryId);
    const model = buildOccupancyModel((result && result.rows) || []);
    const generatedAt = new Date().toISOString();

    await qm.completeQuery(queryId);
    return { generatedAt, ...model };
  } catch (e) {
    await qm.failQuery(queryId, e.message || String(e));
    throw e;
  } finally {
    qm.unregisterJob(queryId);
  }
}

module.exports = { getAsrsLocations };
