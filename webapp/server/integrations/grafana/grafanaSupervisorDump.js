// Query definition for the GET_GRAFANA_SUPERVISOR_DUMP capability
// (Classification). Mirrors grafanaLockedTotes.js exactly - the backend
// owns SQL + datasource, the runtime only ever executes whatever payload
// this module builds, against its own independently verified Grafana
// origin allow-list.
//
// SQL_SUPERVISOR and the datasource identifiers (uid "A83AuthVz", type
// "mssql", id 2) are copied character-for-character from
// background/index.js:45 and :230-233 (SQL_SUPERVISOR,
// fetchSupervisorTotesGrafana) - not rewritten, not optimized, not changed
// in business logic.
//
// The column [13]/[15] extraction (which rows are LOCKED, where the tote
// id is actually embedded) is response-shaping, not classification - it
// lives in the runtime (runtime/background/capabilities.js), the same
// place GET_GRAFANA_LOCKED_TOTES's own frame-parsing already lives. This
// capability only ever reports which tote ids Supervisor Dump currently
// shows as LOCKED; SD/P0/P1/P2 priority is assigned later, by
// server/features/locked-tote-info/classification.js, from the combination of this result with
// GET_GRAFANA_LOCKED_TOTES and GET_QUADRON_INVENTORY.

const SQL_SUPERVISOR = `SELECT DISTINCT LEFT(d.station,5) AS "StationID",d.station AS "Slot",so.id as "Fitting ID",s.[type],CASE WHEN d.minutes_elapsed BETWEEN 1 AND 59 THEN '0-1 hours' WHEN d.minutes_elapsed BETWEEN 60 AND 119 THEN '1-2 hours' WHEN d.minutes_elapsed BETWEEN 120 AND 179 THEN '2-3 hours' WHEN d.minutes_elapsed BETWEEN 180 AND 239 THEN '3-4 hours' ELSE '>4 hours' END AS TimeCategory,so.wave,so.order_id,sol.priority,d.minutes_elapsed,d.sku,d.tote,d.scanner,d.scan_time,d.[singleBin/doubleBin/containerStatus/shuttleHealth/networkStatus],d.[QueueTote/source/minutesElapsed],d.[Inventory/Borrower],d.quantity_left FROM master.dbo.supervisor_dashboard d INNER JOIN lenskart_gtp.dbo.station s ON s.id=LEFT(d.station,5) INNER JOIN lenskart_wes.dbo.sales_order so ON so.id=d.order_id INNER JOIN lenskart_wes.dbo.sales_order_line sol ON sol.order_id=so.id AND sol.sku=d.sku where d.quantity_left>0`;

const DATASOURCE_UID = "A83AuthVz";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 2;

// Same 1-hour window as the existing fetchSupervisorTotesGrafana().
function buildPayload(grafanaOrigin) {
  const now = Date.now();
  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    rawSql: SQL_SUPERVISOR,
    fromMs: now - 3600000,
    toMs: now,
  };
}

// Sanity-checks the shape the runtime claims to have normalized to - never
// trusts it blindly. Decision (per Classification design): exactly
// { rows:[{toteId}] }, nothing else - the runtime's own column [13]/[15]
// extraction has already reduced Supervisor Dump down to "which tote ids
// are currently LOCKED", so no other field is expected or allowed here.
function validateResult(result) {
  if (!result || !Array.isArray(result.rows)) return { ok: false, reason: "result.rows must be an array" };
  for (const row of result.rows) {
    if (!row || typeof row.toteId !== "string" || !row.toteId) {
      return { ok: false, reason: "each row must have a non-empty string toteId" };
    }
    const allowedKeys = new Set(["toteId"]);
    for (const key of Object.keys(row)) {
      if (!allowedKeys.has(key)) return { ok: false, reason: `unexpected field in row: ${key}` };
    }
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult };
