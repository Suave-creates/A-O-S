// Query definition for the GET_GRAFANA_LOCKED_TOTES capability. The backend
// owns this definition (SQL + datasource) - the runtime only ever executes
// whatever payload this module builds, against its own independently
// verified Grafana origin allow-list. This is NOT a general Grafana query
// mechanism - there is exactly one capability, one SQL string, one
// datasource, copied verbatim from the existing implementation.
//
// SQL_LOCKED and the datasource identifiers (uid "rerQ11pVk", type "mssql",
// id 1) are copied character-for-character from background/index.js:37-43
// and :221-228 (SQL_LOCKED, fetchLockedTotesGrafana) - not rewritten,
// not optimized, not changed in business logic. The same datasource is also
// used (confirmed) by CC_DS_UID/TYPE/ID and TR_DS_UID/TYPE/ID elsewhere in
// that file.

const SQL_LOCKED = `DECLARE @containerId AS VARCHAR(20) = '';
WITH ContainerTracker AS (SELECT container_data.* FROM (SELECT ct.*,ROW_NUMBER() over (PARTITION BY ct.container ORDER BY ct.updated_timestamp DESC) AS rn FROM lenskart_quadron.dbo.container_tracker ct) container_data WHERE container_data.rn=1),
LatestContainerTrackerWithInfo AS (SELECT ct.container,ct.tracker,lt.location,lt.updated_timestamp,e.entity,e.type,lz.[zone],s.id AS shuttle,s.health_status,pc.lock_status FROM ContainerTracker ct LEFT JOIN lenskart_quadron.dbo.location_tracker lt ON ct.tracker=lt.tracker LEFT JOIN lenskart_quadron.dbo.entity e ON e.entity=lt.location LEFT JOIN lenskart_quadron.dbo.location_zone lz ON lz.location=lt.location LEFT JOIN lenskart_quadron.dbo.shuttle s ON s.[zone]=lz.[zone] LEFT JOIN lenskart_quadron.dbo.product_container pc ON pc.id=ct.container),
LatestContainerTracker AS (SELECT t.tote_id,ct.tracker,ct.location,ct.updated_timestamp,ct.type,ct.[zone],ct.shuttle,ct.health_status,ct.lock_status FROM (SELECT DISTINCT SUBSTRING(container,1,12) AS tote_id FROM lenskart_wes.dbo.tote_details) t LEFT JOIN LatestContainerTrackerWithInfo ct ON t.tote_id=ct.container),
BinBlocked AS (SELECT bb.tracker,bb.status,ROW_NUMBER() OVER (PARTITION BY bb.tracker ORDER BY bb.updated_timestamp DESC) AS rn FROM lenskart_quadron.dbo.bin_blocked bb),
FinalContainerTracker AS (SELECT ct.tote_id AS [Container],ct.tracker AS [Tracker],CASE WHEN ct.location IS NULL OR(ct.location IS NOT NULL AND ct.location NOT LIKE '0%') THEN 'OUT' ELSE ct.location END AS [Location],ct.zone AS [Zone],ct.shuttle AS [Shuttle],CASE WHEN ct.health_status=0 THEN 'ERROR' WHEN ct.health_status=1 THEN 'HEALTHY' WHEN ct.health_status=2 THEN 'ACKNOWLEDGEMENT_AWAITING' END AS [Shuttle Health Status],CASE WHEN ct.lock_status=1 THEN 'YES' WHEN ct.lock_status=0 OR ct.lock_status IS NULL THEN 'NO' END AS [Stock_Check_Blocked],CASE WHEN bb.status=0 THEN 'YES' WHEN bb.status=1 OR bb.status IS NULL THEN 'NO' END AS [Bin Blocked],CASE WHEN ct.type=11 THEN 'YES' ELSE 'NO' END AS [Bad Tracker] FROM LatestContainerTracker ct LEFT JOIN BinBlocked bb ON ct.tracker=bb.tracker AND bb.rn=1)
SELECT Container,Tracker,Location,Zone,Shuttle FROM FinalContainerTracker WHERE Stock_Check_Blocked='Yes' AND(@containerId IS NULL OR @containerId='' OR Container=@containerId)`;

const DATASOURCE_UID = "rerQ11pVk";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 1;

// Same 6-hour window as the existing fetchLockedTotesGrafana().
function buildPayload(grafanaOrigin) {
  const now = Date.now();
  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    rawSql: SQL_LOCKED,
    fromMs: now - 6 * 3600000,
    toMs: now,
  };
}

// Sanity-checks the shape the runtime claims to have normalized to - never
// trusts it blindly. The runtime does the actual Grafana-response parsing;
// this only confirms the result it sent back looks like what this
// capability is supposed to produce (decision 1: exactly the 5 approved
// fields, nothing invented, nothing silently dropped).
function validateResult(result) {
  if (!result || !Array.isArray(result.rows)) return { ok: false, reason: "result.rows must be an array" };
  for (const row of result.rows) {
    if (!row || typeof row.toteId !== "string" || !row.toteId) {
      return { ok: false, reason: "each row must have a non-empty string toteId" };
    }
    const allowedKeys = new Set(["toteId", "tracker", "location", "zone", "shuttle"]);
    for (const key of Object.keys(row)) {
      if (!allowedKeys.has(key)) return { ok: false, reason: `unexpected field in row: ${key}` };
    }
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult };
