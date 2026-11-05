// Query definitions for two more ASRS Production rows (operator-supplied 2026-11-04, from the WES stats
// dashboard "generic-dashboard-for-wes-stats-update", panel 2):
//
//   GET_GRAFANA_ASRS_PRODUCTION_FR0        FR0 picking - COMPLETED ORDERS (the dashboard's "completedOrders" query
//                                          with @type = 'FR0'; the same SQL as the NJIT row with a different type)
//   GET_GRAFANA_ASRS_PRODUCTION_BULK_ITEMS FR0-Bulk picking - ITEMS PICKED, not orders (the dashboard's
//                                          "itemsPicked" query with @type = 'BULK': sales-order lines in status
//                                          7 or 4, timed by item_picked_timestamp)
//
// The SQL is copied as the operator gave it, only @type fixed. Same datasource as NJIT / CC metrics
// (uid "rerQ11pVk" / datasourceId 1). One Grafana call per hour, 8 per shift, like JIT / NJIT.

const SQL_FR0_COMPLETED_ORDERS = `use lenskart_wes
DECLARE @type VARCHAR(100) = 'FR0';
DECLARE @priority VARCHAR(100) ='ALL';

SELECT DISTINCT COUNT(distinct so.id) AS completedOrders FROM sales_order so
inner join sales_order_line sol on sol.order_id=so.id
where so.status in(7)
AND (
    (@type = 'ALL' AND so.type IN ('FR0', 'FR1', 'FR2', 'BULK', 'ADHOC')) -- Check if type is 'ALL'
     OR (@type = 'JIT' AND jit_flag ='true')
    OR(@type = 'BULK' AND jit_flag = 'false' AND so.type = 'BULK')
    OR(@type ='NORMAL' AND jit_flag ='false' AND so.type = 'FR1')
    OR so.type = @type -- Otherwise, filter by the provided type
)
AND (
    (@priority ='ALL' AND sol.priority IN ('0', '1', '2', '10', '11', '100')) -- Check if type is 'ALL'
    OR sol.priority = @priority -- Otherwise, filter by the provided type
)
AND so.order_picked_timestamp between DATEADD(MINUTE,DATEDIFF(MINUTE, GETUTCDATE(),GETDATE()),$__timeFrom()) AND DATEADD(MINUTE,DATEDIFF(MINUTE, GETUTCDATE(),GETDATE()),$__timeTo());
`;

const SQL_BULK_ITEMS_PICKED = `use lenskart_wes
DECLARE @type VARCHAR(100) ='BULK'
DECLARE @priority VARCHAR(100) ='ALL';

select count (sol.order_id) as itemsPicked from sales_order_line sol
inner join sales_order so on so.id =sol.order_id
where
 (
    (@type = 'ALL' AND so.type IN ('FR0', 'FR1', 'FR2', 'BULK', 'ADHOC')) -- Check if type is 'ALL'
    OR (@type = 'JIT' AND jit_flag ='true')
    OR(@type = 'BULK' AND jit_flag = 'false' AND so.type = 'BULK')
    OR(@type ='NORMAL' AND jit_flag ='false' AND so.type = 'FR1')
    OR(@type ='FR0' AND jit_flag ='false' AND so.type = 'FR0')
    OR so.type = @type -- Otherwise, filter by the provided type
)
AND (
    (@priority ='ALL' AND sol.priority IN ('0', '1', '2', '10', '11', '100')) -- Check if type is 'ALL'
    OR sol.priority = @priority -- Otherwise, filter by the provided type
)
AND (sol.status=7 or sol.status=4 ) AND sol.item_picked_timestamp between DATEADD(MINUTE,DATEDIFF(MINUTE, GETUTCDATE(),GETDATE()),$__timeFrom()) AND DATEADD(MINUTE,DATEDIFF(MINUTE, GETUTCDATE(),GETDATE()),$__timeTo());`;

const DATASOURCE_UID = "rerQ11pVk";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 1;

const SHIFT_KEYS = ["A", "B", "C"];
const HOURS_PER_SHIFT = 8;

const validHourArray = (arr) => Array.isArray(arr) && arr.length === HOURS_PER_SHIFT && arr.every((w) => w && typeof w.from === "number" && typeof w.to === "number");

// params.hourWindows: {A:[8x{from,to}], B, C}, Hour 1 first (shiftWindows.hourWindowsForDate)
function makeBuildPayload(capabilityName, sql) {
  return function buildPayload(grafanaOrigin, params) {
    const hourWindows = (params && params.hourWindows) || {};
    for (const key of SHIFT_KEYS) {
      if (!validHourArray(hourWindows[key])) throw new Error(`${capabilityName} requires hourWindows.${key} as an array of ${HOURS_PER_SHIFT} {from,to} windows`);
    }
    return { grafanaOrigin, datasourceUid: DATASOURCE_UID, datasourceType: DATASOURCE_TYPE, datasourceId: DATASOURCE_ID, sql, hourWindows };
  };
}

// result.hours.{A,B,C} -> 8 finite numbers each, Hour 1 first
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

module.exports = {
  fr0: { buildPayload: makeBuildPayload("GET_GRAFANA_ASRS_PRODUCTION_FR0", SQL_FR0_COMPLETED_ORDERS), validateResult, field: "completedOrders" },
  bulkItems: { buildPayload: makeBuildPayload("GET_GRAFANA_ASRS_PRODUCTION_BULK_ITEMS", SQL_BULK_ITEMS_PICKED), validateResult, field: "itemsPicked" },
  SHIFT_KEYS,
  HOURS_PER_SHIFT,
};
