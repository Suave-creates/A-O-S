// Query definition for GET_GRAFANA_TRACKER_HISTORY - the Outside Tote
// Analysis tab's last-good-location lookup (Query 3), only ever dispatched
// for totes that turned out "Bad Tracker" (see server/features/tracker/trackerEngine.js -
// this is a SEPARATE, follow-up capability dispatch precisely because which
// trackers need this query is only known after GET_GRAFANA_TOTE_FINDER's own
// result is classified; the runtime never builds SQL, so this can't be
// folded into one capability call). Same datasource as grafanaToteFinder.js.

const DATASOURCE_UID = "rerQ11pVk";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 1;
const WINDOW_MS = 7 * 24 * 3600000;

// tracker ids are numeric (see the legacy extension's own trSqlNumIn()) -
// digits only, no quoting needed in the IN-list.
function sqlNumIn(trackers) {
  return trackers.map((t) => String(parseInt(t, 10))).join(",");
}

function buildSql(trackers) {
  return `SELECT tracker,destination,rn FROM (
SELECT th.tracker,th.destination,ROW_NUMBER() OVER (PARTITION BY th.tracker ORDER BY th.create_timestamp DESC) rn
FROM lenskart_quadron.dbo.tracker_history th WHERE th.tracker IN (${sqlNumIn(trackers)})) x WHERE rn<=2;`;
}

function buildPayload(grafanaOrigin, params) {
  const { trackers } = params || {};
  if (!Array.isArray(trackers) || trackers.length === 0) {
    throw new Error("GET_GRAFANA_TRACKER_HISTORY requires a non-empty trackers array");
  }
  const invalid = trackers.filter((t) => !Number.isInteger(Number(t)) || String(t).trim() === "");
  if (invalid.length) {
    throw new Error(`GET_GRAFANA_TRACKER_HISTORY: invalid tracker id(s): ${invalid.join(", ")}`);
  }
  const now = Date.now();
  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    sql: buildSql(trackers),
    fromMs: now - WINDOW_MS,
    toMs: now,
  };
}

function validateResult(result) {
  if (!result || !Array.isArray(result.rows)) return { ok: false, reason: "result.rows must be an array" };
  const allowedKeys = new Set(["tracker", "destination", "rn"]);
  for (const row of result.rows) {
    if (!row || (typeof row.tracker !== "string" && typeof row.tracker !== "number")) {
      return { ok: false, reason: "each row must have a tracker id" };
    }
    for (const key of Object.keys(row)) {
      if (!allowedKeys.has(key)) return { ok: false, reason: `unexpected field in row: ${key}` };
    }
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult };
