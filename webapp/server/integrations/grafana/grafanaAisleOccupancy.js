// Query definition for the GET_GRAFANA_AISLE_OCCUPANCY capability
// (Dashboard's Aisle Occupancy section - Aisle Occupancy / Large / Short
// rows). Both SQL strings were captured directly from a real, working
// Grafana panel request/response (operator-supplied curl + response, not
// re-derived from the legacy extension) - copied character-for-character.
//
// Same Grafana datasource as CC Metrics/Tote Freed (uid "rerQ11pVk" / type
// mssql / id 1). Unlike those, this is a LIVE snapshot query with no
// $__timeFrom()/$__timeTo()/time filter at all - the SQL itself ignores the
// query's time range entirely (confirmed: neither query references
// $__time*), so buildPayload takes no required params, just a nominal
// range for the Grafana ds/query request contract (which always requires
// one, even when the SQL ignores it).
//
// Two queries, ONE capability/Query Manager row - same "one section, one
// dispatch" convention as GET_GRAFANA_CC_METRICS.

const SQL_AISLE_OCCUPANCY = `use lenskart_quadron;

WITH TotalTotes AS (
    SELECT aisle, COUNT(DISTINCT container_tracker.container) AS total_tote_count
    FROM container_tracker
    INNER JOIN location_tracker ON location_tracker.tracker = container_tracker.tracker
    INNER JOIN bin ON location_tracker.location = bin.id
    INNER JOIN aisle_zone ON aisle_zone.zone = bin.zone
    INNER JOIN product_container ON product_container.id = container_tracker.container
    WHERE product_container.status = 0
    GROUP BY aisle
),
SKUStats AS (
    SELECT aisle, COUNT(DISTINCT sku) AS sku_count,
           COUNT(DISTINCT container_tracker.container) AS tote_count,
           SUM(quantity) AS total_units
    FROM container_tracker
    INNER JOIN location_tracker ON location_tracker.tracker = container_tracker.tracker
    INNER JOIN bin ON location_tracker.location = bin.id
    INNER JOIN aisle_zone ON aisle_zone.zone = bin.zone
    INNER JOIN product_container ON product_container.id = container_tracker.container
    INNER JOIN product_material ON product_material.container = product_container.id
    WHERE product_container.status = 0 AND product_material.status = 0
    GROUP BY aisle
),
OccupiedLocations AS (
    SELECT aisle, COUNT(DISTINCT location) AS occupied_location_count
    FROM location_tracker
    INNER JOIN bin ON location_tracker.location = bin.id
    INNER JOIN aisle_zone ON aisle_zone.zone = bin.zone
    GROUP BY aisle
)
SELECT X.aisle,
       CASE
           WHEN X.aisle IN (001, 002, 003, 004) THEN (Z.occupied_location_count / 8588.0) * 100
           WHEN X.aisle IN (005,006) THEN (Z.occupied_location_count / 10848.0) * 100
       END AS value
FROM TotalTotes X
LEFT JOIN SKUStats Y ON X.aisle = Y.aisle
INNER JOIN OccupiedLocations Z ON Y.aisle = Z.aisle
ORDER BY X.aisle;`;

const SQL_AISLE_OCCUPANCY_LS = `use lenskart_quadron;
SELECT A.aisle, A.category,(occupied_location_count/total_count*1.0)*100 as occupancy FROM
((SELECT aisle_zone.aisle,cat.category,
COUNT(DISTINCT location) as occupied_location_count
FROM location_tracker
INNER JOIN bin
ON location_tracker.location = bin.id
INNER JOIN lane_zone
ON lane_zone.zone = bin.zone
inner join aisle_zone on aisle_zone.zone = bin.zone
inner join (select zone,bc.category from buffer_category bc inner join bin on bin.id  = bc.buffer
group by bin.zone,bc.category)cat on cat.zone = bin.zone
GROUP BY aisle_zone.aisle ,cat.category)A
LEFT JOIN
(SELECT aisle_zone.aisle ,cat.category,
COUNT(bin.id)*1.0 as total_count
FROM  bin
inner join entity on entity.entity = bin.id and entity.[type] = 8
inner join aisle_zone on aisle_zone.zone = bin.zone
inner join (select zone,bc.category from buffer_category bc inner join bin on bin.id  = bc.buffer
group by bin.zone,bc.category )cat on cat.zone = bin.zone
GROUP BY aisle_zone.aisle ,cat.category)B on A.aisle = B.aisle and  A.category = B.category)`;

const DATASOURCE_UID = "rerQ11pVk";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 1;

function buildPayload(grafanaOrigin) {
  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    occupancySql: SQL_AISLE_OCCUPANCY,
    longShortSql: SQL_AISLE_OCCUPANCY_LS,
  };
}

const AISLE_NUMS = new Set(["001", "002", "003", "004", "005", "006"]);
const CATEGORIES = new Set(["TALL", "SHORT"]);

function validateResult(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "result must be an object" };
  if (!Array.isArray(result.occupancy)) return { ok: false, reason: "result.occupancy must be an array" };
  for (const r of result.occupancy) {
    if (!r || typeof r !== "object" || !AISLE_NUMS.has(r.aisle)) return { ok: false, reason: `occupancy entry has an unexpected aisle: ${r && r.aisle}` };
    if (r.value != null && typeof r.value !== "number") return { ok: false, reason: `occupancy entry for aisle ${r.aisle} has a non-numeric value` };
  }
  if (!Array.isArray(result.longShort)) return { ok: false, reason: "result.longShort must be an array" };
  for (const r of result.longShort) {
    if (!r || typeof r !== "object" || !AISLE_NUMS.has(r.aisle)) return { ok: false, reason: `longShort entry has an unexpected aisle: ${r && r.aisle}` };
    if (!CATEGORIES.has(r.category)) return { ok: false, reason: `longShort entry for aisle ${r.aisle} has an unexpected category: ${r.category}` };
    if (r.occupancy != null && typeof r.occupancy !== "number") return { ok: false, reason: `longShort entry for aisle ${r.aisle}/${r.category} has a non-numeric occupancy` };
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult, AISLE_NUMS: [...AISLE_NUMS] };
