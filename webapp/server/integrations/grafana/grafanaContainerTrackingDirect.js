// Direct-login pilot - server-side execution of GET_GRAFANA_CONTAINER_TRACKING
// when config.grafanaAuthMode === "direct", instead of relaying through the
// ASO Browser Runtime (whose tab-relay path was failing live in production,
// 2026-09-23: "Cannot access contents of the page. Extension manifest must
// request permission to access the respective host." - repeated FAILED rows
// in `queries`, blocking ASRS Location Audit / Outside Tote Analysis).
// Ported from the runtime's own already-verified
// executeGetGrafanaContainerTracking()/frameRowsByName() (runtime/
// background/capabilities.js) - same URL, same NAME-based row shaping (this
// query's own SQL already aliases every column to the exact camelCase field
// name grafanaContainerTracking.js's own validateResult() expects -
// container/tracker/location/zone/shuttle/shuttleHealthStatus/
// stockCheckBlocked/binBlocked/badTracker - so shaping by Grafana's own
// returned field NAME, not a hardcoded column index, is what the runtime
// already relied on and what this module preserves).
//
// grafanaContainerTracking.js's own buildPayload() names its SQL field
// "sql" (not "rawSql" like every other Grafana capability - GET_GRAFANA_
// LOCKED_TOTES/_SUPERVISOR_DUMP) - the runtime's own
// executeGetGrafanaContainerTracking() remaps that itself (`rawSql: sql`)
// before calling its shared query helper; this module does the exact same
// remap here, rather than touching buildPayload() (which would also change
// the still-registered runtime path) or grafanaQueryDirect.js's own shared
// plumbing (which every OTHER Grafana capability's payload already matches
// as-is, unchanged).

const grafanaQueryDirect = require("./grafanaQueryDirect");

// Mirrors the runtime's own frameRowsByName() (runtime/background/
// capabilities.js) exactly - zips each frame column by its own schema
// field NAME, not a hardcoded index, so this stays correct even if the
// SQL's own SELECT column order ever changes.
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
// contract capabilityManager.js calls for every direct-mode capability, but
// is unused here since grafanaQueryDirect.js's login is grafanaAuth.js's own
// SHARED single account, not a per-user credential.
async function execute(appUserId, payload, signal, deps = {}) {
  const { sql, ...rest } = payload || {};
  const data = await grafanaQueryDirect.runQuery({ ...rest, rawSql: sql }, signal, deps);
  const rows = frameRowsByName(data);
  return { rows, fetchedAt: new Date().toISOString() };
}

module.exports = { execute, frameRowsByName };
