// Hourly variants of two Dashboard scalars - Compaction and Totes Freed - for
// the Dashboard's detail popups ("since 06:00 IST, hour by hour"). The SQL is
// the SAME text the shift-level capabilities use (grafanaCompactionCount.js /
// grafanaTotesFreedCount.js) - only the time window changes, one Grafana
// query per hour (run through the shared bounded pool, see
// grafanaQueryDirect.js). Shift totals on the tiles still come from the
// shift-level capabilities, so the numbers operators already trust don't move.
//
// `hourWindows` = {A:[8],B:[8],C:[8]} of {from,to,skip?}. A window with
// `skip: true` is not queried (a future hour, or one the caller already has
// cached) and comes back as null - never a fabricated 0.

const compaction = require("./grafanaCompactionCount");
const totesFreed = require("./grafanaTotesFreedCount");

const SHIFT_KEYS = ["A", "B", "C"];
const HOURS_PER_SHIFT = 8;
// Both metrics are derived from this one table.
const LAST_EVENT_SQL = "SELECT MAX(create_time) AS last_event FROM lenskart_gtp.dbo.compaction_transaction_history";

function validHourArray(arr) {
  return Array.isArray(arr) && arr.length === HOURS_PER_SHIFT && arr.every((w) => w && typeof w.from === "number" && typeof w.to === "number");
}

function hourlyPayload(base, name, grafanaOrigin, params) {
  const hourWindows = (params && params.hourWindows) || {};
  for (const key of SHIFT_KEYS) {
    if (!validHourArray(hourWindows[key])) {
      throw new Error(`${name} requires hourWindows.${key} as an array of ${HOURS_PER_SHIFT} {from,to} windows`);
    }
  }
  // Reuse the shift-level capability's own datasource + SQL verbatim.
  const dummy = { A: { from: 0, to: 1 }, B: { from: 0, to: 1 }, C: { from: 0, to: 1 } };
  const { grafanaOrigin: origin, windows, ...query } = base.buildPayload(grafanaOrigin, { windows: dummy });
  // withLastEvent: also report when the underlying table last recorded anything, so
  // a genuine zero day can say "last event 05:54" instead of showing an empty chart.
  return { grafanaOrigin: origin, ...query, hourWindows, withLastEvent: !!(params && params.withLastEvent), lastEventSql: LAST_EVENT_SQL };
}

function validateHourly(result) {
  if (!result || typeof result !== "object" || !result.hours || typeof result.hours !== "object") {
    return { ok: false, reason: "result.hours must be an object keyed by shift" };
  }
  for (const key of SHIFT_KEYS) {
    const arr = result.hours[key];
    if (!Array.isArray(arr) || arr.length !== HOURS_PER_SHIFT) return { ok: false, reason: `result.hours.${key} must be an array of ${HOURS_PER_SHIFT}` };
    if (!arr.every((v) => v === null || (typeof v === "number" && Number.isFinite(v)))) return { ok: false, reason: `result.hours.${key} must hold finite numbers or null` };
  }
  if (result.lastEvent != null && !Number.isFinite(result.lastEvent)) return { ok: false, reason: "result.lastEvent must be a finite number or null" };
  return { ok: true };
}

module.exports = {
  buildCompactionPayload: (origin, params) => hourlyPayload(compaction, "GET_GRAFANA_COMPACTION_HOURLY", origin, params),
  buildTotesFreedPayload: (origin, params) => hourlyPayload(totesFreed, "GET_GRAFANA_TOTES_FREED_HOURLY", origin, params),
  validateHourly,
  SHIFT_KEYS,
};
