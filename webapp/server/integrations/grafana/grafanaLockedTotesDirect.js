// Direct-login pilot (2026-09-05) - server-side row-shaping for
// GET_GRAFANA_LOCKED_TOTES, used when config.grafanaAuthMode === "direct".
// grafanaQueryDirect.js owns talking to Grafana; this module only shapes
// the raw response - ported field-for-field from the runtime's own
// already-verified executeGetGrafanaLockedTotes() (runtime/background/
// capabilities.js): SQL_LOCKED's SELECT order is Container, Tracker,
// Location, Zone, Shuttle - values[0..4] map positionally, exactly as
// there.

const grafanaQueryDirect = require("./grafanaQueryDirect");

const TOTE_REGEX = /^(TL|TS)[0-9]{10}$/;

function shapeResult(data) {
  const values =
    data && data.results && data.results.A && data.results.A.frames && data.results.A.frames[0] && data.results.A.frames[0].data
      ? data.results.A.frames[0].data.values
      : null;
  if (!values || !values[0]) {
    return { rows: [], rowCount: 0, fetchedAt: new Date().toISOString() };
  }

  const rows = values[0]
    .map((container, i) => ({
      toteId: container,
      tracker: values[1] ? values[1][i] ?? null : null,
      location: values[2] ? values[2][i] ?? null : null,
      zone: values[3] ? values[3][i] ?? null : null,
      shuttle: values[4] ? values[4][i] ?? null : null,
    }))
    .filter((r) => TOTE_REGEX.test(String(r.toteId || "")));

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
