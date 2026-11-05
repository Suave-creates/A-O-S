// Query definition for GET_GRAFANA_TOTE_FINDER - the Outside Tote Analysis
// (Tracker) tab's Query 1 (tote finder / location) + Query 2 (scanner
// events), ported verbatim from the legacy extension's own tracker code
// (background/index.js's trGrafana() calls). Same datasource (uid
// "rerQ11pVk", type "mssql", id 1) as GET_GRAFANA_LOCKED_TOTES/
// GET_GRAFANA_CC_METRICS. Backend builds both complete SQL strings from a
// validated tote-ID list - the runtime only ever executes what it's given.

const { TOTE_ID_REGEX } = require("../quadron/pullQuadronTote");

const DATASOURCE_UID = "rerQ11pVk";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 1;
const WINDOW_MS = 7 * 24 * 3600000; // 7 days, matching the legacy extension's own trGrafana() window

// "Never real SQL escaping, but strips to alnum/_/- inside quotes" - same
// discipline as the legacy extension's own trSqlStrIn(), reused here since
// every entry has ALREADY been validated against TOTE_ID_REGEX by the time
// this runs (defense in depth, not the only guard).
function sqlStrIn(ids) {
  return ids.map((s) => `'${String(s).replace(/[^A-Za-z0-9_-]/g, "")}'`).join(",");
}

function buildFinderSql(totes) {
  return `SELECT tracker,container,location,lane,updated_timestamp FROM (
SELECT lt.tracker,ct.container,lt.location,lt.lane,lt.updated_timestamp,
ROW_NUMBER() OVER (PARTITION BY ct.container ORDER BY ct.created_time DESC) rn
FROM lenskart_quadron.dbo.location_tracker lt
JOIN lenskart_quadron.dbo.container_tracker ct ON ct.tracker=lt.tracker
WHERE ct.container IN (${sqlStrIn(totes)})) x WHERE rn=1;`;
}

function buildScanSql(totes) {
  return `SELECT scanner,container,create_time,decision,decision_reason FROM (
SELECT se.scanner,se.container,se.create_time,se.decision,se.decision_reason,
ROW_NUMBER() OVER (PARTITION BY se.container ORDER BY se.create_time DESC) rn
FROM lenskart_gtp.dbo.scanner_events se
WHERE se.container IN (${sqlStrIn(totes)})) x WHERE rn<=5 ORDER BY container,create_time DESC;`;
}

function buildPayload(grafanaOrigin, params) {
  const { totes } = params || {};
  if (!Array.isArray(totes) || totes.length === 0) {
    throw new Error("GET_GRAFANA_TOTE_FINDER requires a non-empty totes array");
  }
  const invalid = totes.filter((t) => typeof t !== "string" || !TOTE_ID_REGEX.test(t));
  if (invalid.length) {
    throw new Error(`GET_GRAFANA_TOTE_FINDER: invalid tote id(s): ${invalid.join(", ")}`);
  }
  const now = Date.now();
  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    finderSql: buildFinderSql(totes),
    scanSql: buildScanSql(totes),
    fromMs: now - WINDOW_MS,
    toMs: now,
  };
}

function validateResult(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "result must be an object" };
  if (!Array.isArray(result.finderRows)) return { ok: false, reason: "result.finderRows must be an array" };
  if (!Array.isArray(result.scanRows)) return { ok: false, reason: "result.scanRows must be an array" };
  const finderKeys = new Set(["tracker", "container", "location", "lane", "updated_timestamp"]);
  for (const row of result.finderRows) {
    if (!row || typeof row.container !== "string" || !row.container) return { ok: false, reason: "each finderRows entry must have a non-empty string container" };
    for (const key of Object.keys(row)) {
      if (!finderKeys.has(key)) return { ok: false, reason: `unexpected field in finderRows entry: ${key}` };
    }
  }
  const scanKeys = new Set(["scanner", "container", "create_time", "decision", "decision_reason"]);
  for (const row of result.scanRows) {
    if (!row || typeof row.container !== "string" || !row.container) return { ok: false, reason: "each scanRows entry must have a non-empty string container" };
    for (const key of Object.keys(row)) {
      if (!scanKeys.has(key)) return { ok: false, reason: `unexpected field in scanRows entry: ${key}` };
    }
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult };
