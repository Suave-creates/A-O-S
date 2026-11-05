// Query definition for GET_GRAFANA_CONTAINER_TRACKING - Outside Tote
// Analysis's Auto Mode discovery query ("Tote Criticality Dashboard", panel
// 8). Captured directly from a real, working Grafana panel request/response
// (operator-supplied curl + response), same as grafanaAisleOccupancy.js's own
// provenance. Unlike every other Tracker capability, this one takes NO tote
// list - it queries every tote in lenskart_wes.dbo.tote_details in one shot,
// which is exactly what Auto Mode's discovery step needs (find which totes
// are Location='OUT' system-wide, without already knowing their IDs).
//
// Same datasource as GET_GRAFANA_TOTE_FINDER/GET_GRAFANA_TRACKER_HISTORY (uid
// "rerQ11pVk", type "mssql", id 1).
//
// Two deliberate, logic-preserving edits vs. the captured SQL:
//   1. The captured SQL declares `@containerId` and filters
//      `WHERE (@containerId IS NULL OR @containerId = '' OR ct.tote_id =
//      @containerId)`. Every real dispatch of this panel leaves that
//      variable as '' (no filter) - dropping the variable/predicate entirely
//      changes nothing and always returns every tote, which is what
//      discovery needs.
//   2. The captured SQL's final SELECT aliases columns as bracketed,
//      Title-Case names (`[Container]`, `[Shuttle Health Status ]` - note
//      the trailing space in the real response, `[Stock Check Blocked]`,
//      etc.). The runtime's frameRowsByName() keys each row object off of
//      whatever the SQL aliases as, so those are renamed here to clean
//      lowerCamelCase (container/tracker/location/zone/shuttle/
//      shuttleHealthStatus/stockCheckBlocked/binBlocked/badTracker) -
//      matching every other capability's own row-field convention (see
//      grafanaToteFinder.js). Every CTE/JOIN/CASE expression otherwise
//      matches the captured SQL character-for-character.

const DATASOURCE_UID = "rerQ11pVk";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 1;
const WINDOW_MS = 7 * 24 * 3600000; // nominal only - the SQL has no time filter, but the ds/query request contract always requires a range

const SQL = `WITH ContainerTracker AS (
	SELECT  container_data.*
	FROM
		(SELECT ct.*,
		ROW_NUMBER() over (PARTITION BY ct.container ORDER BY ct.updated_timestamp DESC) AS rn
		FROM lenskart_quadron.dbo.container_tracker ct) container_data
	WHERE container_data.rn=1
),
LatestContainerTrackerWithInfo AS (
SELECT
    ct.container,
    ct.tracker,
    lt.location,
    lt.updated_timestamp,
    e.entity,
    e.type,
    lz.[zone],
    s.id AS shuttle,
    s.health_status,
    pc.lock_status
FROM
	ContainerTracker ct
    LEFT JOIN lenskart_quadron.dbo.location_tracker lt 	ON ct.tracker = lt.tracker
	LEFT JOIN lenskart_quadron.dbo.entity e ON e.entity = lt.location
	LEFT JOIN lenskart_quadron.dbo.location_zone lz  ON lz.location = lt.location
	LEFT JOIN lenskart_quadron.dbo.shuttle s ON s.[zone] = lz.[zone]
	LEFT JOIN lenskart_quadron.dbo.product_container pc  ON pc.id = ct.container
),
LatestContainerTracker AS (
	SELECT
		t.tote_id,
        ct.tracker,
        ct.location,
        ct.updated_timestamp,
        ct.type,
        ct.[zone],
        ct.shuttle,
        ct.health_status,
        ct.lock_status
	FROM
		 (
            SELECT DISTINCT SUBSTRING(container, 1, 12) AS tote_id
            FROM lenskart_wes.dbo.tote_details
        ) t
		LEFT JOIN LatestContainerTrackerWithInfo ct
		ON t.tote_id=ct.container
),
BinBlocked AS (
    SELECT
        bb.tracker,
        bb.status,
        ROW_NUMBER() OVER (PARTITION BY bb.tracker ORDER BY bb.updated_timestamp DESC) AS rn
    FROM lenskart_quadron.dbo.bin_blocked bb
)
SELECT
    ct.tote_id AS container,
    ct.tracker AS tracker,
    CASE
        WHEN ct.location IS NULL OR ( ct.location IS NOT NULL AND ct.location NOT LIKE '0%') THEN 'OUT'
        ELSE ct.location
    END AS location,
    ct.zone AS zone,
    ct.shuttle AS shuttle,
    CASE
        WHEN ct.health_status=0 THEN 'ERROR'
        WHEN ct.health_status=1 THEN 'HEALTHY'
        WHEN ct.health_status=2 THEN 'ACKNOWLEDGEMENT_AWAITING'
    END AS shuttleHealthStatus,
    CASE
        WHEN ct.lock_status = 1 THEN 'YES'
        WHEN ct.lock_status = 0 OR ct.lock_status IS NULL THEN 'NO'
    END AS stockCheckBlocked,
    CASE
        WHEN bb.status = 0 THEN 'YES'
        WHEN bb.status = 1 OR bb.status IS NULL THEN 'NO'
    END AS binBlocked,
    CASE
        WHEN ct.type=11 THEN 'YES'
        ELSE 'NO'
    END AS badTracker
FROM
    LatestContainerTracker ct
    LEFT JOIN BinBlocked bb
    ON ct.tracker = bb.tracker AND bb.rn =1;`;

function buildPayload(grafanaOrigin) {
  const now = Date.now();
  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    sql: SQL,
    fromMs: now - WINDOW_MS,
    toMs: now,
  };
}

const ALLOWED_KEYS = new Set([
  "container",
  "tracker",
  "location",
  "zone",
  "shuttle",
  "shuttleHealthStatus",
  "stockCheckBlocked",
  "binBlocked",
  "badTracker",
]);

function validateResult(result) {
  if (!result || !Array.isArray(result.rows)) return { ok: false, reason: "result.rows must be an array" };
  for (const row of result.rows) {
    if (!row || typeof row.container !== "string" || !row.container) {
      return { ok: false, reason: "each row must have a non-empty string container" };
    }
    for (const key of Object.keys(row)) {
      if (!ALLOWED_KEYS.has(key)) return { ok: false, reason: `unexpected field in row: ${key}` };
    }
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult };
