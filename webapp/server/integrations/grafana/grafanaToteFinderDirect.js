// Direct-login pilot - server-side execution of GET_GRAFANA_TOTE_FINDER when
// config.grafanaAuthMode === "direct", instead of relaying through the ASO
// Browser Runtime (whose tab-relay path is failing live in production,
// 2026-09-23: "Cannot access contents of the page. Extension manifest must
// request permission to access the respective host." - same root cause
// already fixed for GET_GRAFANA_CONTAINER_TRACKING - see
// grafanaContainerTrackingDirect.js's own header comment for the full
// investigation). Ported from the runtime's own already-verified
// executeGetGrafanaToteFinder()/frameRowsByName() (runtime/background/
// capabilities.js) - dispatches BOTH the finder and scanner-events queries
// in parallel (same as the runtime does), each shaped by its own frame's
// schema field NAMES, not a hardcoded column index. Two concurrent
// grafanaQueryDirect.runQuery() calls safely share ONE shared-login session
// (grafanaAuth.js's own single-flight login guard covers this - a fresh
// login mid-flight is only ever attempted once, and both queries await it).

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
  const { grafanaOrigin, datasourceUid, datasourceType, datasourceId, finderSql, scanSql, fromMs, toMs } = payload || {};
  const base = { grafanaOrigin, datasourceUid, datasourceType, datasourceId, fromMs, toMs };
  const [finderData, scanData] = await Promise.all([
    grafanaQueryDirect.runQuery({ ...base, rawSql: finderSql }, signal, deps),
    grafanaQueryDirect.runQuery({ ...base, rawSql: scanSql }, signal, deps),
  ]);
  return {
    finderRows: frameRowsByName(finderData),
    scanRows: frameRowsByName(scanData),
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { execute, frameRowsByName };
