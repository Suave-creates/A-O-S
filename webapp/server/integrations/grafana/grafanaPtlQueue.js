// Query definition for GET_GRAFANA_PTL_QUEUE: per GTP station, the items still waiting to be picked and the
// PTL slots currently occupied. SQL from the operator's WES "GTP station information" panel 2, with the first
// column aliased (the panel leaves it unnamed). A live snapshot - the SQL ignores the time range.

const SQL = `use lenskart_gtp

SELECT SUBSTRING(location,1,5) AS station, SUM(quantity - fulfilled_quantity) AS remaining_quantity, COUNT(*) AS remaining_lines,
COUNT(DISTINCT sku) AS remaining_skus, COUNT(DISTINCT location) AS occupied_slots, (count(*) * 1.0 / count(distinct sku)) AS Ratio
FROM location_container
INNER JOIN container_subcluster
ON location_container.container = container_subcluster.container
INNER JOIN sub_cluster_line
ON sub_cluster_line.sub_cluster_id = container_subcluster.subcluster
WHERE quantity != fulfilled_quantity
GROUP BY SUBSTRING(location,1,5)
ORDER BY SUBSTRING(location,1,5);`;

function buildPayload(grafanaOrigin) {
  return { grafanaOrigin, datasourceUid: "rerQ11pVk", datasourceType: "mssql", datasourceId: 1, sql: SQL };
}

function validateResult(result) {
  if (!result || !Array.isArray(result.stations)) return { ok: false, reason: "result.stations must be an array" };
  for (const s of result.stations) {
    if (!s || typeof s.station !== "string" || !s.station) return { ok: false, reason: "each row needs a station" };
    for (const k of ["queuedItems", "queuedLines", "queuedSkus", "slots"]) {
      if (!Number.isFinite(s[k]) || s[k] < 0) return { ok: false, reason: `${s.station}.${k} must be a non-negative number` };
    }
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult, SQL };
