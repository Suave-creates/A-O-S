// The Dashboard's live topics. The Dashboard shows TODAY's site day (06:00 IST
// -> 06:00) live; the One Pager Report shows any date from the SAME data layer
// (features/dashboard/dashboardMetrics.js). Tiles are fed by the `dashboard.*`
// topics; clicking a tile opens a popup fed by `dashboard-detail:<metric>`.
//
// Each source is fetched ONCE per interval no matter how many people watch
// (cached + single-flight here, and single-flight per topic in the hub), always
// through the bounded, retrying Grafana pool and the shared logins. A source
// that fails falls back to its last good value flagged `stale`, so a tile
// never turns into "Data unavailable" because of one bad poll.

const db = require("../platform/db");
const queryManager = require("../platform/queries/queryManager");
const metrics = require("../features/dashboard/dashboardMetrics");
const detail = require("../features/dashboard/dashboardDetail");
const { getAisleOccupancy } = require("../features/dashboard/dashboardEngine");
const { runAuto } = require("../features/tracker/trackerEngine");
const { summarizeOutsideTote } = require("../features/one-pager-report/onePagerReportEngine");
const { getAsrsLocations } = require("../features/asrs-locations/asrsLocationsEngine");
const { levelsForAisle } = require("../features/asrs-locations/asrsLocationModel");
const toteUtilisationJob = require("../features/tote-utilisation/toteUtilisationJob");
const { listRecentResults, runToteUtilisation } = toteUtilisationJob;
const nexsAsrsDumpEngine = require("../features/nexs-asrs-dump/nexsAsrsDumpEngine");
const dumpStore = require("../features/nexs-asrs-dump/nexsAsrsDumpMysqlStore");
const nexsDumpOnRequest = require("./nexsDumpOnRequest");
const classificationEngine = require("../features/locked-tote-info/classificationEngine");
const { getSystemUser } = require("./systemUser");
const { versionGuarded, utilisationVersion } = require("./versionGuard");

const { withLastGood, siteDayIST } = metrics;

// Caps the auto-run uses (the Tote Utilisation screen's own defaults).
const DEFAULT_CAPS = toteUtilisationJob.DEFAULT_CAPS; // one set of tote capacities everywhere
const UTILISATION_COOLDOWN_MS = 10 * 60 * 1000;
// The NexS dump the run reads is refreshed every 6 hours (config.nexsAsrsDumpAutoRefreshMs), so the tile has
// nothing new to show in between. It does not poll for that: it reloads when a dump lands (which also starts
// the run), when any run finishes, on an operator Refresh, and otherwise every 6 hours as a safety net.
const UTILISATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

// TTL cache + single flight + stale-while-revalidate.
//   get({ fresh: true })  - the feeds: wait for a refresh once the TTL has passed.
//   get()                 - the popups: answer at once from the last value (even if
//                           past its TTL) and refresh in the background, so opening a
//                           popup never waits on a Grafana round trip.
// Concurrent refreshes share one in-flight fetch.
function cached(ttlMs, fn) {
  let value;
  let at = 0;
  let inflight = null;
  const refresh = () => {
    if (!inflight) {
      inflight = (async () => {
        try {
          value = await fn();
          at = Date.now();
          return value;
        } finally {
          inflight = null;
        }
      })();
    }
    return inflight;
  };
  // force: an operator pressed Refresh - re-read even inside the TTL.
  return function get({ fresh = false, force = false } = {}) {
    const age = Date.now() - at;
    if (!force && value !== undefined && age < ttlMs) return Promise.resolve(value);
    if (value !== undefined && !fresh) {
      refresh().catch(() => {}); // background; a failure keeps serving the last value
      return Promise.resolve(value);
    }
    return refresh();
  };
}

const omit = (obj, ...keys) => {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
};

async function sysQuery(operation, engineFn) {
  const user = await getSystemUser();
  const query = await queryManager.createQuery({ userId: user.id, operation, parameters: {} });
  return engineFn({ queryId: query.query_id, user });
}

// ── Shared sources (each fetched once per TTL) ───────────────────────────────
// Cadences (how often the SERVER re-reads Grafana, whatever the number of viewers) are
// matched to how fast each number moves and how heavy its query is:
//   CC Done / Stations / Discrepancies  2 min   Compaction + Tote Freed  5 min (rare, heaviest SQL)
//   Aisle Occupancy                     2 min   Outside Totes          10 min (~40 s read)
// Each cache TTL is a bit under its feed interval so a scheduled poll always re-reads.
const CC_INTERVAL_MS = 2 * 60 * 1000;
// While every open tab is in the background the upstream-reading tiles refresh this slowly (the data is shared
// and cached, so everyone sees the same snapshot until a visible tab or a Refresh moves it). dashboard.cc is left
// out on purpose: the alert timer reads the same cached CC data every 2 minutes anyway, so polling it is free.
// The Dashboard header note quotes this number.
const BACKGROUND_INTERVAL_MS = 30 * 60 * 1000;
const COMPACTION_INTERVAL_MS = 5 * 60 * 1000;
const AISLE_INTERVAL_MS = 2 * 60 * 1000;
const OUTSIDE_INTERVAL_MS = 10 * 60 * 1000;

const ccDay = cached(CC_INTERVAL_MS - 15 * 1000, async () => {
  const site = siteDayIST();
  const user = await getSystemUser();
  return withLastGood(`dash:cc:${site}`, () => metrics.runCcMetricsForDate(user, site, queryManager, undefined, { withRows: true }));
});

const compactionDay = cached(COMPACTION_INTERVAL_MS - 15 * 1000, async () => {
  const site = siteDayIST();
  const user = await getSystemUser();
  return withLastGood(`dash:compaction:${site}`, () => metrics.runCompactionForDate(user, site, queryManager));
});

const aisleGrafana = cached(AISLE_INTERVAL_MS - 15 * 1000, () => withLastGood("dash:aisle", () => sysQuery("DASHBOARD_AISLE_OCCUPANCY", getAisleOccupancy)));

const outsideDay = cached(OUTSIDE_INTERVAL_MS - 30 * 1000, () =>
  withLastGood("dash:outside", async () => {
    // counting only: skipNexs means this never needs a NexS login
    const result = await sysQuery("TRACKER_RUN_AUTO", ({ queryId, user }) => runAuto({ queryId, user, skipNexs: true }));
    return summarizeOutsideTote(result.rows);
  })
);

// The container-tracking model is a heavy read: one shared copy for the ASRS
// Location Audit screen AND the Aisle Occupancy screen.
const auditModel = cached(5 * 60 * 1000, () => withLastGood("dash:audit", () => sysQuery("ASRS_LOCATIONS_CURRENT", getAsrsLocations)));

// ── Tote Utilisation: runs by itself whenever the NexS dump is newer ─────────
let utilisationRunning = null;
let utilisationLastTry = 0;

// force: a new dump just landed, or an operator pressed Refresh - skip the retry cooldown. Either way it only
// runs when the dump is newer than the latest result, so the same data is never computed twice.
async function ensureFreshUtilisation(user, { force = false } = {}) {
  if (utilisationRunning) return utilisationRunning;
  if (!force && Date.now() - utilisationLastTry < UTILISATION_COOLDOWN_MS) return null;
  const meta = await dumpStore.getCurrentMeta();
  if (!meta || !meta.completed_at) return null; // no dump yet - nothing to compute from
  const rows = await db.query("SELECT MAX(created_at) AS newest FROM tote_utilisation_results");
  const newest = rows[0] && rows[0].newest;
  if (newest && String(newest) >= String(meta.completed_at)) return null; // already computed from this dump
  utilisationLastTry = Date.now();
  utilisationRunning = (async () => {
    try {
      const q = await queryManager.createQuery({ userId: user.id, operation: "TOTE_UTILISATION", parameters: { caps: DEFAULT_CAPS } });
      await runToteUtilisation(q.query_id, DEFAULT_CAPS); // persists its own COMPLETED/FAILED
    } finally {
      utilisationRunning = null;
    }
  })();
  return utilisationRunning;
}

// The tiles need the latest run only (its detail lives on the Tote Utilisation screen).
const readLatest = versionGuarded(utilisationVersion, () => listRecentResults({ limit: 1 }));

const utilisationState = cached(20 * 1000, async () => {
  const user = await getSystemUser();
  await ensureFreshUtilisation(user);
  const latest = (await readLatest({ user }))[0] || null;
  return detail.utilisationEnvelope({ metric: "utilisation", title: "Tote Utilisation", siteDay: siteDayIST(), latest, generatedAt: new Date().toISOString() });
});

// ── Detail (popup) builders ────────────────────────────────────────────────
const TITLES = {
  compaction: "Compaction", toteFreed: "Tote Freed", ccDone: "CC Done",
  discrepancies: "Discrepancies Marked", outside: "Outside Totes", locked: "Locked Totes",
};

async function buildDetail(key) {
  const site = siteDayIST();
  const now = Date.now();
  const user = await getSystemUser();
  const hours = metrics.dayHours(site, now);
  const generatedAt = new Date().toISOString();
  const title = TITLES[key];

  if (key === "compaction" || key === "toteFreed") {
    const isCompaction = key === "compaction";
    const [day, hourly] = await Promise.all([
      compactionDay(),
      metrics.hourlyScalar({ user, dateStr: site, capabilityName: isCompaction ? "GET_GRAFANA_COMPACTION_HOURLY" : "GET_GRAFANA_TOTES_FREED_HOURLY", memoKind: key, now, withLastEvent: true }),
    ]);
    return {
      ...detail.hourlyEnvelope({ metric: key, title, unit: isCompaction ? "compaction events" : "totes freed", siteDay: site, hours, values: hourly.map((h) => h.value), shifts: day.shifts[isCompaction ? "compaction" : "toteFreed"], generatedAt, lastEvent: hourly.lastEvent }),
      ...(day.stale ? { stale: true, staleReason: day.staleReason } : {}),
    };
  }

  if (key === "locked") {
    const snaps = await classificationEngine.listSnapshotSummaries(new Date(hours[0].from).toISOString());
    return detail.lockedHourly(snaps, hours, key, title, generatedAt);
  }

  if (key === "ccDone" || key === "discrepancies") {
    const full = await ccDay();
    const cc = detail.ccHourly(full.rows, hours, now, full.purgeMarks);
    const stale = full.stale ? { stale: true, staleReason: full.staleReason } : {};
    const stationCols = [["station", "Station"], ["running", "Now"], ["totes", "Totes checked"], ["checks", "Lines"], ["shortQty", "Qty short"], ["discrepancies", "Discrepancies"], ["users", "Users"], ["last", "Last (IST)"]];
    const stationRows = cc.stationRows.map((r) => ({ ...r, running: r.running ? "● running" : "" }));
    if (key === "ccDone") {
      // CC Done (true) + the Bermuda split + the stations that ran / are running - one popup.
      return {
        ...detail.hourlyEnvelope({
          metric: key, title, unit: "totes (proper cycle counts)", siteDay: site, hours, values: cc.ccDone, shifts: full.shifts.ccDone, generatedAt,
          sections: [{ title: "Stations", columns: stationCols, rows: stationRows }],
          extras: {
            bermuda: { shifts: full.shifts.bermudaTotes, hours: cc.bermuda, total: cc.bermudaTotal, rows: cc.bermudaRows, shortQty: full.shifts.bermudaShortQty, inMultiple: cc.multiShift.bermudaInMultiple },
            multiShift: cc.multiShift,
            done: { total: cc.doneTotal, rows: cc.doneRows, wrongReports: cc.wrongReports },
            purged: { shifts: full.shifts.purgedTotes, hours: cc.purged, total: cc.purgedTotal, rows: cc.purgedRows, shortQty: full.shifts.purgedShortQty },
            shortQty: { shifts: full.shifts.shortQty, hours: cc.shortQty },
            checked: full.shifts.ccChecked,
            stations: { ran: { ...full.shifts.ccStationsRan, Day: cc.stationsRanToday }, runningNow: cc.stationsRunningNow, runningWindowMin: detail.RUNNING_WINDOW_MS / 60000 },
          },
        }),
        ...stale,
      };
    }
    return {
      ...detail.hourlyEnvelope({
        metric: key, title, unit: "discrepancies", siteDay: site, hours, values: cc.discrepancies, shifts: full.shifts.discrepancies, generatedAt,
        sections: [
          { title: "Latest discrepancies (SHORT)", columns: [["time", "Time (IST)"], ["station", "Station"], ["user", "User"], ["container", "Tote"], ["event", "Event"]], rows: cc.discrepancyRows },
          { title: "Stations", columns: stationCols.filter(([k]) => k !== "running"), rows: cc.stationRows },
        ],
      }),
      ...stale,
    };
  }

  if (key === "outside") {
    const out = await outsideDay();
    return { kind: "state", metric: key, title, siteDay: site, since: "06:00 IST", generatedAt, counts: { h12to24: out.h12to24, h24plus: out.h24plus, total: out.total }, lists: { h12to24: out.totes.h12to24, h24plus: out.totes.h24plus }, ...(out.stale ? { stale: true, staleReason: out.staleReason } : {}) };
  }

  throw new Error(`Unknown dashboard detail: ${key}`);
}

const detailCache = new Map();
function detailFor(key) {
  if (!TITLES[key]) return Promise.reject(new Error(`Unknown dashboard detail: ${key}`));
  let get = detailCache.get(key);
  if (!get) {
    get = cached(25 * 1000, () => buildDetail(key));
    detailCache.set(key, get);
  }
  return get();
}

// ── Aisle Occupancy screen: the live Grafana occupancy (same read as the tile) + the Location Audit breakdown ──
// A missing audit model is shown as "not available", never as zeros.
async function aisleOccupancyView({ manual = false } = {}) {
  const [grafana, model] = await Promise.all([aisleGrafana({ fresh: true, force: manual }), auditModel().catch(() => null)]);
  return {
    grafana: omit(grafana, "generatedAt"),
    audit: model ? detail.aisleAuditSummary(model, levelsForAisle) : null,
    auditAt: model ? model.generatedAt : null,
  };
}

// ── Registration ───────────────────────────────────────────────────────────
function registerDashboardFeeds(hub) {
  // Tiles. Payloads carry no timestamps of their own (the hub's `at`/`checkedAt`
  // is the freshness), so an unchanged poll is recognised as unchanged.
  hub.registerFeed({ topic: "dashboard.compaction", backgroundIntervalMs: BACKGROUND_INTERVAL_MS, minRefreshMs: 30 * 1000, intervalMs: COMPACTION_INTERVAL_MS, fetch: async ({ manual }) => omit(await compactionDay({ fresh: true, force: manual }), "generatedAt", "dateStr") });
  hub.registerFeed({ topic: "dashboard.cc", minRefreshMs: 30 * 1000, intervalMs: CC_INTERVAL_MS, fetch: async ({ manual }) => {
      const full = await ccDay({ fresh: true, force: manual });
      // Stations that logged a stock check in the last 10 minutes ("running now"); everything else is shift totals.
      const cc = detail.ccHourly(full.rows, metrics.dayHours(full.dateStr || siteDayIST()), Date.now());
      return { ...omit(full, "generatedAt", "dateStr", "rows"), stationsNow: cc.stationsRunningNow, stationsRanToday: cc.stationsRanToday, multiShift: cc.multiShift.total, bermudaDistinct: cc.bermudaTotal };
    } });
  hub.registerFeed({ topic: "dashboard.aisle", backgroundIntervalMs: BACKGROUND_INTERVAL_MS, minRefreshMs: 30 * 1000, intervalMs: AISLE_INTERVAL_MS, fetch: async ({ manual }) => omit(await aisleGrafana({ fresh: true, force: manual }), "generatedAt") });
  hub.registerFeed({ topic: "dashboard.outside", backgroundIntervalMs: BACKGROUND_INTERVAL_MS, minRefreshMs: 30 * 1000, intervalMs: OUTSIDE_INTERVAL_MS, fetch: async ({ manual }) => omit(await outsideDay({ fresh: true, force: manual }), "totes") });
  hub.registerFeed({ topic: "dashboard.utilisation", intervalMs: UTILISATION_INTERVAL_MS, fetch: async ({ manual }) => {
      if (manual) {
        nexsDumpOnRequest.dumpIfOld(); // a new NexS dump when the last is over 6 h old; its completion re-runs utilisation
        await ensureFreshUtilisation(await getSystemUser(), { force: true });
      }
      return omit(await utilisationState({ fresh: true, force: manual }), "generatedAt");
    } });
  // A new dump starts the run; a finished run (this one, or "Run now" on the screen) reloads the tiles.
  nexsAsrsDumpEngine.onCompleted(async () => ensureFreshUtilisation(await getSystemUser(), { force: true }));
  toteUtilisationJob.onCompleted(() => hub.refresh("dashboard.utilisation"));

  // Aisle Occupancy screen (Monitor) - the Dashboard's Aisle Occupancy tile opens it.
  hub.registerFeed({ topic: "aisle-occupancy.current", backgroundIntervalMs: BACKGROUND_INTERVAL_MS, minRefreshMs: 30 * 1000, intervalMs: AISLE_INTERVAL_MS, fetch: ({ manual }) => aisleOccupancyView({ manual }) });

  // ASRS Location Audit screen (shares the Aisle Occupancy screen's container-tracking read).
  hub.registerFeed({ topic: "asrs-locations.current", backgroundIntervalMs: BACKGROUND_INTERVAL_MS, intervalMs: 5 * 60 * 1000, fetch: () => auditModel({ fresh: true }) });

  // Popups: one instance per user + metric, all sharing the cached builders above.
  hub.registerFeed({ topic: "dashboard-detail", scope: "key", backgroundIntervalMs: BACKGROUND_INTERVAL_MS, intervalMs: 15 * 1000, fetch: ({ key }) => detailFor(key) });
}

// Today's raw stock-check rows and discrepancy (verification) events, all shifts, from the shared cached CC
// read - what the Alerts module evaluates its rules against (no extra Grafana load).
async function currentCcRows() {
  const full = await ccDay({ fresh: true }); // alerting must never judge on a stale cache
  const w = (full && full.rows) || {};
  const all = (key) => ["A", "B", "C"].flatMap((k) => (w[k] && w[k][key]) || []);
  return { stockRows: all("stockRows"), discRows: all("discRows"), purgeMarks: (full && full.purgeMarks) || {} };
}

module.exports = { registerDashboardFeeds, buildDetail, currentCcRows, TITLES };
