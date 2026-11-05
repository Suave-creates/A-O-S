// Query definition for the GET_GRAFANA_ASRS_PRODUCTION_NJIT capability (One
// Pager Report's ASRS Production section, NJIT/FR1 row). SQL_NJIT_PRODUCTION
// is copied character-for-character from the standalone "ASRS Production
// Report (JIT/NJIT)" Chrome extension (asrs-production-report/report.js,
// DASHBOARDS.NJIT.rawSql) - not rewritten, not optimized, not changed in
// business logic.
//
// Full Hour 1-8 breakdown per shift (2026-09-10, operator-requested exact
// table shape: Department/Shift/Hour1-8/Total, matching that source
// extension's own on-screen report) - one Grafana call PER HOUR, same as
// the source extension's own hour-by-hour design (24 calls/dashboard/site-
// day), NOT the coarser single-shift-window call an earlier pass of this
// capability used.
//
// Same Grafana datasource as GET_GRAFANA_CC_METRICS/GET_GRAFANA_TOTES_FREED_COUNT
// (uid "rerQ11pVk" / datasourceId 1) - confirmed from the extension's own
// DASHBOARDS.NJIT config, not a new/separate GTP instance like Compaction.

const SQL_NJIT_PRODUCTION = `use lenskart_wes
DECLARE @type VARCHAR(100) = 'NORMAL';
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

const DATASOURCE_UID = "rerQ11pVk";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 1;

const SHIFT_KEYS = ["A", "B", "C"];
const HOURS_PER_SHIFT = 8;

function validHourArray(arr) {
  return Array.isArray(arr) && arr.length === HOURS_PER_SHIFT && arr.every((w) => w && typeof w.from === "number" && typeof w.to === "number");
}

// buildPayload(grafanaOrigin, params) - params.hourWindows: {A:[8x{from,to}],
// B:[8x{from,to}], C:[8x{from,to}]}, Hour 1 first - as produced by
// shiftWindows.js's hourWindowsForDate().
function buildPayload(grafanaOrigin, params) {
  const hourWindows = (params && params.hourWindows) || {};
  for (const key of SHIFT_KEYS) {
    if (!validHourArray(hourWindows[key])) {
      throw new Error(`GET_GRAFANA_ASRS_PRODUCTION_NJIT requires hourWindows.${key} as an array of ${HOURS_PER_SHIFT} {from,to} windows`);
    }
  }
  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    sql: SQL_NJIT_PRODUCTION,
    hourWindows,
  };
}

// result.hours.{A,B,C} -> an array of 8 finite numbers each (completed-order
// count for that hour), Hour 1 first.
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
