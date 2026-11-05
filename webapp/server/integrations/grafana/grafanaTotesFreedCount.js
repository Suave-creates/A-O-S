// Query definition for the GET_GRAFANA_TOTES_FREED_COUNT capability
// (Dashboard's "Tote Freed" row, shown alongside Compaction). SQL_TOTES_FREED
// is copied character-for-character from the legacy extension's
// background/index.js (SQL_TOTES_FREED, ~line 605) - not rewritten, not
// optimized, not changed in business logic.
//
// Same Grafana datasource as CC Metrics/Locked Totes/Supervisor Dump/Tote
// Finder (uid "rerQ11pVk" / type mssql / id 1 - confirmed by the legacy
// source's own CC_DS_UID constant, which SQL_TOTES_FREED is queried
// through) - deliberately its OWN capability rather than folded into
// GET_GRAFANA_CC_METRICS, so it dispatches/fails/retries completely
// independently of that capability's own known reliability issues (see the
// TEMPORARY DIAGNOSTIC INSTRUMENTATION comments in
// runtime/background/capabilities.js's executeGetGrafanaCcMetrics).

const SQL_TOTES_FREED = `WITH source_totes AS (
  SELECT
    source AS tote,
    sourcePartition,
    sku,
    MAX(create_time) AS latest_time,
    MIN(present_quantity) AS min_quantity
  FROM
    lenskart_gtp.dbo.compaction_transaction_history
  WHERE
     create_time between DATEADD(
       MINUTE,
       DATEDIFF(MINUTE, GETUTCDATE(), GETDATE()),
       $__timeFrom()
     )
     AND DATEADD(
       MINUTE,
       DATEDIFF(MINUTE, GETUTCDATE(), GETDATE()),
       $__timeTo()
     )
  GROUP BY
    source,
    sourcePartition,
    sku
),
tote_with_empty_partition AS (
  SELECT
    tote,
    sourcePartition,
    sku,
    latest_time
  FROM
    source_totes
  WHERE
    min_quantity = 0
),
decanted_totes AS (
  SELECT
    LEFT(td.container, 12) AS tote,
    MAX(td.create_time) AS decant_time
  FROM
    lenskart_wes.dbo.tote_details td
  GROUP BY
    LEFT(td.container, 12)
)
SELECT
    count(distinct et.tote) AS Totes_freed_updated_value
FROM
    tote_with_empty_partition et
LEFT JOIN
    decanted_totes dt ON dt.tote = et.tote
WHERE
    dt.tote IS NULL OR et.latest_time <= dt.decant_time;`;

const DATASOURCE_UID = "rerQ11pVk";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 1;

const SHIFT_KEYS = ["A", "B", "C"];

function buildPayload(grafanaOrigin, params) {
  const windows = (params && params.windows) || {};
  for (const key of SHIFT_KEYS) {
    const w = windows[key];
    if (!w || typeof w.from !== "number" || typeof w.to !== "number") {
      throw new Error(`GET_GRAFANA_TOTES_FREED_COUNT requires windows.${key}.{from,to} as numbers`);
    }
  }
  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    sql: SQL_TOTES_FREED,
    windows,
  };
}

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
