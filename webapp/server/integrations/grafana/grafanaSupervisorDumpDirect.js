// Direct-login pilot (2026-09-05) - server-side row-shaping for
// GET_GRAFANA_SUPERVISOR_DUMP, used when config.grafanaAuthMode ===
// "direct". grafanaQueryDirect.js owns talking to Grafana; this module
// only shapes the raw response - ported field-for-field from the runtime's
// own already-verified executeGetGrafanaSupervisorDump() (runtime/
// background/capabilities.js): SQL_SUPERVISOR's positional columns [13]
// (singleBin/doubleBin/containerStatus/shuttleHealth/networkStatus - a row
// only qualifies if this contains "LOCKED") and [15]
// (Inventory/Borrower, where the real tote id is embedded, e.g.
// "007-06-1-217-1-02/TS0000003490-1/QUADRON/") are not renamed or
// reinterpreted here.

const grafanaQueryDirect = require("./grafanaQueryDirect");

const TOTE_REGEX = /^(TL|TS)[0-9]{10}$/;
const TOTE_EXTRACT = /T[SL]\d{10}/g;

function shapeResult(data) {
  const values =
    data && data.results && data.results.A && data.results.A.frames && data.results.A.frames[0] && data.results.A.frames[0].data
      ? data.results.A.frames[0].data.values
      : null;
  if (!values) {
    return { rows: [], rowCount: 0, fetchedAt: new Date().toISOString() };
  }

  const statusVals = values[13] || [];
  const inventoryVals = values[15] || [];
  const rowCount = Math.max(statusVals.length, inventoryVals.length);

  const toteSet = new Set();
  for (let i = 0; i < rowCount; i++) {
    const status = String(statusVals[i] || "").toUpperCase();
    if (!status.includes("LOCKED")) continue; // only LOCKED container status rows are SD candidates
    const invBorrower = String(inventoryVals[i] || "");
    if (!invBorrower) continue;
    const matches = invBorrower.match(TOTE_EXTRACT);
    if (matches) matches.forEach((t) => { if (TOTE_REGEX.test(t)) toteSet.add(t); });
  }

  const rows = [...toteSet].map((toteId) => ({ toteId }));
  return { rows, rowCount: rows.length, fetchedAt: new Date().toISOString() };
}

// appUserId is part of the uniform directExecute(appUserId, payload, signal)
// contract capabilityManager.js calls for every direct-mode capability, but
// is unused here since grafanaQueryDirect.js's login is now grafanaAuth.js's
// own SHARED single account (2026-09-22), not a per-user credential.
async function execute(appUserId, payload, signal, deps = {}) {
  const data = await grafanaQueryDirect.runQuery(payload, signal, deps);
  return shapeResult(data);
}

module.exports = { execute, shapeResult };
