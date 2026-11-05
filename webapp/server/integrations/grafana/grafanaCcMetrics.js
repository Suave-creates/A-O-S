// Query definition for the GET_GRAFANA_CC_METRICS capability (Dashboard's
// CC Done / Discrepancies Marked / Station Coverage sections). Mirrors
// grafanaLockedTotes.js/grafanaSupervisorDump.js exactly: the backend owns
// the SQL + datasource definition, the runtime only ever executes whatever
// payload this module builds, against its own independently verified
// Grafana origin allow-list.
//
// SQL_CC_DISCREPANCY and SQL_CC_STOCKCHECK are copied character-for-character
// from background/index.js:558-580 (SQL_CC_DISCREPANCY, SQL_CC_STOCKCHECK) -
// not rewritten, not optimized, not changed in business logic. Same
// datasource (uid "rerQ11pVk", type "mssql", id 1) as every other Grafana
// capability in this registry - confirmed shared by CC_DS_UID/TYPE/ID in
// that file.
//
// Unlike the single-window Locked Totes/Supervisor Dump capabilities, this
// one takes caller-supplied `windows` (the A/B/C shift boundaries the
// Dashboard route computes via shiftWindows.js) so ONE capability call runs
// all 3 shifts x 2 queries = 6 Grafana DS queries, never 6 separate
// Query Manager rows for what is conceptually a single Dashboard section.

const SQL_CC_DISCREPANCY = `use lenskart_gtp
SELECT * from verification_events ve where $__timeFilter((ve.create_time AT TIME ZONE 'India Standard Time'))`;

const SQL_CC_STOCKCHECK = `USE lenskart_gtp

SELECT
    scm.sku,
    scm.storer,
    scm.quantity,
    scm.type,
    sch.station,
    sch.[user],
    sch.container,
    CONVERT(VARCHAR(23), sch.create_time, 121) AS create_time
FROM
    stock_check_material_history scm
RIGHT JOIN
    stock_check_tote_history sch
    ON scm.reference = sch.id
WHERE
    sch.create_time >= CAST(DATEADD(HOUR, 5, DATEADD(MINUTE, 30, $__timeFrom())) AS datetime)
    AND sch.create_time < CAST(DATEADD(HOUR, 5, DATEADD(MINUTE, 30, $__timeTo())) AS datetime)
ORDER BY sch.create_time DESC;`;

const DATASOURCE_UID = "rerQ11pVk";
const DATASOURCE_TYPE = "mssql";
const DATASOURCE_ID = 1;

const SHIFT_KEYS = ["A", "B", "C"];

// buildPayload(grafanaOrigin, params) - params.windows: {A:{from,to}, B:{...}, C:{...}}
// (fromMs/toMs, as produced by shiftWindows.js). Required - unlike the two
// zero-arg read capabilities, this one has no meaningful default window.
// Or params.hourWindows: {A:[8x{from,to,skip?}], B, C} - the live day cache's hourly mode
// (integrations/grafana/grafanaDayCache.js): a skipped hour is not queried and comes back null.
function buildPayload(grafanaOrigin, params) {
  if (params && params.hourWindows) {
    for (const key of SHIFT_KEYS) {
      const arr = params.hourWindows[key];
      if (!Array.isArray(arr) || arr.length !== 8 || !arr.every((w) => w && typeof w.from === "number" && typeof w.to === "number")) {
        throw new Error(`GET_GRAFANA_CC_METRICS requires hourWindows.${key} as 8 {from,to} windows`);
      }
    }
    return {
      grafanaOrigin, datasourceUid: DATASOURCE_UID, datasourceType: DATASOURCE_TYPE, datasourceId: DATASOURCE_ID,
      discrepancySql: SQL_CC_DISCREPANCY, stockCheckSql: SQL_CC_STOCKCHECK, hourWindows: params.hourWindows,
    };
  }
  const windows = (params && params.windows) || {};
  for (const key of SHIFT_KEYS) {
    const w = windows[key];
    if (!w || typeof w.from !== "number" || typeof w.to !== "number") {
      throw new Error(`GET_GRAFANA_CC_METRICS requires windows.${key}.{from,to} as numbers`);
    }
  }
  return {
    grafanaOrigin,
    datasourceUid: DATASOURCE_UID,
    datasourceType: DATASOURCE_TYPE,
    datasourceId: DATASOURCE_ID,
    discrepancySql: SQL_CC_DISCREPANCY,
    stockCheckSql: SQL_CC_STOCKCHECK,
    windows,
  };
}

const DISC_ROW_ALLOWED_KEYS = new Set(["station", "operationType", "user", "container", "eventType", "discrepancyType", "createTime"]);
const STOCK_ROW_ALLOWED_KEYS = new Set(["sku", "storer", "quantity", "resultType", "station", "user", "container", "createTime"]);

function validateRows(rows, allowedKeys, label) {
  if (!Array.isArray(rows)) return `${label} must be an array`;
  for (const row of rows) {
    if (!row || typeof row !== "object") return `${label} entry must be an object`;
    for (const key of Object.keys(row)) {
      if (!allowedKeys.has(key)) return `unexpected field in ${label} entry: ${key}`;
    }
  }
  return null;
}

// Sanity-checks the shape the runtime claims to have normalized to - never
// trusts it blindly, same as every other capability's own validateResult().
function validateResult(result) {
  if (result && typeof result === "object" && result.hours && typeof result.hours === "object") {
    for (const key of SHIFT_KEYS) {
      const arr = result.hours[key];
      if (!Array.isArray(arr) || arr.length !== 8) return { ok: false, reason: `result.hours.${key} must be 8 hours` };
      for (let i = 0; i < 8; i++) {
        const h = arr[i];
        if (h === null) continue; // skipped hour
        if (!h || typeof h !== "object") return { ok: false, reason: `result.hours.${key}[${i}] must be an object or null` };
        const discErr = validateRows(h.discRows, DISC_ROW_ALLOWED_KEYS, `hours.${key}[${i}].discRows`);
        if (discErr) return { ok: false, reason: discErr };
        const stockErr = validateRows(h.stockRows, STOCK_ROW_ALLOWED_KEYS, `hours.${key}[${i}].stockRows`);
        if (stockErr) return { ok: false, reason: stockErr };
      }
    }
    return { ok: true };
  }
  if (!result || typeof result !== "object" || !result.windows || typeof result.windows !== "object") {
    return { ok: false, reason: "result.windows must be an object keyed by shift" };
  }
  for (const key of SHIFT_KEYS) {
    const w = result.windows[key];
    if (!w || typeof w !== "object") return { ok: false, reason: `result.windows.${key} must be an object` };
    const discErr = validateRows(w.discRows, DISC_ROW_ALLOWED_KEYS, `windows.${key}.discRows`);
    if (discErr) return { ok: false, reason: discErr };
    const stockErr = validateRows(w.stockRows, STOCK_ROW_ALLOWED_KEYS, `windows.${key}.stockRows`);
    if (stockErr) return { ok: false, reason: stockErr };
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult, SHIFT_KEYS };
