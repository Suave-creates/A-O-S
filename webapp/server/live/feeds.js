// The live feeds: what each topic fetches, who may see it, and how often.
// Every feed runs through the app's EXISTING engines and shared service logins
// - there is no per-browser login or per-browser upstream call anywhere (see
// liveHub.js and RULES.md §6).
//
// Adding a live topic = one registerFeed() entry here (+ the screen
// subscribing to it with Live.subscribe(topic, cb) in public/js/core/live.js).
//
// Scopes (see liveHub.js): shared = one fetch for everyone; user = one per
// signed-in user (data that depends on who asks); key = one per user + job id
// (progress of one running job; the fetch enforces ownership and `stopWhen`
// ends polling once the job is terminal).
//
// Cadence guide: our own memory/DB reads >= 2-10 s; upstream (Grafana) reads
// >= 60 s; heavy fan-outs >= 5 min.

const { versionGuarded, utilisationVersion } = require("./versionGuard");
const { registerDashboardFeeds } = require("./dashboardFeeds");
const { registerAlertsFeed } = require("./alertsFeed");
const { fetchPicking, fetchPipeline, PICKING_INTERVAL_MS, PIPELINE_INTERVAL_MS, BACKGROUND_INTERVAL_MS: PICKING_BACKGROUND_MS } = require("./pickingFeeds");
const { registerPurgeVerifier } = require("./purgeVerify");
const queryManager = require("../platform/queries/queryManager");
const auditLog = require("../platform/audit/auditLog");
const { toEntries, OPERATION_ACTIONS } = require("../platform/audit/operationLog");
const { toPublicQuery } = require("../integrations/capabilities/toPublicQuery");
const sharedResults = require("../platform/storage/sharedResults");
const dashboardAutoRefresh = require("./dashboardAutoRefresh");
const { getConnectionStatus } = require("../integrations/logins/connectionStatus");
const classificationEngine = require("../features/locked-tote-info/classificationEngine");
const lockedTotesAuto = require("./lockedTotesAuto");
const nexsDumpOnRequest = require("./nexsDumpOnRequest");
const auditMarks = require("../features/asrs-locations/auditMarks");
const { listRecentResults: listUtilisationResults } = require("../features/tote-utilisation/toteUtilisationJob");
const purgeEngine = require("../features/tote-purge/purgeEngine");
const onePagerReportEngine = require("../features/one-pager-report/onePagerReportEngine");
const onePagerReportBulkEngine = require("../features/one-pager-report/onePagerReportBulkEngine");
const { defaultEngine: toteEngine } = require("../features/tote-puller/totePullEngine");
const { defaultEngine: autoEngine } = require("../features/tote-puller/autoEngine");


const QUERY_TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);
const SESSION_TERMINAL = new Set(["COMPLETED", "STOPPED"]);

// Any signed-in user may watch any job's progress (site data); cancelling stays owner-or-ADMIN (queries routes).
function existingQuery(row) {
  if (!row) throw new Error("Query not found");
  return row;
}

function registerFeeds(hub, { getConnectionStatusFn = getConnectionStatus } = {}) {
  // ── Service health (cached shared-login checks, no NexS login) ────────────
  // The latest run of each run-type screen, shared with everyone (who / when / version only; the screen reads the
  // full result when the version changes). In-memory, so a short interval costs nothing upstream.
  for (const panel of ["tracker", "cngValidator", "bulkInventoryCheck"]) {
    hub.registerFeed({ topic: `shared.${panel}`, intervalMs: 3 * 1000, fetch: async () => (await sharedResults.header(panel)) || { version: 0 } });
  }
  hub.registerFeed({ topic: "connections", intervalMs: 15 * 1000, fetch: () => getConnectionStatusFn() });

  // Dashboard tiles + popups, and the ASRS Location Audit read they share.
  registerDashboardFeeds(hub);
  // The Picking Monitor: orders picked per hour (running hour re-read only; see pickingFeeds.js).
  hub.registerFeed({ topic: "picking.monitor", scope: "key", intervalMs: PICKING_INTERVAL_MS, minRefreshMs: 30 * 1000, backgroundIntervalMs: PICKING_BACKGROUND_MS, fetch: fetchPicking });
  // The Picking Monitor's order pipeline strip: 12 scalar counts, one capability call (see pickingFeeds.js).
  hub.registerFeed({ topic: "picking.pipeline", scope: "key", intervalMs: PIPELINE_INTERVAL_MS, minRefreshMs: 30 * 1000, backgroundIntervalMs: PICKING_BACKGROUND_MS, fetch: fetchPipeline });
  registerAlertsFeed(hub); // the Alerts page + the sidebar notices
  registerPurgeVerifier(); // purge-mode pulls: Quadron baseline + 2-day watch

  // ── Snapshots other people (or the auto-refresh) may update: DB reads ──────
  hub.registerFeed({ topic: "locked-tote-info.current", intervalMs: 10 * 1000, fetch: async () => (await classificationEngine.getCurrentSnapshot()) || { empty: true } });
  // Locked Totes / Tote Utilisation history is site data: ONE shared copy for everyone, whoever (or the
  // auto-refresh) produced each run. "latest" is the Dashboard tile's two-row version of the same list.
  hub.registerFeed({
    topic: "locked-tote-info.latest", intervalMs: 10 * 1000, minRefreshMs: 30 * 1000,
    fetch: async ({ manual }) => {
      if (manual) await lockedTotesAuto.refreshNow({ maxAgeMs: 60 * 1000 }); // a screen's refresh: a fresh snapshot first
      return classificationEngine.listRecentResults({ limit: 2 });
    },
  });
  hub.registerFeed({
    topic: "locked-tote-info.history", intervalMs: 10 * 1000,
    fetch: () => classificationEngine.listRecentResults({ limit: 15 }),
  });
  const readUtilisationHistory = versionGuarded(utilisationVersion, () => listUtilisationResults({ limit: 20 }));
  hub.registerFeed({
    topic: "tote-utilisation.history", intervalMs: 10 * 1000,
    fetch: async ({ manual } = {}) => {
      if (manual) nexsDumpOnRequest.dumpIfOld(); // Tote Utilisation's refresh: a new NexS dump when the last is over 6 h old
      return readUtilisationHistory();
    },
  });
  // Location Audit marks (today's site day): a small DB read, pushed only when someone marks or clears a slot.
  hub.registerFeed({ topic: "asrs-locations.marks", intervalMs: 5 * 1000, fetch: () => auditMarks.list() });
  hub.registerFeed({ topic: "one-pager.current", intervalMs: 15 * 1000, fetch: async () => (await onePagerReportEngine.getCurrentReport()) || { empty: true } });

  // ── In-memory engine state: cheap, fast ────────────────────────────────────
  hub.registerFeed({
    topic: "tote-purge.current", intervalMs: 3 * 1000,
    fetch: async () => {
      const report = purgeEngine.getCurrentReport();
      const status = purgeEngine.getStatus();
      const lastAttempt = purgeEngine.getLastAttempt();
      const progress = purgeEngine.getProgress(); // a run in progress (anyone's): step + estimated time left
      return report ? { ...report, status, lastAttempt, progress } : { empty: true, status, lastAttempt, progress };
    },
  });
  hub.registerFeed({
    topic: "one-pager.bulk", intervalMs: 3 * 1000,
    fetch: async () => {
      const report = onePagerReportBulkEngine.getCurrentReport();
      const status = onePagerReportBulkEngine.getStatus();
      const lastAttempt = onePagerReportBulkEngine.getLastAttempt();
      return report ? { ...report, status, lastAttempt } : { empty: true, status, lastAttempt };
    },
  });
  // Who is running Auto right now, for everyone (the Dashboard tile, the Auto Puller banner). The per-user
  // "auto.session" below stays the operator's own session; this one carries only a safe summary.
  hub.registerFeed({
    topic: "auto.active", intervalMs: 3 * 1000, // in-memory read, no upstream
    fetch: async () => ({ sessions: autoEngine.activeSummaries() }),
  });
  hub.registerFeed({
    topic: "auto.session", scope: "user", intervalMs: 3 * 1000,
    fetch: async ({ user }) => {
      const session = autoEngine.findActive(); // one shared Auto line, whoever started it
      return session ? autoEngine.snapshot(session) : { active: false };
    },
  });

  // ── Admin ────────────────────────────────────────────────────────────────
  hub.registerFeed({
    topic: "admin.queries", roles: ["ADMIN"], intervalMs: 3 * 1000,
    fetch: async () => {
      const rows = await queryManager.listQueries({ isAdmin: true, limit: 200 });
      return rows.map((r) => ({ ...toPublicQuery(r), user: r.employee_id }));
    },
  });
  // Pull Logs: every Manual and Auto pull session, everyone's, in one shared feed (each entry carries kind MANUAL/AUTO).
  hub.registerFeed({
    topic: "operations", intervalMs: 10 * 1000,
    fetch: async () => toEntries(await auditLog.listByActions(OPERATION_ACTIONS, 100), await getConnectionStatusFn()),
  });

  // ── One running job (key = its id): progress without client polling ─────────
  hub.registerFeed({
    topic: "query", scope: "key", intervalMs: 1500,
    fetch: async ({ key }) => toPublicQuery(existingQuery(await queryManager.getQuery(key))),
    stopWhen: (q) => QUERY_TERMINAL.has(q.status),
  });
  hub.registerFeed({
    topic: "tote-session", scope: "key", intervalMs: 1000,
    fetch: async ({ user, key }) => {
      const r = toteEngine.get(key, user);
      if (!r.ok) throw new Error(r.reason);
      return r.session;
    },
    stopWhen: (s) => SESSION_TERMINAL.has(s.status),
  });
  hub.registerFeed({
    topic: "auto-session", scope: "key", intervalMs: 1000,
    fetch: async ({ user, key }) => {
      const r = autoEngine.get(key, user);
      if (!r.ok) throw new Error(r.reason);
      return r.session;
    },
    stopWhen: (s) => SESSION_TERMINAL.has(s.status),
  });

  // No automatic refresh timers (operator decision 2026-11-04): these screen-data topics are read once for the
  // first viewer, then only when a screen asks - opening the tab, Refresh, or a Dashboard tile's own
  // auto refresh interval. Still live on their own pace: job progress (query, sessions, purge / range-report runs,
  // Auto Puller), the alert list and the connection indicators - those are not refresh timers.
  hub.markOnDemand([
    "dashboard.compaction", "dashboard.cc", "dashboard.aisle", "dashboard.outside", "dashboard.utilisation", "dashboard-detail",
    "aisle-occupancy.current", "asrs-locations.current", "asrs-locations.marks",
    "picking.monitor", "picking.pipeline",
    "locked-tote-info.current", "locked-tote-info.latest", "locked-tote-info.history",
    "tote-utilisation.history", "one-pager.current", "operations",
  ]);

  // The Dashboard's central auto refresh (admin-set, one timer per tile source for the whole site): the defaults
  // apply at once; live/index.js loads the stored settings at startup. Every Dashboard follows the settings and
  // countdown on "dashboard.autoRefresh" (an in-memory read).
  const autoRefresh = dashboardAutoRefresh.create({ hub });
  for (const s of dashboardAutoRefresh.SOURCES) hub.setAutoInterval(s.topic, s.def * 60000);
  hub.registerFeed({ topic: "dashboard.autoRefresh", intervalMs: 2000, fetch: async () => autoRefresh.view() });
  hub.dashboardAutoRefresh = autoRefresh;
}

module.exports = { registerFeeds };
