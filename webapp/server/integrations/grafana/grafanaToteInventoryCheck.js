// Query definition for GET_GRAFANA_TOTE_INVENTORY_CHECK - Bulk Inventory
// Check's own discovery query (2026-10-01, operator-supplied curl + real
// response, captured directly from the "Tote Level Inventory" Grafana
// dashboard, panel 2, izMX9Ks4z). Given a bulk list of base tote IDs,
// returns every per-partition barcode/SKU row for each one in ONE request -
// not one Grafana dispatch per tote, matching grafanaToteFinder.js's own
// "backend builds one SQL covering every requested tote" convention.
//
// Captured SQL (single tote):
//   use lenskart_wes
//   select * from tote_details where container like 'TL0000025362-%'
// `tote_details.container` always carries a partition suffix
// ("TL0000025362-1", "-2", ...) - there is no row for the bare base id -
// so a bulk lookup ORs one `LIKE 'BASE-%'` clause per requested tote
// (quoted-string injection is not a concern: every tote has ALREADY been
// validated against TOTE_ID_REGEX - digits and A-Z only - before it's ever
// interpolated into the SQL string, same discipline as grafanaToteFinder.js's
// own sqlStrIn()).
//
// Same datasource as every other Grafana capability in this app (uid
// "rerQ11pVk", type "mssql", id 1).

const { TOTE_ID_REGEX } = require("../quadron/pullQuadronTote");

const DATASOURCE_UID = "rerQ11pVk";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 1;
const WINDOW_MS = 6 * 3600000; // nominal only - tote_details has no time filter, but the ds/query request contract always requires a range (matches the real captured request's own 6h window)

// A generous but real ceiling - protects MSSQL from a single pathologically
// large OR'd-LIKE WHERE clause if someone pastes an enormous list, never
// silently truncated (see buildPayload's own loud rejection below).
const MAX_TOTES = 1000;

function buildSql(totes) {
  const clauses = totes.map((t) => `container like '${t}-%'`).join(" OR ");
  return `use lenskart_wes\n\nselect * from tote_details where (${clauses})`;
}

function buildPayload(grafanaOrigin, params) {
  const { totes } = params || {};
  if (!Array.isArray(totes) || totes.length === 0) {
    throw new Error("GET_GRAFANA_TOTE_INVENTORY_CHECK requires a non-empty totes array");
  }
  if (totes.length > MAX_TOTES) {
    throw new Error(`GET_GRAFANA_TOTE_INVENTORY_CHECK: ${totes.length} totes exceeds the ${MAX_TOTES} limit per request - split into smaller batches`);
  }
  const invalid = totes.filter((t) => typeof t !== "string" || !TOTE_ID_REGEX.test(t));
  if (invalid.length) {
    throw new Error(`GET_GRAFANA_TOTE_INVENTORY_CHECK: invalid tote id(s): ${invalid.join(", ")}`);
  }
  const now = Date.now();
  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    sql: buildSql(totes),
    fromMs: now - WINDOW_MS,
    toMs: now,
  };
}

const ALLOWED_KEYS = new Set(["id", "container", "partition", "sku", "serialId", "create_time"]);

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

module.exports = { buildPayload, validateResult, buildSql, MAX_TOTES };
