// Central place to read environment variables. Nothing in this file (or
// anything it reads) is ever sent to the browser - routes/public/ must not
// import this module's secret-bearing fields into a response body.

const { assertLocalDevModeSafe, isLocalDevAuthEnabled } = require("./platform/session/localDevGuard");

function bool(v, fallback) {
  if (v == null || v === "") return fallback;
  return String(v).trim().toLowerCase() === "true";
}

function int(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const nodeEnv = process.env.NODE_ENV || "development";
const asoLocalDev = bool(process.env.ASO_LOCAL_DEV, false);

// STRICT LOCAL DEVELOPMENT AUTH MODE guard - throws (crashing startup)
// before any other config field, DB pool, or route is ever built if
// ASO_LOCAL_DEV=true is combined with NODE_ENV=production. See
// server/platform/session/localDevGuard.js and server/platform/http/requireAuth.js.
assertLocalDevModeSafe({ asoLocalDev, nodeEnv });

const localDevAuthEnabled = isLocalDevAuthEnabled({ asoLocalDev, nodeEnv });

const config = {
  nodeEnv,
  isProduction: nodeEnv === "production",

  // When true, requireAuth grants every request an in-memory ADMIN
  // identity without ever touching MySQL - ONLY when NODE_ENV is exactly
  // "development" AND ASO_LOCAL_DEV=true (never merely "not production").
  // This must NEVER be settable by anything other than these two explicit
  // env vars - no UI switch, no auto-enable on a DB failure/timeout.
  asoLocalDev,
  localDevAuthEnabled,

  // Query Manager persistence mode (server/platform/queries/queryManager.js's
  // selector). Deliberately NOT its own env var - fully derived from
  // localDevAuthEnabled above, so it can never be enabled independently of
  // the same ASO_LOCAL_DEV+NODE_ENV=development gate (see
  // queryManager.js's own comment for why). "mysql" in every other case,
  // including production, by construction.
  queryManagerMode: localDevAuthEnabled ? "memory" : "mysql",

  // Local-First Phase 1 persistence mode (server/platform/storage/localStore.js and
  // everything built on it: outbox.js, queryManagerMemory.js's row
  // persistence, auditLog.js's local fallback, classificationTimestamps.js's
  // selector). Deliberately NOT its own env var - derived from
  // localDevAuthEnabled exactly like queryManagerMode above, for the same
  // reason: this must never be enabled independently of the
  // ASO_LOCAL_DEV=true + NODE_ENV=development gate. "mysql" in every other
  // case, including production, by construction.
  localStoreMode: localDevAuthEnabled ? "local" : "mysql",

  port: int(process.env.PORT, 4000),

  // MySQL - the persistent AOS datastore. Same code runs against the dev and
  // company-server targets; only these values differ between environments.
  dbHost: process.env.DB_HOST || "",
  dbPort: int(process.env.DB_PORT, 3306),
  dbName: process.env.DB_NAME || "",
  dbUser: process.env.DB_USER || "",
  dbPassword: process.env.DB_PASSWORD || "",
  dbSsl: bool(process.env.DB_SSL, false),
  dbConnectionLimit: int(process.env.DB_CONNECTION_LIMIT, 10),

  // Database review remediation (2026-09-04) - see server/platform/db/pool.js and
  // server/platform/db/index.js for how each of these is actually applied. Defaults
  // chosen to match mysql2's own built-in defaults where one already exists
  // (idleTimeout/maxIdle/connectTimeout), so setting nothing changes
  // nothing about current behavior - these just make the existing implicit
  // behavior explicit and independently tunable per environment.
  //
  // mysql2 has no concept of eagerly pre-warmed "minimum" connections
  // (connections are always created lazily, on demand) - dbMaxIdleConnections
  // is the closest real lever the driver supports: the max number of
  // already-open connections kept idle in the pool for reuse rather than
  // being closed outright once idleTimeout elapses.
  //
  // CORRECTED (2026-09-04, live follow-up check): originally defaulted this
  // to dbConnectionLimit itself, matching what looked like mysql2's own
  // default - but reading node_modules/mysql2/lib/base/pool.js's
  // constructor shows idle-connection reaping is gated on
  // `maxIdle < connectionLimit` - when they're EQUAL (as this original
  // default always made them), the reaper timer is never even started, so
  // dbIdleTimeoutMs was silently never enforced at all. Confirmed live: a
  // real pooled connection was still open and Sleep at 543s, nine minutes
  // after last use, with the "60s idle timeout" config in place but
  // inactive. Defaulting to half the connection limit (floor 2) keeps a
  // reasonable number of connections warm for the next burst while
  // actually letting the rest get reclaimed after dbIdleTimeoutMs, instead
  // of relying entirely on MySQL's own (8h, confirmed live) wait_timeout.
  dbMaxIdleConnections: int(process.env.DB_MAX_IDLE_CONNECTIONS, Math.max(2, Math.ceil(int(process.env.DB_CONNECTION_LIMIT, 10) / 2))),
  // How long an idle pooled connection may sit unused before mysql2 closes
  // it outright (not just marks it idle) - mysql2's own built-in default,
  // now explicit/configurable.
  dbIdleTimeoutMs: int(process.env.DB_IDLE_TIMEOUT_MS, 60000),
  // Time budget to establish a BRAND NEW TCP+auth connection to MySQL (only
  // relevant when the pool needs to open one it doesn't already have -
  // mysql2's own built-in default, now explicit/configurable).
  dbConnectTimeoutMs: int(process.env.DB_CONNECT_TIMEOUT_MS, 10000),
  // Time budget to obtain a connection FROM THE POOL - covers waiting for
  // an existing connection to free up when every connection is currently
  // busy (mysql2's pool has no native timeout for this internal queueing
  // wait with waitForConnections:true/queueLimit:0 - see db/index.js's
  // withAcquireTimeout() for the actual enforcement). This is the fix for
  // "the application must not allow requests to hang indefinitely" when the
  // pool is exhausted.
  dbAcquireTimeoutMs: int(process.env.DB_ACQUIRE_TIMEOUT_MS, 10000),
  // Per-statement timeout, applied to every query/execute call via mysql2's
  // native {sql, timeout} option (see db/index.js). 30s matches this app's
  // own existing precedent for "generous but bounded" elsewhere in this
  // file (appsScriptTimeoutMs/grafanaCapabilityTimeoutMs default to the
  // same 30000) - every query this app runs against its own schema is a
  // simple, already-indexed lookup that normally completes in milliseconds;
  // this exists to catch a genuinely hung/pathological query, not to
  // constrain normal operation.
  dbQueryTimeoutMs: int(process.env.DB_QUERY_TIMEOUT_MS, 30000),
  // Idle time before the OS starts TCP keep-alive probes on a pooled connection (see platform/db/pool.js).
  dbKeepAliveMs: int(process.env.DB_KEEPALIVE_MS, 10000),
  // How often the pool is pinged to keep its connections warm and replace dead ones (0 = off).
  dbWarmPingMs: int(process.env.DB_WARM_PING_MS, 30000),
  // Extra attempts for a read that fails on a dropped connection (never for writes). 0 = off.
  dbReadRetries: int(process.env.DB_READ_RETRIES, 2),
  //
  // NOT implemented: a maximum connection LIFETIME (force-recycling a
  // connection after N hours regardless of activity). mysql2's pool has no
  // native hook for this (confirmed by inspecting node_modules/mysql2/lib/
  // pool.js and pool_config.js - no such option exists to pass through),
  // and bolting on a manual "close and replace" scheme outside the driver's
  // own connection bookkeeping would be a real correctness risk (a
  // connection recycled out from under an in-flight query) for a benefit
  // this schema doesn't need - dbIdleTimeoutMs already bounds how long a
  // genuinely idle connection can persist. If this is ever required, it
  // needs to be revisited as a driver-level capability, not worked around
  // here.

  // Only used by the test suite - must be a separate database from dbName.
  testDbName: process.env.TEST_DB_NAME || "",

  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 8),
  cookieSecure: bool(process.env.COOKIE_SECURE, false),

  // Google Apps Script - server-side only. Never expose these two values
  // (or anything derived that reveals them) in an API response.
  appsScriptUrl: process.env.APPS_SCRIPT_URL || "",
  appsScriptKey: process.env.APPS_SCRIPT_KEY || "",
  appsScriptTimeoutMs: int(process.env.APPS_SCRIPT_TIMEOUT_MS, 30000),
  // Optional Google user credentials file (type "authorized_user", e.g. the
  // one `gcloud auth application-default login` writes). When set, the Apps
  // Script call carries that lenskart.com identity as a Bearer token, which a
  // web app restricted to the domain requires. Server-side only.
  appsScriptAuthCredentialsPath: process.env.APPS_SCRIPT_AUTH_CREDENTIALS_PATH || null,

  seedAdminId: process.env.SEED_ADMIN_ID || "ADMIN001",
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD || "ChangeMe-Admin-1!",
  seedUserId: process.env.SEED_USER_ID || "EMP001",
  seedUserPassword: process.env.SEED_USER_PASSWORD || "ChangeMe-User-1!",

  // Grafana capability (Phase 2). Confirmed from the existing extension's
  // DEFAULTS.GRAFANA_URL (background/index.js) - same host as Quadron/Concinity,
  // reverse-proxied under /grafana/. Not assumed - verified against the
  // existing implementation before use.
  // Max Grafana queries in flight at once (process-wide). A dashboard/report
  // refresh fans out into many MSSQL queries; bounding them is what stops
  // random "Data unavailable" under load. See grafanaQueryDirect.js.
  grafanaMaxConcurrency: int(process.env.GRAFANA_MAX_CONCURRENCY, 6),
  grafanaOrigin: process.env.GRAFANA_ORIGIN || "https://192.168.24.230",
  // Modeled directly on the existing APPS_SCRIPT_TIMEOUT_MS pattern/default.
  grafanaCapabilityTimeoutMs: int(process.env.GRAFANA_CAPABILITY_TIMEOUT_MS, 30000),

  // Quadron/Concinity capability (Phase 3). Same physical host as Grafana -
  // confirmed via the existing extension's fetchInventoryDashboard()
  // (background/index.js), which hits ${host}/wes/inventory/dashboard/data
  // on the same DEFAULTS.HOST used for Grafana. Separately named (not
  // aliased to grafanaOrigin) so either can be repointed independently later
  // without assuming they'll always coincide.
  quadronOrigin: process.env.QUADRON_ORIGIN || process.env.GRAFANA_ORIGIN || "https://192.168.24.230",
  // Matches DEFAULTS.INSTANCE_CODE in shared/constants.js.
  quadronInstanceCode: process.env.QUADRON_INSTANCE_CODE || "LK-069",
  quadronCapabilityTimeoutMs: int(process.env.QUADRON_CAPABILITY_TIMEOUT_MS, 30000),
  // The full inventory dump alone: 2026-11-05 it took 13 s on average, 25.8 s at worst, and ~8% of calls hit the
  // 30 s limit above - each one throwing away a whole Tote Purge run. Kept apart so tote pulls stay at 30 s.
  quadronInventoryCapabilityTimeoutMs: int(process.env.QUADRON_INVENTORY_CAPABILITY_TIMEOUT_MS, 60000),

  // Every capability executes server-side, logging in to Grafana / Concinity
  // (Quadron) / NexS with the shared service accounts below (see
  // server/integrations/logins/). There is no per-service mode switch and no
  // browser-extension relay.
  // Shared single-login accounts (2026-09-22, operator-requested: "single
  // login point... all logged in together" - ONE service account per
  // system, not a credential each of the 25-40 ASO Web App users saves
  // individually). NexS mirrors the Monitor Panel Revamped project's own
  // login (same account, operator-confirmed) - see nexsDirectUsername/
  // Password below. No defaults - a missing value must fail loudly, never
  // silently fall back to nothing.
  grafanaDirectUsername: process.env.GRAFANA_DIRECT_USERNAME || null,
  grafanaDirectPassword: process.env.GRAFANA_DIRECT_PASSWORD || null,
  concinityDirectUsername: process.env.CONCINITY_DIRECT_USERNAME || null,
  concinityDirectPassword: process.env.CONCINITY_DIRECT_PASSWORD || null,
  // Locked Totes snapshot auto-refresh: when older than this and someone has the app open (0 disables).
  lockedToteAutoRefreshMs: int(process.env.LOCKED_TOTE_AUTO_REFRESH_MS, 15 * 60 * 1000),
  // Alerts module thresholds (server/features/alerts/). Env-tunable; the rules read these.
  alertToteShortQtyThreshold: int(process.env.ALERT_TOTE_SHORT_QTY, 25), // a tote with MORE than this many units marked short
  alertStationHourToteThreshold: int(process.env.ALERT_STATION_HOUR_TOTES, 8), // a station with MORE than this many short totes in one clock hour
  // Alerts only exist from this instant on: nothing earlier is raised or shown (ISO with offset; empty = no cutoff).
  alertsStartAt: process.env.ALERTS_START_AT === undefined ? "2026-10-13T17:00:00+05:30" : process.env.ALERTS_START_AT,
  alertLookbackHours: int(process.env.ALERT_LOOKBACK_HOURS, 4), // only events this recent are raised (a long-closed app doesn't flood on reopening)
  alertEvaluateEveryMs: int(process.env.ALERT_EVALUATE_EVERY_MS, 2 * 60 * 1000),
  // How often the purge tracker looks at purge-mode pulls (see live/purgeVerify.js; it reads Quadron only when due). 0 turns it off.
  purgeVerifyEveryMs: int(process.env.PURGE_VERIFY_EVERY_MS, 5 * 60 * 1000),
  // NexS connects on demand (see integrations/logins/nexsLease.js): a lease lasts this
  // long without a heartbeat from the browser, and the session is dropped this long
  // after the last lease ends and the last NexS request finishes.
  nexsLeaseTtlMs: int(process.env.NEXS_LEASE_TTL_MS, 90 * 1000),
  nexsIdleGraceMs: int(process.env.NEXS_IDLE_GRACE_MS, 20 * 1000),
  nexsDirectUsername: process.env.NEXS_DIRECT_USERNAME || null,
  nexsDirectPassword: process.env.NEXS_DIRECT_PASSWORD || null,

  // One Pager Report -> Slack (2026-09-07, operator-approved: Slack instead
  // of email). No default - posting without a configured webhook fails
  // loudly (server/integrations/slack/slackNotifier.js), never silently no-ops.
  slackOnePagerReportWebhookUrl: process.env.SLACK_ONE_PAGER_REPORT_WEBHOOK_URL || null,

  // One Pager Report -> Google Sheet (2026-09-08, operator-approved: a
  // dedicated new Sheet, written via the Sheets API + a service account -
  // NOT an Apps Script Web App, see googleSheetsClient.js's own header
  // comment for why. "Save to Sheet" button, one row per date - overwritten
  // on a same-day re-save. See server/apps-script/SETUP.md for how to
  // create the service account/key and share the Sheet with it. No default
  // for either - saving without both configured fails loudly
  // (server/features/one-pager-report/onePagerReportSheet.js), never silently no-ops.
  onePagerReportSheetSpreadsheetId: process.env.ONE_PAGER_REPORT_SHEET_SPREADSHEET_ID || null,
  onePagerReportSheetServiceAccountKeyPath: process.env.ONE_PAGER_REPORT_SHEET_SERVICE_ACCOUNT_KEY_PATH || null,

  // Classification (SD/P0/P1/P2 scarcity thresholds). Matches
  // DEFAULT_P0_MAX_TOTES/DEFAULT_P1_MAX_TOTES in the existing extension's
  // apps-script/Code.gs and background/index.js's buildPIDMapFromInventory.
  classificationP0MaxTotes: int(process.env.CLASSIFICATION_P0_MAX_TOTES, 1),
  classificationP1MaxTotes: int(process.env.CLASSIFICATION_P1_MAX_TOTES, 3),

  // Auto Mode defaults (server/features/tote-puller/autoEngine.js). p0MaxTotes/p1MaxTotes
  // deliberately are NOT duplicated here - autoEngine.routes.js resolves
  // those from classificationP0MaxTotes/classificationP1MaxTotes above
  // unless the operator explicitly overrides them for a session, per the
  // approved blueprint's "reuse existing Classification threshold
  // configuration" instruction. Values mirror the existing extension's own
  // DEFAULTS (background/index.js): BATCH_SIZE=5, CALL_INTERVAL=5s,
  // batchIntervalMinutes=1, RETRY_DELAY=5s, COOLDOWN_HOURS=1,
  // grafanaLockedInterval=30m, grafanaSuperInterval=60m.
  autoBatchSize: int(process.env.AUTO_BATCH_SIZE, 5),
  autoCallIntervalMs: int(process.env.AUTO_CALL_INTERVAL_MS, 5000),
  autoBatchIntervalMs: int(process.env.AUTO_BATCH_INTERVAL_MS, 60000),
  autoRetryDelayMs: int(process.env.AUTO_RETRY_DELAY_MS, 5000),
  autoCooldownMs: int(process.env.AUTO_COOLDOWN_MS, 60 * 60000),
  // Auto Puller "is anyone watching?" reminder (operator decision 2026-11-04): default interval, and how long
  // the pop-up waits for an acknowledgement before the session stops itself.
  autoReminderMs: int(process.env.AUTO_REMINDER_MS, 30 * 60000),
  autoReminderAckMs: int(process.env.AUTO_REMINDER_ACK_MS, 60 * 1000),
  autoLockedDumpRefreshMs: int(process.env.AUTO_LOCKED_DUMP_REFRESH_MS, 30 * 60000),
  autoSupervisorDumpRefreshMs: int(process.env.AUTO_SUPERVISOR_DUMP_REFRESH_MS, 60 * 60000),

  // NexS Blocked Inventory capability (Tote Purge rebuild, Phase 2A).
  // Confirmed from the existing extension's fetchBlockedInv()
  // (background/index.js): NEXS_BASE = "https://app.nexs.lenskart.com".
  // Separately named/configurable like grafanaOrigin/quadronOrigin - not
  // assumed to always coincide with either. Timeout follows the exact same
  // per-capability-family, 30s-default pattern as
  // grafanaCapabilityTimeoutMs/quadronCapabilityTimeoutMs/
  // appsScriptTimeoutMs above - this is a small, single-PID lookup, so the
  // existing default is generously sufficient (no ASRS-Dump-style payload
  // size concern here).
  nexsOrigin: process.env.NEXS_ORIGIN || "https://app.nexs.lenskart.com",
  nexsCapabilityTimeoutMs: int(process.env.NEXS_CAPABILITY_TIMEOUT_MS, 30000),

  // GET_NEXS_BLOCKED_INVENTORY_BATCH (Phase 6) - a DEDICATED timeout,
  // deliberately separate from nexsCapabilityTimeoutMs above. Phase 5's
  // live-verified full-scale Purge run (814 unique candidate PIDs, the
  // current real production population, concurrency bounded at 5 on the
  // runtime side) measured the batch capability landing right at/over the
  // shared 30s ceiling (485 PIDs: 17.1s; 814 PIDs: hit the 30s timeout).
  // The single-PID capability's own 30s timeout is untouched by this - a
  // one-PID lookup was never the thing that needed more time; a
  // many-hundred-PID batch is a fundamentally different request shape and
  // gets its own, independently-tunable budget. 60s gives real headroom
  // over the ~29-30s measured at 814 PIDs without over-provisioning.
  nexsBlockedInventoryBatchCapabilityTimeoutMs: int(process.env.NEXS_BLOCKED_INVENTORY_BATCH_CAPABILITY_TIMEOUT_MS, 60000),

  // GET_GRAFANA_CC_METRICS (Dashboard, Phase FINAL) - a DEDICATED timeout,
  // same reasoning as nexsBlockedInventoryBatchCapabilityTimeoutMs above:
  // this capability runs 6 real Grafana MSSQL queries (3 shift windows x 2
  // SQL strings), not the single query every other Grafana capability's
  // shared 30s default was sized for.
  //
  // KNOWN LIVE-VERIFICATION FINDING (Phase FINAL): even after this dedicated
  // 60s budget (matching the NexS batch precedent's own scale) and a
  // matching per-sub-query relay timeout increase, a live test against the
  // real production Grafana datasource did not complete even after 240s of
  // ground-truth measurement, with ZERO partial signal (no CAPABILITY_RESULT
  // of any kind) - this is not "slow but working," it did not progress at
  // all. Root cause is NOT confirmed - it requires actual browser DevTools
  // access on the runtime's own machine (Network tab timing, whether the
  // 6 concurrent requests are being serialized/blocked, whether the SQL
  // itself is pathologically slow at this data volume) that is not available
  // from this backend-only environment. 60s here is a deliberately
  // reasonable, non-arbitrary budget (NOT tuned to "whatever number made the
  // one live test pass," since no number tested did) - do not keep raising
  // it blindly; if this capability is still failing/timing out in
  // production, the next step is browser-side diagnosis, not a bigger
  // number. See the Phase FINAL report's own "Remaining" section.
  grafanaCcMetricsCapabilityTimeoutMs: int(process.env.GRAFANA_CC_METRICS_CAPABILITY_TIMEOUT_MS, 60000),

  // CNG Inv Validator (Quadron/NexS/Grafana 3-way reconciliation) - both new
  // capabilities are batched-item requests (N tote chunks / N partition
  // lookups per execution, not a single fixed query), the same shape as
  // grafanaCcMetricsCapabilityTimeoutMs/nexsBlockedInventoryBatchCapability
  // TimeoutMs above - reusing their same 60s precedent rather than guessing
  // a new number.
  grafanaTotePartitionCountsCapabilityTimeoutMs: int(process.env.GRAFANA_TOTE_PARTITION_COUNTS_CAPABILITY_TIMEOUT_MS, 60000),
  nexsDiscrepancyReportBatchCapabilityTimeoutMs: int(process.env.NEXS_DISCREPANCY_REPORT_BATCH_CAPABILITY_TIMEOUT_MS, 60000),

  // NEXS ASRS Dump auto-refresh cadence (operator-requested: the source
  // sheet itself refreshes every 6 hours, and this app's own cached copy -
  // previously manual-refresh-only - had gone 10 days stale, causing Tote
  // Utilisation's totals, and later Tote Purge's Quadron-validation
  // "MISSING_IN_QUADRON" rate, to visibly diverge from reality. See
  // server/index.js's own scheduled refresh loop.
  nexsAsrsDumpAutoRefreshMs: int(process.env.NEXS_ASRS_DUMP_AUTO_REFRESH_MS, 6 * 60 * 60 * 1000),

  // Retry cadence used ONLY when an auto-refresh attempt fails (e.g. no
  // runtime online yet right after a restart - confirmed live: the
  // immediate on-startup attempt reliably lost this exact race 3 times in a
  // row) - short, so a transient/startup failure doesn't silently sit
  // unrefreshed for the full 6h interval. Reverts to
  // nexsAsrsDumpAutoRefreshMs as soon as one attempt actually succeeds.
  nexsAsrsDumpAutoRefreshRetryMs: int(process.env.NEXS_ASRS_DUMP_AUTO_REFRESH_RETRY_MS, 2 * 60 * 1000),

  // Dashboard's Compaction / Tote Freed rows - single query x 3 shifts each
  // (lighter than GET_GRAFANA_CC_METRICS's 2 queries x 3 shifts), but same
  // 60s precedent rather than guessing a smaller number - these are real
  // Grafana MSSQL queries relayed through the same runtime tab mechanism.
  grafanaCompactionCountCapabilityTimeoutMs: int(process.env.GRAFANA_COMPACTION_COUNT_CAPABILITY_TIMEOUT_MS, 60000),
  grafanaTotesFreedCountCapabilityTimeoutMs: int(process.env.GRAFANA_TOTES_FREED_COUNT_CAPABILITY_TIMEOUT_MS, 60000),
  grafanaAisleOccupancyCapabilityTimeoutMs: int(process.env.GRAFANA_AISLE_OCCUPANCY_CAPABILITY_TIMEOUT_MS, 60000),
  // One Pager Report's ASRS Production section (JIT + NJIT) - same 60s
  // precedent as Compaction/Tote Freed/Aisle Occupancy above.
  grafanaAsrsProductionCapabilityTimeoutMs: int(process.env.GRAFANA_ASRS_PRODUCTION_CAPABILITY_TIMEOUT_MS, 60000),

  // Outside Tote Analysis (Tracker) - same batched-item reasoning as above.
  grafanaToteFinderCapabilityTimeoutMs: int(process.env.GRAFANA_TOTE_FINDER_CAPABILITY_TIMEOUT_MS, 60000),
  grafanaTrackerHistoryCapabilityTimeoutMs: int(process.env.GRAFANA_TRACKER_HISTORY_CAPABILITY_TIMEOUT_MS, 30000),

  // Outside Tote Analysis - Auto Mode's discovery query (GET_GRAFANA_CONTAINER_TRACKING) -
  // a single fixed, full-table query with no tote-list filter, same 60s
  // precedent as grafanaAisleOccupancyCapabilityTimeoutMs above.
  grafanaContainerTrackingCapabilityTimeoutMs: int(process.env.GRAFANA_CONTAINER_TRACKING_CAPABILITY_TIMEOUT_MS, 60000),

  // Bulk Inventory Check (2026-10-01) - a single query, but its own WHERE
  // clause grows one OR'd LIKE per requested tote (see
  // grafanaToteInventoryCheck.js's own MAX_TOTES comment) - same 60s
  // precedent as the other bulk/full-table Grafana capabilities above.
  grafanaToteInventoryCheckCapabilityTimeoutMs: int(process.env.GRAFANA_TOTE_INVENTORY_CHECK_CAPABILITY_TIMEOUT_MS, 60000),

  // Capability dispatch efficiency (operator request, 2026-09-04: "don't
  // burden the servers we're fetching data from... extract data
  // effectively and efficiently"). See server/capabilities/
  // requestCoalescer.js for the actual mechanics.
  // Every one of these is scoped to READ-ONLY capabilities only
  // (capability.readOnly === true in registry.js) - PULL_QUADRON_TOTE
  // (the one write capability) always dispatches fresh, every time, never
  // coalesced or cached, since it's a real, distinct mutating action.
  //
  // How long a completed read-only capability's result is served to a
  // brand-new request for the exact same capability+params, with zero
  // upstream requests, before it's considered stale and a fresh dispatch
  // is required again. Deliberately short - long enough to collapse a
  // genuine burst (several dashboard tiles, or several users, requesting
  // the same data within the same couple of seconds) without materially
  // affecting freshness for anyone waiting longer than that. 0 disables
  // caching entirely (every request always dispatches fresh - the
  // in-flight coalescing above still applies regardless, since that's
  // about genuinely simultaneous requests, not staleness).
  capabilityResultCacheTtlMs: int(process.env.CAPABILITY_RESULT_CACHE_TTL_MS, 3000),
};

module.exports = config;
