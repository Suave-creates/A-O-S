// Query definitions for GET_GRAFANA_ORDER_PIPELINE (the Picking Monitor's order pipeline strip): how many orders
// sit at each stage of the flow (synced, created, in progress, allocated, completed). The SQL is the WES dashboard's panel 2 (generic-dashboard-for-wes-stats-update), one
// statement per number, copied with that panel's own type / priority clauses and its own time column - the
// panel is not "tidied", so each figure matches what operators already see there. Same datasource as the other
// WES counts ("rerQ11pVk" / 1).
//
// Four figures are bound to the chosen time window (orders synced / created / in progress / completed in it); Allocated
// describes the pipeline right now and ignores it. `scope` says which.
//
// Type and priority are checked against fixed lists before they are written into the SQL text.

const DATASOURCE_UID = "rerQ11pVk";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 1;

const TYPES = ["ALL", "FR0", "FR1", "FR2", "JIT", "ADHOC", "BULK", "NORMAL"];
const PRIORITIES = ["ALL", "0", "1", "2", "10", "11", "100"];

// The type and priority clauses the panel uses (different queries in it use different ones).
const TYPE_PLAIN = `(@type = 'ALL')
    OR (@type = 'JIT' AND jit_flag ='true')
    OR(@type = 'NORMAL' AND jit_flag ='false' AND so.type ='FR1')
    OR so.type = @type`;
const TYPE_ANY = `(@type = 'ALL')
    OR (@type = 'JIT' AND jit_flag ='true')
    OR(@type = 'BULK' AND jit_flag = 'false' AND so.type = 'BULK')
    OR(@type ='NORMAL' AND jit_flag ='false' AND so.type = 'FR1')
    OR so.type = @type`;
const TYPE_LISTED = `(@type = 'ALL' AND so.type IN ('FR0', 'FR1', 'FR2', 'BULK', 'ADHOC'))
    OR (@type = 'JIT' AND jit_flag ='true')
    OR(@type = 'BULK' AND jit_flag = 'false' AND so.type = 'BULK')
    OR(@type ='NORMAL' AND jit_flag ='false' AND so.type = 'FR1')
    OR so.type = @type`;
const PRIORITY_ANY = `(@priority ='ALL')
    OR sol.priority = @priority`;
const PRIORITY_LISTED = `(@priority ='ALL' AND sol.priority IN ('0', '1', '2', '10', '11', '100'))
    OR sol.priority = @priority`;

const TIME = (column) => `${column} between DATEADD(MINUTE,DATEDIFF(MINUTE, GETUTCDATE(),GETDATE()),$__timeFrom()) AND DATEADD(MINUTE,DATEDIFF(MINUTE, GETUTCDATE(),GETDATE()),$__timeTo())`;
const HEAD = (type, priority) => `use lenskart_wes
DECLARE @type VARCHAR(100) = '${type}';
DECLARE @priority VARCHAR(100) ='${priority}';
`;
const CLUSTER_JOIN = `INNER JOIN lenskart_gtp.dbo.cluster c ON c.order_id = sol.order_id
INNER JOIN lenskart_gtp.dbo.sub_cluster sc ON sc.cluster_id = c.id`;

// key -> { field (the column the number is read from), scope, build(type, priority) -> sql }
const METRICS = [
  { key: "synced", field: "SyncedOrder", scope: "window", build: (t, p) => `${HEAD(t, p)}
SELECT COUNT(DISTINCT sol.fitting_id) AS SyncedOrder FROM sales_order_line sol
inner join sales_order so on so.id =sol.order_id
where sol.status !=6
AND (${TYPE_ANY})
AND (${PRIORITY_ANY})
AND ${TIME("sol.create_time")};` },
  { key: "created", field: "CreatedOrders", scope: "window", build: (t, p) => `${HEAD(t, p)}
SELECT COUNT(DISTINCT so.id) AS CreatedOrders FROM sales_order so
inner join sales_order_line sol on sol.order_id =so.id
where so.status =0 AND so.type !='FR2' AND sol.re_picking_flag ='false'
AND (${TYPE_PLAIN})
AND (${PRIORITY_LISTED})
AND ${TIME("so.order_allocation_timestamp")};` },
  { key: "inProgress", field: "InProgressOrders", scope: "window", build: (t, p) => `${HEAD(t, p)}
SELECT COUNT(DISTINCT so.id) AS InProgressOrders FROM sales_order so
inner join sales_order_line sol on sol.order_id =so.id
${CLUSTER_JOIN}
where so.status in(1) and c.status=0 AND sc.station_id IS null
AND (${TYPE_LISTED})
AND (${PRIORITY_LISTED})
AND ${TIME("so.order_allocation_timestamp")};` },
  { key: "allocated", field: "AllocatedOrders", scope: "now", build: (t, p) => `${HEAD(t, p)}
SELECT COUNT(DISTINCT so.id) AS AllocatedOrders FROM sales_order so
inner join sales_order_line sol on sol.order_id =so.id
${CLUSTER_JOIN}
where so.status in(1) AND sc.station_id IS not null
AND (${TYPE_LISTED})
AND (${PRIORITY_LISTED});` },
  { key: "completed", field: "completedOrders", scope: "window", build: (t, p) => `${HEAD(t, p)}
SELECT DISTINCT COUNT(distinct so.id) AS completedOrders FROM sales_order so
inner join sales_order_line sol on sol.order_id=so.id
where so.status in(7)
AND (${TYPE_LISTED})
AND (${PRIORITY_LISTED})
AND ${TIME("so.order_picked_timestamp")};` },
];
const KEYS = METRICS.map((m) => m.key);

// params: { type, priority, window: { from, to } } (ms). The window is required even for "now" figures
// because Grafana's query contract always carries a time range.
function buildPayload(grafanaOrigin, params) {
  const { type, priority, window: w } = params || {};
  if (!TYPES.includes(type)) throw new Error(`GET_GRAFANA_ORDER_PIPELINE: unknown type "${type}"`);
  if (!PRIORITIES.includes(priority)) throw new Error(`GET_GRAFANA_ORDER_PIPELINE: unknown priority "${priority}"`);
  if (!w || typeof w.from !== "number" || typeof w.to !== "number" || !(w.to > w.from)) throw new Error("GET_GRAFANA_ORDER_PIPELINE requires window {from,to}");
  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    window: { from: w.from, to: w.to },
    queries: METRICS.map((m) => ({ key: m.key, field: m.field, sql: m.build(type, priority) })),
  };
}

// result.metrics.<key> -> a count (>= 0) or null when that one query failed (result.errors.<key> says why).
function validateResult(result) {
  if (!result || typeof result !== "object" || !result.metrics || typeof result.metrics !== "object") {
    return { ok: false, reason: "result.metrics must be an object keyed by metric" };
  }
  for (const key of KEYS) {
    const v = result.metrics[key];
    if (!(v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0))) {
      return { ok: false, reason: `result.metrics.${key} must be a count or null` };
    }
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult, METRICS, KEYS, TYPES, PRIORITIES };
