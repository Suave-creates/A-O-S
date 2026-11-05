// Direct-login pilot - server-side execution of GET_GRAFANA_TRACKER_HISTORY
// when config.grafanaAuthMode === "direct", instead of relaying through the
// ASO Browser Runtime (whose tab-relay path is failing live in production,
// 2026-09-23 - see grafanaContainerTrackingDirect.js's own header comment
// for the full investigation; this capability shares the exact same
// runtime-relay dependency and Outside Tote Analysis pipeline as
// GET_GRAFANA_TOTE_FINDER, fixed alongside this one for the same reason).
// Ported from the runtime's own already-verified
// executeGetGrafanaTrackerHistory()/frameRowsByName() (runtime/background/
// capabilities.js).
//
// grafanaTrackerHistory.js's own buildPayload() names its SQL field "sql"
// (not "rawSql" like GET_GRAFANA_LOCKED_TOTES/_SUPERVISOR_DUMP) - the
// runtime's own handler remaps that itself (`rawSql: sql`) before calling
// its shared query helper; this module does the exact same remap here,
// rather than touching buildPayload() (which would also change the still-
// registered runtime path).

const grafanaQueryDirect = require("./grafanaQueryDirect");

// Mirrors the runtime's own frameRowsByName() exactly - see
// grafanaContainerTrackingDirect.js's identical copy for the full
// reasoning; duplicated (not shared/imported) since it's a tiny, pure,
// dependency-free helper and every *Direct.js module in this directory is
// already deliberately self-contained.
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
