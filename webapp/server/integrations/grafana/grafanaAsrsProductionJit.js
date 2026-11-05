// Query definition for the GET_GRAFANA_ASRS_PRODUCTION_JIT capability (One
// Pager Report's ASRS Production section, JIT row). SQL_JIT_PRODUCTION is
// copied character-for-character from the standalone "ASRS Production
// Report (JIT/NJIT)" Chrome extension (asrs-production-report/report.js,
// DASHBOARDS.JIT.rawSql).
//
// Full Hour 1-8 breakdown per shift, one Grafana call PER HOUR - see
// grafanaAsrsProductionNjit.js's own header comment for the full reasoning
// (matches that source extension's own hour-by-hour design/table shape).
//
// NOTE, carried over verbatim from the source extension's own README: this
// query is scoped to jit_flag='true' AND category='FRAME' - that is a
// property of the dashboard's own SQL, not something added here. JIT
// lens-category completions are not covered by this figure, same
// limitation the standalone extension always had.
//
// A GENUINELY SEPARATE Grafana datasource from every other capability in
// this registry (uid "A83AuthVz" / datasourceId 2, confirmed from the
// extension's own DASHBOARDS.JIT config) - its own dedicated dashboard/data
// source, same "own capability for its own datasource" reasoning as
// Compaction's separate GTP instance (see grafanaCompactionCount.js).

const SQL_JIT_PRODUCTION = `use lenskart_wes
select count(distinct so.id) as CompletedOrders from sales_order so
inner join sales_order_line sol on so.id =sol.order_id where jit_flag='true' and sol.category ='FRAME'
and so.status =7 AND so.order_picked_timestamp between DATEADD(MINUTE,DATEDIFF(MINUTE, GETUTCDATE(),GETDATE()),$__timeFrom()) AND DATEADD(MINUTE,DATEDIFF(MINUTE, GETUTCDATE(),GETDATE()),$__timeTo());`;

const DATASOURCE_UID = "A83AuthVz";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 2;

const SHIFT_KEYS = ["A", "B", "C"];
const HOURS_PER_SHIFT = 8;

function validHourArray(arr) {
  return Array.isArray(arr) && arr.length === HOURS_PER_SHIFT && arr.every((w) => w && typeof w.from === "number" && typeof w.to === "number");
}

function buildPayload(grafanaOrigin, params) {
  const hourWindows = (params && params.hourWindows) || {};
  for (const key of SHIFT_KEYS) {
    if (!validHourArray(hourWindows[key])) {
      throw new Error(`GET_GRAFANA_ASRS_PRODUCTION_JIT requires hourWindows.${key} as an array of ${HOURS_PER_SHIFT} {from,to} windows`);
    }
  }
  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    sql: SQL_JIT_PRODUCTION,
    hourWindows,
  };
}

function validateResult(result) {
  if (!result || typeof result !== "object" || !result.hours || typeof result.hours !== "object") {
    return { ok: false, reason: "result.hours must be an object keyed by shift" };
  }
  for (const key of SHIFT_KEYS) {
    const arr = result.hours[key];
    if (!Array.isArray(arr) || arr.length !== HOURS_PER_SHIFT || !arr.every((v) => v === null || (typeof v === "number" && Number.isFinite(v)))) {
      return { ok: false, reason: `result.hours.${key} must be an array of ${HOURS_PER_SHIFT} finite numbers (null = skipped hour)` };
    }
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult, SHIFT_KEYS, HOURS_PER_SHIFT };
