// Query definition for GET_GRAFANA_TOTE_PARTITION_COUNTS - the Grafana leg
// of the CNG Inv Validator's three-way reconciliation (see
// server/features/cng-validator/cngValidator.js). Ported from the legacy extension's own CNG
// validator (background/cng-validator.js): a plain per-partition-container
// row count from `lenskart_wes.dbo.tote_details`, batched across the
// caller's tote list via a backend-built `container LIKE '<base>-%'`
// OR-clause - same datasource (uid "rerQ11pVk", type "mssql", id 1) as
// GET_GRAFANA_LOCKED_TOTES/GET_GRAFANA_CC_METRICS, same
// buildPayload-owns-the-SQL invariant as every other Grafana capability
// (the runtime never receives anything but this backend's own already-built
// query strings - no raw SQL passthrough from the frontend, ever).
//
// Unlike SQL_CC_DISCREPANCY, this query has no `$__timeFilter()` - it's a
// point-in-time count, not a time-windowed one - but Grafana's /api/ds/query
// request body still requires a `range`, so a fixed, generous window is
// sent anyway (ignored by the query itself, exactly like every other
// capability that must supply one).

const { TOTE_ID_REGEX } = require("../quadron/pullQuadronTote");

const DATASOURCE_UID = "rerQ11pVk";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 1;
const DEFAULT_CHUNK_SIZE = 40; // matches the legacy extension's own default grafanaChunk

function buildToteLikeClause(bases) {
  return bases.map((b) => `container like '${b}-%'`).join(" or ");
}

function buildChunkSql(bases) {
  return `use lenskart_wes\n\nselect container, count(*) as qty from tote_details where ${buildToteLikeClause(bases)} group by container`;
}

// totes: string[] of BASE tote IDs (no "-N" partition suffix) - validated
// against the exact same TOTE_ID_REGEX every other capability uses, never
// trusted as pre-sanitized just because it looks like a tote ID.
function buildPayload(grafanaOrigin, params) {
  const { totes, chunkSize } = params || {};
  if (!Array.isArray(totes) || totes.length === 0) {
    throw new Error("GET_GRAFANA_TOTE_PARTITION_COUNTS requires a non-empty totes array");
  }
  const invalid = totes.filter((t) => typeof t !== "string" || !TOTE_ID_REGEX.test(t));
  if (invalid.length) {
    throw new Error(`GET_GRAFANA_TOTE_PARTITION_COUNTS: invalid tote id(s): ${invalid.join(", ")}`);
  }

  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : DEFAULT_CHUNK_SIZE;
  const now = Date.now();
  const queries = [];
  for (let i = 0; i < totes.length; i += size) {
    queries.push({ sql: buildChunkSql(totes.slice(i, i + size)), fromMs: now - 6 * 3600000, toMs: now });
  }

  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    queries,
  };
}

function validateResult(result) {
  if (!result || !Array.isArray(result.rows)) return { ok: false, reason: "result.rows must be an array" };
  const allowedKeys = new Set(["container", "qty"]);
  for (const row of result.rows) {
    if (!row || typeof row.container !== "string" || !row.container) {
      return { ok: false, reason: "each row must have a non-empty string container" };
    }
    if (typeof row.qty !== "number") {
      return { ok: false, reason: "each row must have a numeric qty" };
    }
    for (const key of Object.keys(row)) {
      if (!allowedKeys.has(key)) return { ok: false, reason: `unexpected field in row: ${key}` };
    }
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult, DEFAULT_CHUNK_SIZE };
