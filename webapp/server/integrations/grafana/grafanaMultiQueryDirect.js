// Server-side execution of the Grafana capabilities that fan out into several
// MSSQL queries per request (CC metrics, per-shift and per-hour scalars, aisle
// occupancy, tote partition counts). Each one is a port of the matching
// executor that used to live in the ASO Browser Runtime
// (runtime/background/capabilities.js) - same SQL (built by each capability's
// own buildPayload), same field mapping, same concurrency - with the session
// now coming from grafanaAuth.js's shared login via grafanaQueryDirect.js.
//
// Every function follows the uniform directExecute(appUserId, payload, signal)
// contract; appUserId is unused (the login is one shared account).

const grafanaQueryDirect = require("./grafanaQueryDirect");

const SHIFT_KEYS = ["A", "B", "C"];
const HOUR_QUERY_CONCURRENCY = 8; // 24 hourly COUNT queries, never all at once against the same MSSQL backend

function rows(payload, sql, fromMs, toMs, signal, deps) {
  const { grafanaOrigin, datasourceUid, datasourceType, datasourceId } = payload;
  return grafanaQueryDirect.runQueryRows({ grafanaOrigin, datasourceUid, datasourceType, datasourceId, rawSql: sql, fromMs, toMs }, signal, deps);
}

function requireWindow(w, label) {
  if (!w || typeof w.from !== "number" || typeof w.to !== "number") throw new Error(`Missing/invalid ${label}`);
  return w;
}

async function ccWindowRows(payload, w, signal, deps) {
  const { discrepancySql, stockCheckSql } = payload;
  const [discRaw, stockRaw] = await Promise.all([
    rows(payload, discrepancySql, w.from, w.to, signal, deps),
    rows(payload, stockCheckSql, w.from, w.to, signal, deps),
  ]);
  const discRows = discRaw.map((r) => ({
    station: r.station, operationType: r.operation_type, user: r.user,
    container: r.container, eventType: r.type, discrepancyType: r.discrepancy_type,
    createTime: r.create_time,
  }));
  const stockRows = stockRaw.map((r) => ({
    sku: r.sku, storer: r.storer, quantity: r.quantity, resultType: r.type,
    station: r.station, user: r.user, container: r.container, createTime: r.create_time,
  }));
  return { discRows, stockRows };
}

async function executeCcMetrics(appUserId, payload, signal, deps = {}) {
  const { windows, hourWindows } = payload || {};
  if (hourWindows) {
    // hourly mode (live day cache): each hour not skipped -> its rows; a skipped hour -> null
    const tasks = [];
    for (const key of SHIFT_KEYS) (hourWindows[key] || []).forEach((w, i) => tasks.push({ key, i, w: requireWindow(w, `hourWindows.${key}[${i}]`) }));
    const hours = { A: new Array(8).fill(null), B: new Array(8).fill(null), C: new Array(8).fill(null) };
    const todo = tasks.filter((t) => !t.w.skip);
    let next = 0;
    async function worker() {
      while (next < todo.length) {
        const t = todo[next++];
        hours[t.key][t.i] = await ccWindowRows(payload, t.w, signal, deps);
      }
    }
    await Promise.all(Array.from({ length: Math.min(HOUR_QUERY_CONCURRENCY / 2, todo.length) }, worker)); // 2 queries per hour
    return { hours, fetchedAt: new Date().toISOString() };
  }
  const entries = await Promise.all(
    SHIFT_KEYS.map(async (key) => [key, await ccWindowRows(payload, requireWindow(windows && windows[key], `windows.${key}`), signal, deps)])
  );
  return { windows: Object.fromEntries(entries), fetchedAt: new Date().toISOString() };
}

// One query, one scalar, per shift - the SQL already SUMs/COUNTs server-side. A skipped shift (live day cache:
// frozen or not started) is not queried and comes back null.
async function scalarPerShift(payload, signal, deps, scalarField) {
  const { sql, windows } = payload || {};
  const entries = await Promise.all(
    SHIFT_KEYS.map(async (key) => {
      const w = requireWindow(windows && windows[key], `windows.${key}`);
      if (w.skip) return [key, null];
      const r = await rows(payload, sql, w.from, w.to, signal, deps);
      return [key, Number(r[0] && r[0][scalarField]) || 0];
    })
  );
  return { windows: Object.fromEntries(entries), fetchedAt: new Date().toISOString() };
}

// One query per HOUR (3 shifts x 8 hours), run through a small worker pool.
async function scalarPerHour(payload, signal, deps, scalarField) {
  const { sql, hourWindows } = payload || {};
  const tasks = [];
  for (const key of SHIFT_KEYS) {
    const windows = hourWindows && hourWindows[key];
    if (!Array.isArray(windows) || windows.length !== 8) throw new Error(`Missing/invalid hourWindows.${key}`);
    windows.forEach((w, hourIdx) => {
      requireWindow(w, `hourWindows.${key}[${hourIdx}]`);
      tasks.push({ shiftKey: key, hourIdx, w, skip: !!w.skip });
    });
  }

  const values = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      const { w, skip } = tasks[i];
      if (skip) { values[i] = null; continue; } // not queried (future/cached hour) - null, never a fake 0
      const r = await rows(payload, sql, w.from, w.to, signal, deps);
      values[i] = Number(r[0] && r[0][scalarField]) || 0;
    }
  }
  await Promise.all(Array.from({ length: Math.min(HOUR_QUERY_CONCURRENCY, tasks.length) }, worker));

  const hours = { A: [], B: [], C: [] };
  tasks.forEach((t, i) => { hours[t.shiftKey][t.hourIdx] = values[i]; });
  return { hours, fetchedAt: new Date().toISOString() };
}

// Items picked per picking station for each requested window (the Picking Monitor). One grouped query per
// window that is not skipped, through a small worker pool; a skipped window is null, never an empty list.
async function executePickingStations(appUserId, payload, signal, deps = {}) {
  const { sql, windows } = payload || {};
  if (!Array.isArray(windows)) throw new Error("Rejected: windows must be an array");
  const out = {};
  let next = 0;
  async function worker() {
    while (next < windows.length) {
      const w = windows[next++];
      requireWindow(w, `windows.${w && w.key}`);
      if (w.skip) { out[w.key] = null; continue; }
      const raw = await rows(payload, sql, w.from, w.to, signal, deps);
      out[w.key] = raw.map((r) => ({ station: r.station_id == null ? "UNASSIGNED" : String(r.station_id), items: Number(r.Items_Picked) || 0 }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(HOUR_QUERY_CONCURRENCY, windows.length) }, worker));
  return { windows: out, fetchedAt: new Date().toISOString() };
}

// The order pipeline counts (the Picking Monitor strip): one scalar query per metric, run through the same small
// worker pool. One failing query is that metric's null plus a reason - it must not blank the other eleven - but
// if every query fails the whole call fails, so a dead source never looks like a pipeline of nulls.
async function executeOrderPipeline(appUserId, payload, signal, deps = {}) {
  const { queries, window: w } = payload || {};
  if (!Array.isArray(queries) || queries.length === 0) throw new Error("Rejected: queries must be a non-empty array");
  requireWindow(w, "window");
  const metrics = {};
  const errors = {};
  let next = 0;
  async function worker() {
    while (next < queries.length) {
      const q = queries[next++];
      try {
        const raw = await rows(payload, q.sql, w.from, w.to, signal, deps);
        const n = Number(raw[0] && raw[0][q.field]);
        metrics[q.key] = Number.isFinite(n) ? n : 0;
      } catch (e) {
        if (e && (e.name === "AbortError" || e.name === "TimeoutError")) throw e; // a cancel or timeout is the caller's decision
        metrics[q.key] = null;
        errors[q.key] = String((e && e.message) || e).slice(0, 160);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(HOUR_QUERY_CONCURRENCY, queries.length) }, worker));
  if (Object.values(metrics).every((v) => v === null)) throw new Error(`Order pipeline unavailable: ${Object.values(errors)[0] || "no query answered"}`);
  return { metrics, errors, fetchedAt: new Date().toISOString() };
}

const executeCompactionCount = (appUserId, payload, signal, deps = {}) => scalarPerShift(payload, signal, deps, "total_compactions");
const executeTotesFreedCount = (appUserId, payload, signal, deps = {}) => scalarPerShift(payload, signal, deps, "Totes_freed_updated_value");
// Hourly scalars (+ optionally when the source table last recorded an event; the
// value is the table's own IST wall-clock labelled as UTC, converted by the caller).
async function hourlyWithLastEvent(payload, signal, deps, scalarField) {
  const out = await scalarPerHour(payload, signal, deps, scalarField);
  if (payload.withLastEvent) {
    const now = Date.now();
    const r = await rows(payload, payload.lastEventSql, now - 3600000, now, signal, deps);
    const v = r[0] && r[0].last_event;
    out.lastEvent = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}
const executeCompactionHourly = (appUserId, payload, signal, deps = {}) => hourlyWithLastEvent(payload, signal, deps, "total_compactions");
const executeTotesFreedHourly = (appUserId, payload, signal, deps = {}) => hourlyWithLastEvent(payload, signal, deps, "Totes_freed_updated_value");
const executeAsrsProductionNjit = (appUserId, payload, signal, deps = {}) => scalarPerHour(payload, signal, deps, "completedOrders");
const executeAsrsProductionJit = (appUserId, payload, signal, deps = {}) => scalarPerHour(payload, signal, deps, "CompletedOrders");
const executeAsrsProductionFr0 = (appUserId, payload, signal, deps = {}) => scalarPerHour(payload, signal, deps, "completedOrders");
const executeAsrsProductionBulkItems = (appUserId, payload, signal, deps = {}) => scalarPerHour(payload, signal, deps, "itemsPicked");

// Neither SQL string references the time range, but Grafana's ds/query
// contract always requires one - hence the nominal 15-minute window.
async function executeAisleOccupancy(appUserId, payload, signal, deps = {}) {
  const { occupancySql, longShortSql } = payload || {};
  const now = Date.now();
  const [occRaw, lsRaw] = await Promise.all([
    rows(payload, occupancySql, now - 15 * 60000, now, signal, deps),
    rows(payload, longShortSql, now - 15 * 60000, now, signal, deps),
  ]);
  const occupancy = occRaw.map((r) => ({ aisle: String(r.aisle), value: r.value == null ? null : Number(r.value) }));
  const longShort = lsRaw.map((r) => ({ aisle: String(r.aisle), category: String(r.category || "").toUpperCase(), occupancy: r.occupancy == null ? null : Number(r.occupancy) }));
  return { occupancy, longShort, fetchedAt: new Date().toISOString() };
}

// Items still queued and PTL slots occupied per station (a live snapshot; the time range is only nominal).
async function executePtlQueue(appUserId, payload, signal, deps = {}) {
  const now = Date.now();
  const raw = await rows(payload, payload.sql, now - 15 * 60000, now, signal, deps);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const stations = raw.filter((r) => r.station).map((r) => ({
    station: String(r.station).trim(), queuedItems: num(r.remaining_quantity), queuedLines: num(r.remaining_lines),
    queuedSkus: num(r.remaining_skus), slots: num(r.occupied_slots),
  }));
  return { stations, fetchedAt: new Date().toISOString() };
}

async function executeTotePartitionCounts(appUserId, payload, signal, deps = {}) {
  const { queries } = payload || {};
  if (!Array.isArray(queries) || queries.length === 0) throw new Error("Rejected: queries must be a non-empty array");
  const chunkResults = await Promise.all(queries.map((q) => rows(payload, q.sql, q.fromMs, q.toMs, signal, deps)));
  const out = [];
  for (const chunk of chunkResults) {
    for (const r of chunk) {
      if (r && typeof r.container === "string" && r.container) out.push({ container: r.container, qty: Number(r.qty) || 0 });
    }
  }
  return { rows: out, fetchedAt: new Date().toISOString() };
}

module.exports = {
  executeCcMetrics,
  executeCompactionCount,
  executeTotesFreedCount,
  executePickingStations,
  executeOrderPipeline,
  executeAsrsProductionNjit,
  executeAsrsProductionJit,
  executeAsrsProductionFr0,
  executeAsrsProductionBulkItems,
  executeCompactionHourly,
  executeTotesFreedHourly,
  executeAisleOccupancy,
  executePtlQueue,
  executeTotePartitionCounts,
};
