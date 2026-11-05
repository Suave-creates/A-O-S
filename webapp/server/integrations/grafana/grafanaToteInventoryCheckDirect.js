// Direct-login pilot - server-side execution of
// GET_GRAFANA_TOTE_INVENTORY_CHECK when config.grafanaAuthMode === "direct".
// This capability is brand new (2026-10-01) - built direct-only from the
// start, since the ASO Browser Runtime's own tab-relay path is the one
// already proven broken in production for every other Grafana capability
// migrated this same week (see grafanaContainerTrackingDirect.js's own
// header comment for the full investigation) - there is no working runtime
// path left to port FROM, so this never had one to begin with. Uses
// grafanaAuth.js's existing SHARED single Grafana login, same as every
// other *Direct.js module in this directory.
//
// grafanaToteInventoryCheck.js's own buildPayload() names its SQL field
// "sql" (matching grafanaContainerTracking.js/grafanaTrackerHistory.js's own
// convention, not "rawSql") - remapped here before handing off to the
// shared grafanaQueryDirect.js plumbing, same as those two modules.

const grafanaQueryDirect = require("./grafanaQueryDirect");

// Mirrors the runtime's own frameRowsByName() (runtime/background/
// capabilities.js) exactly - zips each frame column by its own schema
// field NAME, not a hardcoded index. Duplicated (not shared/imported)
// since it's a tiny, pure, dependency-free helper and every *Direct.js
// module in this directory is already deliberately self-contained.
function frameRowsByName(data) {
  const f = data && data.results && data.results.A && data.results.A.frames && data.results.A.frames[0];
  if (!f || !f.schema || !Array.isArray(f.schema.fields)) return [];
  const names = f.schema.fields.map((x) => x.name);
  const cols = (f.data && f.data.values) || [];
  const n = (cols[0] || []).length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = {};
    names.forEach((nm, ci) => (o[nm] = cols[ci] ? cols[ci][i] : undefined));
    out.push(o);
  }
  return out;
}

// appUserId is part of the uniform directExecute(appUserId, payload, signal)
// contract but unused here - grafanaQueryDirect.js's login is grafanaAuth.js's
// own SHARED single account, not a per-user credential.
async function execute(appUserId, payload, signal, deps = {}) {
  const { sql, ...rest } = payload || {};
  const data = await grafanaQueryDirect.runQuery({ ...rest, rawSql: sql }, signal, deps);
  const rows = frameRowsByName(data);
  return { rows, fetchedAt: new Date().toISOString() };
}

module.exports = { execute, frameRowsByName };
