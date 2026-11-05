// Query definition for GET_GRAFANA_PICKING_STATIONS (the Picking Monitor): items picked per GTP picking station
// (GS...) in one or more time windows. The SQL is the WES dashboard's "Items picked by station" panel
// (generic-dashboard-for-wes-stats-update, panel 4) with its type and priority variables kept as they are -
// same datasource ("rerQ11pVk" / 1), same status rule (item line status 7 or 4), same time column
// (sol.item_picked_timestamp), same Grafana-MSSQL local-time shift.
//
// Type and priority are the dashboard's own variable values. They are checked against a fixed list and only
// then written into the SQL text, so nothing a browser sends can reach the query unchecked.

const DATASOURCE_UID = "rerQ11pVk";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 1;

const TYPES = ["ALL", "FR0", "FR1", "FR2", "JIT", "ADHOC", "BULK", "NORMAL"];
const PRIORITIES = ["ALL", "0", "1", "2", "10", "11", "100"];
const MAX_WINDOWS = 40;

function buildSql(type, priority) {
  return `use lenskart_wes
DECLARE @type VARCHAR(100) = '${type}';
DECLARE @priority VARCHAR(100) ='${priority}';

select sc.station_id, count(so.order_id) as Items_Picked from sales_order_line sol
inner join sales_order so on so.id = sol.order_id
inner JOIN lenskart_gtp.dbo.cluster c ON c.order_id = sol.order_id
INNER JOIN lenskart_gtp.dbo.sub_cluster sc ON sc.cluster_id = c.id
where (sol.status=7 or sol.status=4)
AND (
    (@type = 'ALL')
     OR (@type = 'JIT' AND jit_flag ='true')
     OR(@type ='NORMAL' AND jit_flag ='false' AND so.type = 'FR1')
     OR(@type ='BULK' AND jit_flag ='false' AND so.type = 'BULK')
    OR so.type = @type
)
AND (
    (@priority ='ALL')
    OR sol.priority = @priority
)
AND sol.item_picked_timestamp
between DATEADD(MINUTE,DATEDIFF(MINUTE, GETUTCDATE(),GETDATE()),$__timeFrom()) AND DATEADD(MINUTE,DATEDIFF(MINUTE, GETUTCDATE(),GETDATE()),$__timeTo())
group by sc.station_id
order by sc.station_id;`;
}

// params: { type, priority, windows: [{ key, from, to, skip? }] }. A window with skip:true is not queried (a
// future hour, or one the caller already holds) and comes back as null - never an invented empty list.
function buildPayload(grafanaOrigin, params) {
  const { type, priority, windows } = params || {};
  if (!TYPES.includes(type)) throw new Error(`GET_GRAFANA_PICKING_STATIONS: unknown type "${type}"`);
  if (!PRIORITIES.includes(priority)) throw new Error(`GET_GRAFANA_PICKING_STATIONS: unknown priority "${priority}"`);
  if (!Array.isArray(windows) || windows.length === 0 || windows.length > MAX_WINDOWS) {
    throw new Error(`GET_GRAFANA_PICKING_STATIONS requires 1-${MAX_WINDOWS} windows`);
  }
  const seen = new Set();
  for (const w of windows) {
    if (!w || typeof w.key !== "string" || !/^[A-Za-z0-9_]{1,24}$/.test(w.key) || seen.has(w.key)) throw new Error("GET_GRAFANA_PICKING_STATIONS: each window needs a unique simple key");
    if (typeof w.from !== "number" || typeof w.to !== "number" || !(w.to > w.from)) throw new Error(`GET_GRAFANA_PICKING_STATIONS: bad window ${w.key}`);
    seen.add(w.key);
  }
  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    sql: buildSql(type, priority),
    windows: windows.map((w) => ({ key: w.key, from: w.from, to: w.to, skip: !!w.skip })),
  };
}

// result.windows.<key> -> null (skipped) or [{ station: string, items: finite number >= 0 }]
function validateResult(result) {
  if (!result || typeof result !== "object" || !result.windows || typeof result.windows !== "object") {
    return { ok: false, reason: "result.windows must be an object keyed by window" };
  }
  for (const [key, list] of Object.entries(result.windows)) {
    if (list === null) continue;
    if (!Array.isArray(list) || !list.every((r) => r && typeof r.station === "string" && typeof r.items === "number" && Number.isFinite(r.items) && r.items >= 0)) {
      return { ok: false, reason: `result.windows.${key} must be null or a list of { station, items }` };
    }
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult, buildSql, TYPES, PRIORITIES, MAX_WINDOWS };
