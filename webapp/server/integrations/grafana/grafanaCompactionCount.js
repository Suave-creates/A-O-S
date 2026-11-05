// Query definition for the GET_GRAFANA_COMPACTION_COUNT capability
// (Dashboard's Compaction row). SQL_COMPACTION is copied character-for-
// character from the legacy extension's background/index.js (SQL_COMPACTION,
// ~line 589) - not rewritten, not optimized, not changed in business logic.
//
// Compaction uses a SEPARATE, dedicated Grafana datasource from every other
// capability in this registry (confirmed in the legacy source's own comment:
// uid "BE6qWEb4z" / datasourceId 6, its own GTP instance - vs "rerQ11pVk" / 1
// used by CC Metrics/Locked Totes/Supervisor Dump/Tote Finder). Same Grafana
// origin though (still proxied through /grafana/api/ds/query) - only the
// datasource within that Grafana instance differs, so hostAllowList in the
// registry is unchanged (still just config.grafanaOrigin).
//
// Same "one capability call runs all 3 shifts" shape as GET_GRAFANA_CC_METRICS
// (see grafanaCcMetrics.js) - ONE Query Manager row for the whole Compaction
// section, not one per shift.

const SQL_COMPACTION = `WITH compaction_events_gtp AS (
SELECT
	cth.station,
	COUNT(DISTINCT  concat(cth.[source], cth.sourcePartition , cth.destination, cth.destinationPartition)) AS compaction_events
FROM
	lenskart_gtp.dbo.compaction_transaction_history cth
WHERE
	cth.create_time BETWEEN
						DATEADD(MINUTE, DATEDIFF(MINUTE, GETUTCDATE(), GETDATE()), $__timeFrom())
					AND
						DATEADD(MINUTE, DATEDIFF(MINUTE, GETUTCDATE(), GETDATE()), $__timeTo())
GROUP BY
	cth.station
)
SELECT
	SUM(compaction_events) AS total_compactions
FROM
	compaction_events_gtp AS ceg;`;

const DATASOURCE_UID = "BE6qWEb4z";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 6;

const SHIFT_KEYS = ["A", "B", "C"];

// buildPayload(grafanaOrigin, params) - params.windows: {A:{from,to}, B:{...}, C:{...}}
// (fromMs/toMs, as produced by shiftWindows.js) - same required shape as
// GET_GRAFANA_CC_METRICS, no meaningful default window.
function buildPayload(grafanaOrigin, params) {
  const windows = (params && params.windows) || {};
  for (const key of SHIFT_KEYS) {
    const w = windows[key];
    if (!w || typeof w.from !== "number" || typeof w.to !== "number") {
      throw new Error(`GET_GRAFANA_COMPACTION_COUNT requires windows.${key}.{from,to} as numbers`);
    }
  }
  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    sql: SQL_COMPACTION,
    windows,
  };
}

// result.windows.{A,B,C} -> a plain number each (the SQL already SUMs to one
// scalar server-side, same convention as the legacy fetchCompactionCount()).
function validateResult(result) {
  if (!result || typeof result !== "object" || !result.windows || typeof result.windows !== "object") {
    return { ok: false, reason: "result.windows must be an object keyed by shift" };
  }
  for (const key of SHIFT_KEYS) {
    if (result.windows[key] !== null && (typeof result.windows[key] !== "number" || !Number.isFinite(result.windows[key]))) { // null = skipped shift
      return { ok: false, reason: `result.windows.${key} must be a finite number` };
    }
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult, SHIFT_KEYS };
