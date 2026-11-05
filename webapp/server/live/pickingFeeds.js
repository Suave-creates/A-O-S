// The Picking Monitor's live topic: items picked per GTP station for TODAY's site day (06:00 IST ->), for one
// choice of order type, priority and rolling window. Topic = "picking.monitor:<TYPE>-<PRIORITY>-<MINUTES>",
// e.g. "picking.monitor:NORMAL-ALL-60" (registered in feeds.js like every topic).
//
// Station facts: the GTP station config (type, operation, priority weight, logged in; changes rarely, cached
// minutes) and the PTL queue snapshot (items still queued, slots occupied) are read separately and are optional -
// if either is down the monitor still shows picks and says what is missing. The station filters (station type,
// station priority) are applied on top of the cached order-filter read, so changing them costs no Grafana query.
//
// Source cost, and why it stays small:
//   - one capability call per refresh (GET_GRAFANA_PICKING_STATIONS) carrying every window it needs;
//   - a CLOSED hour never changes, so each is queried once per process and filter choice, then remembered;
//   - the live part is the running hour + the rolling window + the window before it = 3 grouped queries;
//   - the result is cached per filter choice for everybody (the hub runs one feed instance per viewer, the
//     cache makes them share one upstream read), through the same bounded, retrying Grafana pool.
// On a failed poll the last good value is served flagged `stale`; with none yet the feed reports an error and
// the screen says "Data unavailable" - never zero.

const metrics = require("../features/dashboard/dashboardMetrics");
const { buildPickingMonitor } = require("../features/picking-monitor/pickingMonitorEngine");
const { PRIORITY_CLASSES } = require("../features/picking-monitor/stationHealth");
const { buildOrderPipeline } = require("../features/picking-monitor/orderPipeline");
const { TYPES, PRIORITIES } = require("../integrations/grafana/grafanaPickingStations");
const { getSystemUser } = require("./systemUser");

const PICKING_INTERVAL_MS = 2 * 60 * 1000; // matches how fast the numbers move vs the cost of 3 grouped queries
// 12 scalar queries; the counts (orders in a stage) move more slowly than station picks, so a longer pace.
const PIPELINE_INTERVAL_MS = 3 * 60 * 1000;
const BACKGROUND_INTERVAL_MS = 30 * 60 * 1000; // while every open tab is in the background (see liveHub.js)
const WINDOWS_MIN = [15, 30, 60, 120, 240];
const CACHE_IDLE_DROP_MS = 60 * 60 * 1000;

// "NORMAL-ALL-60" or "NORMAL-ALL-60-FR01-PRIORITY" -> { type, priority, windowMin, stationType, stationPriority } or an
// Error. The order filters and the window are fixed lists; the station type is a plain token (the config may add
// types), the station priority a fixed list.
const STATION_TYPE_RE = /^[A-Z0-9_]{1,24}$/;
function parseKey(key) {
  const parts = String(key || "").split("-");
  const [type, priority, minutes, stationType = "ALL", stationPriority = "ALL"] = parts;
  const windowMin = Number(minutes);
  if ((parts.length !== 3 && parts.length !== 5) || !TYPES.includes(type) || !PRIORITIES.includes(priority) || !WINDOWS_MIN.includes(windowMin)
    || (stationType !== "ALL" && !STATION_TYPE_RE.test(stationType)) || !PRIORITY_CLASSES.includes(stationPriority)) {
    throw new Error(`Unknown picking filter "${key}"`);
  }
  return { type, priority, windowMin, stationType, stationPriority };
}

// Closed hours, remembered per day + filter choice.
const hourMemo = new Map();
const hourKey = (site, type, priority, i) => `${site}|${type}|${priority}|${i}`;

async function readPickingInputs({ type, priority, windowMin, now = Date.now(), user, deps = {} }) {
  const site = metrics.siteDayIST(now);
  const who = user || (await getSystemUser());
  const dayHours = metrics.dayHours(site, now);

  const windows = [];
  dayHours.forEach((h, i) => {
    const memo = h.status === "closed" ? hourMemo.has(hourKey(site, type, priority, i)) : false;
    windows.push({ key: `h${i}`, from: h.from, to: h.to, skip: h.status === "future" || memo });
  });
  const span = windowMin * 60 * 1000;
  windows.push({ key: "cur", from: now - span, to: now, skip: false });
  windows.push({ key: "prev", from: now - 2 * span, to: now - span, skip: false });

  const result = await metrics.dispatchAndWait(who, "GET_GRAFANA_PICKING_STATIONS", { type, priority, windows }, deps);
  const got = result.windows || {};

  const hours = dayHours.map((h, i) => {
    let stations = null;
    if (h.status !== "future") {
      const k = hourKey(site, type, priority, i);
      stations = got[`h${i}`] || hourMemo.get(k) || null;
      if (stations && h.status === "closed" && !hourMemo.has(k)) hourMemo.set(k, stations);
    }
    return { shift: h.shift, label: h.label, from: h.from, to: h.to, status: h.status, stations };
  });
  // A needed hour that came back empty-handed is a failed read, not a quiet hour.
  if (hours.some((h) => h.status !== "future" && !h.stations)) throw new Error("The picking source did not return every hour of the day");
  if (!got.cur || !got.prev) throw new Error("The picking source did not return the current window");

  return { siteDay: site, filters: { type, priority }, hours, cur: got.cur, prev: got.prev, windowMin, now };
}

// The picks alone, shaped (no station facts) - what the screen would show without the config.
async function readPicking(args) {
  return buildPickingMonitor(await readPickingInputs(args));
}

// Optional side reads: a failure keeps the previous value for a while, then reports "missing" (null) rather than
// presenting old facts as current.
function softCache(ttlMs, maxAgeMs, read) {
  let value = null; let at = 0; let inflight = null;
  const get = async ({ force = false } = {}) => {
    if (!force && value && Date.now() - at < ttlMs) return value;
    if (!inflight) {
      inflight = read().then((v) => { value = v; at = Date.now(); }).catch(() => {}).finally(() => { inflight = null; });
    }
    await inflight;
    return value && Date.now() - at < maxAgeMs ? value : null;
  };
  get.clear = () => { value = null; at = 0; inflight = null; };
  return get;
}
const configCache = softCache(5 * 60 * 1000, 6 * 3600 * 1000, async () => {
  const r = await metrics.dispatchAndWait(await getSystemUser(), "GET_GTP_STATION_CONFIG", {});
  return r.stations;
});
const ptlCache = softCache(PICKING_INTERVAL_MS - 15 * 1000, 10 * 60 * 1000, async () => {
  const r = await metrics.dispatchAndWait(await getSystemUser(), "GET_GRAFANA_PTL_QUEUE", {});
  return r.stations;
});

// The order pipeline strip: 12 counts for the same filter choice, read in one capability call. The window
// only matters to the counts that are bound to it; the "right now" ones ignore it.
async function readPipeline({ type, priority, windowMin, now = Date.now(), user, deps = {} }) {
  const who = user || (await getSystemUser());
  const window = { from: now - windowMin * 60 * 1000, to: now };
  const result = await metrics.dispatchAndWait(who, "GET_GRAFANA_ORDER_PIPELINE", { type, priority, window }, deps);
  return buildOrderPipeline({ metrics: result.metrics, errors: result.errors, filters: { type, priority }, windowMin });
}

// One shared, single-flight cache entry per filter choice, per kind of read. The hub runs one feed instance per
// viewer; this makes every viewer of the same filter share one upstream read.
function keyedCache(kind, ttlMs, read) {
  const entries = new Map();
  const get = (filter) => {
    const id = `${filter.type}-${filter.priority}-${filter.windowMin}`;
    const t = Date.now();
    for (const [k, e] of entries) if (t - e.lastUsed > CACHE_IDLE_DROP_MS) entries.delete(k);
    let e = entries.get(id);
    if (!e) { e = { value: undefined, at: 0, inflight: null, lastUsed: t }; entries.set(id, e); }
    e.lastUsed = t;
    return async ({ force = false } = {}) => {
      if (!force && e.value !== undefined && Date.now() - e.at < ttlMs) return e.value;
      if (!e.inflight) {
        e.inflight = metrics.withLastGood(`${kind}:${metrics.siteDayIST()}:${id}`, () => read(filter))
          .then((v) => { e.value = v; e.at = Date.now(); return v; })
          .finally(() => { e.inflight = null; });
      }
      return e.inflight;
    };
  };
  get.clear = () => entries.clear();
  return get;
}

// What a station really carried in the window across ALL orders (the capacity colours need that, whatever the
// order filters are). Only needed when an order filter narrows the picks; one grouped query per window length.
const loadCaches = new Map();
function loadCache(windowMin) {
  if (!loadCaches.has(windowMin)) {
    loadCaches.set(windowMin, softCache(PICKING_INTERVAL_MS - 15 * 1000, 10 * 60 * 1000, async () => {
      const now = Date.now();
      const r = await metrics.dispatchAndWait(await getSystemUser(), "GET_GRAFANA_PICKING_STATIONS", { type: "ALL", priority: "ALL", windows: [{ key: "cur", from: now - windowMin * 60 * 1000, to: now, skip: false }] });
      if (!r.windows || !r.windows.cur) throw new Error("no window");
      return r.windows.cur;
    }));
  }
  return loadCaches.get(windowMin);
}

const pickingCache = keyedCache("picking", PICKING_INTERVAL_MS - 15 * 1000, readPickingInputs); // a scheduled poll always re-reads
const pipelineCache = keyedCache("pipeline", PIPELINE_INTERVAL_MS - 15 * 1000, readPipeline);

// What the "picking.monitor" and "picking.pipeline" feeds (registered in feeds.js) call on each poll.
async function fetchPicking({ key, manual } = {}) {
  const f = parseKey(key);
  const narrowed = f.type !== "ALL" || f.priority !== "ALL";
  const [raw, config, ptl, loadCur] = await Promise.all([pickingCache(f)({ force: !!manual }), configCache({ force: !!manual }), ptlCache({ force: !!manual }),
    narrowed ? loadCache(f.windowMin)({ force: !!manual }) : undefined]);
  const out = buildPickingMonitor({ ...raw, config, ptl, loadCur, stationFilter: { stationType: f.stationType, stationPriority: f.stationPriority } });
  if (raw.stale) Object.assign(out, { stale: true, staleReason: raw.staleReason, staleSince: raw.staleSince });
  return out;
}
const fetchPipeline = ({ key, manual } = {}) => pipelineCache(parseKey(key))({ force: !!manual });

module.exports = {
  fetchPicking, fetchPipeline, readPicking, readPickingInputs, readPipeline, parseKey,
  PICKING_INTERVAL_MS, PIPELINE_INTERVAL_MS, BACKGROUND_INTERVAL_MS, WINDOWS_MIN,
  _resetForTests: () => { hourMemo.clear(); pickingCache.clear(); pipelineCache.clear(); configCache.clear(); ptlCache.clear(); loadCaches.clear(); },
};
