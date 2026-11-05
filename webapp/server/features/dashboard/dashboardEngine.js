// Aisle Occupancy (Grafana live snapshot) for the Dashboard and the One Pager
// Report. The shift-level sections (CC, compaction, ASRS production) live in
// dashboardMetrics.js - the single data layer both screens share.

const defaultCapabilityManager = require("../../integrations/capabilities/capabilityManager");
const { waitForTerminal } = require("../../platform/queries/queryPoll");
const defaultQueryManager = require("../../platform/queries/queryManager");

const AISLE_NUMS = ["001", "002", "003", "004", "005", "006"];

function avg(vals) {
  const present = vals.filter((v) => v != null);
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
}

// occupancy: [{aisle, value}], longShort: [{aisle, category, occupancy}] ->
// the 3-row {label, values[6], average} shape the Dashboard's Aisle
// Occupancy table renders directly (Aisle Occupancy / Large / Short rows,
// same as the legacy extension's own table).
function combineAisleOccupancy(occupancy, longShort) {
  const occByAisle = {};
  (occupancy || []).forEach((r) => { occByAisle[r.aisle] = r.value; });
  const lsByAisle = {};
  (longShort || []).forEach((r) => {
    if (!lsByAisle[r.aisle]) lsByAisle[r.aisle] = {};
    if (r.category === "TALL") lsByAisle[r.aisle].large = r.occupancy;
    else if (r.category === "SHORT") lsByAisle[r.aisle].short = r.occupancy;
  });
  const occValues = AISLE_NUMS.map((a) => (occByAisle[a] != null ? occByAisle[a] : null));
  const largeValues = AISLE_NUMS.map((a) => ((lsByAisle[a] || {}).large != null ? lsByAisle[a].large : null));
  const shortValues = AISLE_NUMS.map((a) => ((lsByAisle[a] || {}).short != null ? lsByAisle[a].short : null));
  return {
    aisles: AISLE_NUMS,
    occupancy: { values: occValues, average: avg(occValues) },
    large: { values: largeValues, average: avg(largeValues) },
    short: { values: shortValues, average: avg(shortValues) },
  };
}

// Dashboard's Aisle Occupancy section - previously believed to have no live
// data source anywhere (wrong - confirmed against a real, working Grafana
// panel capture). Its own function/route/Query Manager row, 
async function getAisleOccupancy({
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

    const dispatch = await requestCapability({ user, capabilityName: "GET_GRAFANA_AISLE_OCCUPANCY", params: {} });
    if (!dispatch.ok) {
      const err = new Error(dispatch.reason || "GET_GRAFANA_AISLE_OCCUPANCY dispatch failed");
      err.code = dispatch.code || 502;
      throw err;
    }

    const capQueryId = dispatch.query.query_id;
    const query = await wait(capQueryId);
    if (query.status !== "COMPLETED") {
      const err = new Error(`GET_GRAFANA_AISLE_OCCUPANCY ended in status ${query.status}`);
      err.code = 502;
      throw err;
    }

    const result = getCapabilityResult(capQueryId);
    if (!result) {
      const err = new Error("GET_GRAFANA_AISLE_OCCUPANCY returned no result");
      err.code = 502;
      throw err;
    }

    const rows = combineAisleOccupancy(result.occupancy, result.longShort);
    const generatedAt = new Date().toISOString();

    await qm.completeQuery(queryId);
    return { generatedAt, ...rows };
  } catch (e) {
    await qm.failQuery(queryId, e.message || String(e));
    throw e;
  } finally {
    qm.unregisterJob(queryId);
  }
}

module.exports = { getAisleOccupancy, combineAisleOccupancy };
