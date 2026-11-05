// The authoritative list of capabilities the backend can execute. Each entry
// is a small, explicit, hand-maintained definition: its payload builder,
// result validator, timeout, allowed roles, and how to run it server-side
// (authService + directExecute - the backend logs into that service with its
// shared account, see server/integrations/logins/). capabilityManager.js only
// ever executes names found here.

const config = require("../../config");
const grafanaLockedTotes = require("../grafana/grafanaLockedTotes");
const grafanaLockedTotesDirect = require("../grafana/grafanaLockedTotesDirect");
const grafanaSupervisorDump = require("../grafana/grafanaSupervisorDump");
const grafanaSupervisorDumpDirect = require("../grafana/grafanaSupervisorDumpDirect");
const quadronInventory = require("../quadron/quadronInventory");
const quadronInventoryDirect = require("../quadron/quadronInventoryDirect");
const pullQuadronTote = require("../quadron/pullQuadronTote");
const pullQuadronToteDirect = require("../quadron/pullQuadronToteDirect");
const nexsBlockedInventoryDirect = require("../nexs/nexsBlockedInventoryDirect");
const nexsDiscrepancyReportBatchDirect = require("../nexs/nexsDiscrepancyReportBatchDirect");
const grafanaMultiQueryDirect = require("../grafana/grafanaMultiQueryDirect");
const nexsBlockedInventory = require("../nexs/nexsBlockedInventory");
const nexsBlockedInventoryBatch = require("../nexs/nexsBlockedInventoryBatch");
const nexsBlockedInventoryBatchDirect = require("../nexs/nexsBlockedInventoryBatchDirect");
const grafanaCcMetrics = require("../grafana/grafanaCcMetrics");
const grafanaCompactionCount = require("../grafana/grafanaCompactionCount");
const grafanaTotesFreedCount = require("../grafana/grafanaTotesFreedCount");
const grafanaHourlyMetrics = require("../grafana/grafanaHourlyMetrics");
const grafanaPickingStations = require("../grafana/grafanaPickingStations");
const grafanaOrderPipeline = require("../grafana/grafanaOrderPipeline");
const grafanaAsrsProductionNjit = require("../grafana/grafanaAsrsProductionNjit");
const grafanaAsrsProductionJit = require("../grafana/grafanaAsrsProductionJit");
const grafanaAsrsProductionFr0 = require("../grafana/grafanaAsrsProductionFr0");
const grafanaAisleOccupancy = require("../grafana/grafanaAisleOccupancy");
const gtpStationConfig = require("../gtp/gtpStationConfig");
const gtpStationConfigDirect = require("../gtp/gtpStationConfigDirect");
const grafanaPtlQueue = require("../grafana/grafanaPtlQueue");
const grafanaTotePartitionCounts = require("../grafana/grafanaTotePartitionCounts");
const nexsDiscrepancyReportBatch = require("../nexs/nexsDiscrepancyReportBatch");
const grafanaToteFinder = require("../grafana/grafanaToteFinder");
const grafanaToteFinderDirect = require("../grafana/grafanaToteFinderDirect");
const grafanaTrackerHistory = require("../grafana/grafanaTrackerHistory");
const grafanaTrackerHistoryDirect = require("../grafana/grafanaTrackerHistoryDirect");
const grafanaContainerTracking = require("../grafana/grafanaContainerTracking");
const grafanaContainerTrackingDirect = require("../grafana/grafanaContainerTrackingDirect");
const grafanaToteInventoryCheck = require("../grafana/grafanaToteInventoryCheck");
const grafanaToteInventoryCheckDirect = require("../grafana/grafanaToteInventoryCheckDirect");

const CAPABILITIES = {
  GET_GRAFANA_LOCKED_TOTES: {
    name: "GET_GRAFANA_LOCKED_TOTES",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_LOCKED_TOTES",
    buildPayload: () => grafanaLockedTotes.buildPayload(config.grafanaOrigin),
    validateResult: grafanaLockedTotes.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaLockedTotesDirect.execute(appUserId, payload, signal),
  },
  GET_GRAFANA_SUPERVISOR_DUMP: {
    name: "GET_GRAFANA_SUPERVISOR_DUMP",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_SUPERVISOR_DUMP",
    buildPayload: () => grafanaSupervisorDump.buildPayload(config.grafanaOrigin),
    validateResult: grafanaSupervisorDump.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaSupervisorDumpDirect.execute(appUserId, payload, signal),
  },
  GET_QUADRON_INVENTORY: {
    name: "GET_QUADRON_INVENTORY",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.quadronOrigin],
    timeoutMs: config.quadronInventoryCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_QUADRON_INVENTORY",
    buildPayload: () => quadronInventory.buildPayload(config.quadronOrigin, config.quadronInstanceCode),
    validateResult: quadronInventory.validateResult,
    // authService picks the shared login; directExecute does the real request.
    authService: "concinity",
    directExecute: (appUserId, params, signal) => quadronInventoryDirect.execute(appUserId, params, signal),
  },
  PULL_QUADRON_TOTE: {
    name: "PULL_QUADRON_TOTE",
    minProtocolVersion: 1,
    readOnly: false,
    write: true,
    hostAllowList: [config.quadronOrigin],
    timeoutMs: config.quadronCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_PULL_QUADRON_TOTE",
    // The only capability so far that needs caller-supplied parameters -
    // buildPayload receives them from capabilityManager.js's (backward-
    // compatible) params argument, unlike the two read capabilities above,
    // which ignore whatever is passed to their zero-arg buildPayload.
    buildPayload: (params) => pullQuadronTote.buildPayload(config.quadronOrigin, params),
    validateResult: pullQuadronTote.validateResult,
    authService: "concinity",
    directExecute: (appUserId, payload, signal) => pullQuadronToteDirect.execute(appUserId, payload, signal),
  },
  GET_NEXS_BLOCKED_INVENTORY: {
    name: "GET_NEXS_BLOCKED_INVENTORY",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.nexsOrigin],
    timeoutMs: config.nexsCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_NEXS_BLOCKED_INVENTORY",
    // The one capability besides PULL_QUADRON_TOTE that needs caller-
    // supplied parameters (which PID, which facility) - buildPayload
    // receives them from capabilityManager.js's params argument.
    buildPayload: (params) => nexsBlockedInventory.buildPayload(config.nexsOrigin, params),
    validateResult: nexsBlockedInventory.validateResult,
    authService: "nexs",
    directExecute: (appUserId, payload, signal) => nexsBlockedInventoryDirect.execute(appUserId, payload, signal),
  },
  GET_NEXS_BLOCKED_INVENTORY_BATCH: {
    name: "GET_NEXS_BLOCKED_INVENTORY_BATCH",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.nexsOrigin],
    // Dedicated timeout (Phase 6), deliberately separate from the
    // single-PID capability's own nexsCapabilityTimeoutMs above - see
    // config.js's own comment on nexsBlockedInventoryBatchCapabilityTimeoutMs
    // for the Phase 5 measurements that justified this. A many-hundred-PID
    // batch is a fundamentally different request shape than a one-PID
    // lookup and must be independently tunable.
    timeoutMs: config.nexsBlockedInventoryBatchCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_NEXS_BLOCKED_INVENTORY_BATCH",
    // pids/facilityCode are caller-supplied, like PULL_QUADRON_TOTE's and
    // GET_NEXS_BLOCKED_INVENTORY's own params.
    buildPayload: (params) => nexsBlockedInventoryBatch.buildPayload(config.nexsOrigin, params),
    validateResult: nexsBlockedInventoryBatch.validateResult,
    // On-demand only (Tote Purge and Outside Tote Analysis): NexS allows a
    // single active session per account, so it is never polled - see
    // nexsBlockedInventoryBatchDirect.js's header.
    authService: "nexs",
    directExecute: (appUserId, payload, signal) => nexsBlockedInventoryBatchDirect.execute(appUserId, payload, signal),
  },
  // Dashboard's CC Done / Discrepancies Marked / Station Coverage sections
  // (Phase FINAL) - same Grafana MSSQL datasource as GET_GRAFANA_LOCKED_TOTES/
  // GET_GRAFANA_SUPERVISOR_DUMP, fixed SQL ported verbatim from the legacy
  // extension's ASRS Daily Report - see grafanaCcMetrics.js.
  GET_GRAFANA_CC_METRICS: {
    name: "GET_GRAFANA_CC_METRICS",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    // Dedicated timeout, not grafanaCapabilityTimeoutMs - see config.js's own
    // comment on grafanaCcMetricsCapabilityTimeoutMs for why (6 real Grafana
    // queries per execution, not 1).
    timeoutMs: config.grafanaCcMetricsCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_CC_METRICS",
    buildPayload: (params) => grafanaCcMetrics.buildPayload(config.grafanaOrigin, params),
    validateResult: grafanaCcMetrics.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaMultiQueryDirect.executeCcMetrics(appUserId, payload, signal),
  },
  // Dashboard's Compaction row - a SEPARATE, dedicated Grafana datasource
  // from every other capability here (own GTP instance, uid "BE6qWEb4z" /
  // id 6, vs "rerQ11pVk" / 1 used everywhere else) - same Grafana origin
  // though. Deliberately its own capability, not folded into
  // GET_GRAFANA_CC_METRICS, so it dispatches/fails independently of that
  // capability's own known reliability issues - see grafanaCompactionCount.js.
  GET_GRAFANA_COMPACTION_COUNT: {
    name: "GET_GRAFANA_COMPACTION_COUNT",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaCompactionCountCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_COMPACTION_COUNT",
    buildPayload: (params) => grafanaCompactionCount.buildPayload(config.grafanaOrigin, params),
    validateResult: grafanaCompactionCount.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaMultiQueryDirect.executeCompactionCount(appUserId, payload, signal),
  },
  // Dashboard's "Tote Freed" row, shown alongside Compaction - same
  // datasource as GET_GRAFANA_CC_METRICS ("rerQ11pVk" / 1), but its own
  // capability for the same independence reason as Compaction above - see
  // grafanaTotesFreedCount.js.
  GET_GRAFANA_TOTES_FREED_COUNT: {
    name: "GET_GRAFANA_TOTES_FREED_COUNT",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaTotesFreedCountCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_TOTES_FREED_COUNT",
    buildPayload: (params) => grafanaTotesFreedCount.buildPayload(config.grafanaOrigin, params),
    validateResult: grafanaTotesFreedCount.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaMultiQueryDirect.executeTotesFreedCount(appUserId, payload, signal),
  },
  // Items picked per GTP picking station, for any list of windows (the Picking Monitor) - see grafanaPickingStations.js.
  GET_GRAFANA_PICKING_STATIONS: {
    name: "GET_GRAFANA_PICKING_STATIONS",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaAsrsProductionCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_PICKING_STATIONS",
    buildPayload: (params) => grafanaPickingStations.buildPayload(config.grafanaOrigin, params),
    validateResult: grafanaPickingStations.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaMultiQueryDirect.executePickingStations(appUserId, payload, signal),
  },
  // Order counts by pipeline stage (the Picking Monitor strip) - see grafanaOrderPipeline.js.
  GET_GRAFANA_ORDER_PIPELINE: {
    name: "GET_GRAFANA_ORDER_PIPELINE",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaAsrsProductionCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_ORDER_PIPELINE",
    buildPayload: (params) => grafanaOrderPipeline.buildPayload(config.grafanaOrigin, params),
    validateResult: grafanaOrderPipeline.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaMultiQueryDirect.executeOrderPipeline(appUserId, payload, signal),
  },
  // Hourly variants of Compaction / Totes Freed for the Dashboard's detail
  // popups ("since 06:00, hour by hour") - same SQL, one query per hour.
  GET_GRAFANA_COMPACTION_HOURLY: {
    name: "GET_GRAFANA_COMPACTION_HOURLY",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaAsrsProductionCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_COMPACTION_HOURLY",
    buildPayload: (params) => grafanaHourlyMetrics.buildCompactionPayload(config.grafanaOrigin, params),
    validateResult: grafanaHourlyMetrics.validateHourly,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaMultiQueryDirect.executeCompactionHourly(appUserId, payload, signal),
  },
  GET_GRAFANA_TOTES_FREED_HOURLY: {
    name: "GET_GRAFANA_TOTES_FREED_HOURLY",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaAsrsProductionCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_TOTES_FREED_HOURLY",
    buildPayload: (params) => grafanaHourlyMetrics.buildTotesFreedPayload(config.grafanaOrigin, params),
    validateResult: grafanaHourlyMetrics.validateHourly,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaMultiQueryDirect.executeTotesFreedHourly(appUserId, payload, signal),
  },
  // One Pager Report's ASRS Production section (NJIT/FR1 row) - ported from
  // the standalone "ASRS Production Report (JIT/NJIT)" Chrome extension
  // (asrs-production-report/), same datasource as CC Metrics/Tote Freed
  // ("rerQ11pVk" / 1) - see grafanaAsrsProductionNjit.js.
  GET_GRAFANA_ASRS_PRODUCTION_NJIT: {
    name: "GET_GRAFANA_ASRS_PRODUCTION_NJIT",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaAsrsProductionCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_ASRS_PRODUCTION_NJIT",
    buildPayload: (params) => grafanaAsrsProductionNjit.buildPayload(config.grafanaOrigin, params),
    validateResult: grafanaAsrsProductionNjit.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaMultiQueryDirect.executeAsrsProductionNjit(appUserId, payload, signal),
  },
  // One Pager Report's ASRS Production section (JIT row) - a genuinely
  // separate Grafana datasource ("A83AuthVz" / 2) from every other
  // capability in this registry - see grafanaAsrsProductionJit.js.
  GET_GRAFANA_ASRS_PRODUCTION_JIT: {
    name: "GET_GRAFANA_ASRS_PRODUCTION_JIT",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaAsrsProductionCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_ASRS_PRODUCTION_JIT",
    buildPayload: (params) => grafanaAsrsProductionJit.buildPayload(config.grafanaOrigin, params),
    validateResult: grafanaAsrsProductionJit.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaMultiQueryDirect.executeAsrsProductionJit(appUserId, payload, signal),
  },
  // ASRS Production FR0 row - completed orders, WES datasource ("rerQ11pVk" / 1) - see grafanaAsrsProductionFr0.js.
  GET_GRAFANA_ASRS_PRODUCTION_FR0: {
    name: "GET_GRAFANA_ASRS_PRODUCTION_FR0",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaAsrsProductionCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_ASRS_PRODUCTION_FR0",
    buildPayload: (params) => grafanaAsrsProductionFr0.fr0.buildPayload(config.grafanaOrigin, params),
    validateResult: grafanaAsrsProductionFr0.fr0.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaMultiQueryDirect.executeAsrsProductionFr0(appUserId, payload, signal),
  },
  // ASRS Production FR0-Bulk row - ITEMS picked (not orders), WES datasource - see grafanaAsrsProductionFr0.js.
  GET_GRAFANA_ASRS_PRODUCTION_BULK_ITEMS: {
    name: "GET_GRAFANA_ASRS_PRODUCTION_BULK_ITEMS",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaAsrsProductionCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_ASRS_PRODUCTION_BULK_ITEMS",
    buildPayload: (params) => grafanaAsrsProductionFr0.bulkItems.buildPayload(config.grafanaOrigin, params),
    validateResult: grafanaAsrsProductionFr0.bulkItems.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaMultiQueryDirect.executeAsrsProductionBulkItems(appUserId, payload, signal),
  },
  // Dashboard's Aisle Occupancy section - same datasource as CC Metrics/
  // Tote Freed, but a live snapshot with no time-window params (the SQL
  // ignores the query's time range entirely) - see grafanaAisleOccupancy.js.
  // Picking Monitor: GTP station master data (type / operation / state / priority weight) from the GTP service
  // with the shared Concinity login.
  GET_GTP_STATION_CONFIG: {
    name: "GET_GTP_STATION_CONFIG",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.quadronOrigin],
    timeoutMs: config.quadronCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GTP_STATION_CONFIG",
    buildPayload: () => gtpStationConfig.buildPayload(config.quadronOrigin, config.quadronInstanceCode),
    validateResult: gtpStationConfig.validateResult,
    authService: "concinity",
    directExecute: (appUserId, payload, signal) => gtpStationConfigDirect.execute(appUserId, payload, signal),
  },
  // Picking Monitor: items still queued and slots occupied on each station's PTL wall (live snapshot).
  GET_GRAFANA_PTL_QUEUE: {
    name: "GET_GRAFANA_PTL_QUEUE",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaAisleOccupancyCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_PTL_QUEUE",
    buildPayload: () => grafanaPtlQueue.buildPayload(config.grafanaOrigin),
    validateResult: grafanaPtlQueue.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaMultiQueryDirect.executePtlQueue(appUserId, payload, signal),
  },
  GET_GRAFANA_AISLE_OCCUPANCY: {
    name: "GET_GRAFANA_AISLE_OCCUPANCY",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaAisleOccupancyCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_AISLE_OCCUPANCY",
    buildPayload: () => grafanaAisleOccupancy.buildPayload(config.grafanaOrigin),
    validateResult: grafanaAisleOccupancy.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaMultiQueryDirect.executeAisleOccupancy(appUserId, payload, signal),
  },
  // CNG Inv Validator (Quadron/NexS/Grafana 3-way tote-partition
  // reconciliation) - Grafana leg. Same datasource as GET_GRAFANA_LOCKED_TOTES/
  // GET_GRAFANA_CC_METRICS, but a caller-supplied, backend-built dynamic
  // query (batched per tote-ID chunk) instead of one fixed SQL string - see
  // grafanaTotePartitionCounts.js.
  GET_GRAFANA_TOTE_PARTITION_COUNTS: {
    name: "GET_GRAFANA_TOTE_PARTITION_COUNTS",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaTotePartitionCountsCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_TOTE_PARTITION_COUNTS",
    buildPayload: (params) => grafanaTotePartitionCounts.buildPayload(config.grafanaOrigin, params),
    validateResult: grafanaTotePartitionCounts.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaMultiQueryDirect.executeTotePartitionCounts(appUserId, payload, signal),
  },
  // CNG Inv Validator - NexS leg. Same request contract as
  // GET_NEXS_BLOCKED_INVENTORY(_BATCH) (cookie auth, direct-fetch-then-tab-
  // relay), a different NexS endpoint (fetchDiscrepancyReport, per-partition
  // location lookup) - see nexsDiscrepancyReportBatch.js.
  GET_NEXS_DISCREPANCY_REPORT_BATCH: {
    name: "GET_NEXS_DISCREPANCY_REPORT_BATCH",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.nexsOrigin],
    timeoutMs: config.nexsDiscrepancyReportBatchCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_NEXS_DISCREPANCY_REPORT_BATCH",
    buildPayload: (params) => nexsDiscrepancyReportBatch.buildPayload(config.nexsOrigin, params),
    validateResult: nexsDiscrepancyReportBatch.validateResult,
    authService: "nexs",
    directExecute: (appUserId, payload, signal) => nexsDiscrepancyReportBatchDirect.execute(appUserId, payload, signal),
  },
  // Outside Tote Analysis (Tracker) - tote finder + scanner events. Same
  // datasource as GET_GRAFANA_LOCKED_TOTES - see grafanaToteFinder.js.
  GET_GRAFANA_TOTE_FINDER: {
    name: "GET_GRAFANA_TOTE_FINDER",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaToteFinderCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_TOTE_FINDER",
    buildPayload: (params) => grafanaToteFinder.buildPayload(config.grafanaOrigin, params),
    validateResult: grafanaToteFinder.validateResult,
    // Direct-login pilot (2026-09-23 urgent fix - runtime-relay path was
    // actively failing in production, same "Cannot access contents of the
    // page" extension error as GET_GRAFANA_CONTAINER_TRACKING - see
    // grafanaToteFinderDirect.js's own header comment). Uses grafanaAuth.js's
    // existing SHARED single Grafana login - no new credential needed.
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaToteFinderDirect.execute(appUserId, payload, signal),
  },
  // Outside Tote Analysis - last-good-location lookup, only ever dispatched
  // for totes GET_GRAFANA_TOTE_FINDER's own result classified as Bad
  // Tracker - see grafanaTrackerHistory.js/server/features/tracker/trackerEngine.js.
  GET_GRAFANA_TRACKER_HISTORY: {
    name: "GET_GRAFANA_TRACKER_HISTORY",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaTrackerHistoryCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_TRACKER_HISTORY",
    buildPayload: (params) => grafanaTrackerHistory.buildPayload(config.grafanaOrigin, params),
    validateResult: grafanaTrackerHistory.validateResult,
    // Direct-login pilot (2026-09-23 urgent fix - same runtime-relay failure
    // and fix as GET_GRAFANA_TOTE_FINDER above, part of the same Outside
    // Tote Analysis pipeline - see grafanaTrackerHistoryDirect.js's own
    // header comment). Uses grafanaAuth.js's existing SHARED single Grafana
    // login - no new credential needed.
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaTrackerHistoryDirect.execute(appUserId, payload, signal),
  },
  // Outside Tote Analysis - Auto Mode's discovery query. Unlike every other
  // Tracker capability, takes no tote list - returns every tote system-wide
  // with its Location/Zone/Shuttle/Health/Stock-Check-Blocked/Bin-Blocked/
  // Bad-Tracker fields in one shot, so Auto Mode can find Location='OUT'
  // candidates without already knowing their IDs - see
  // grafanaContainerTracking.js/server/features/tracker/trackerEngine.js's runAuto().
  GET_GRAFANA_CONTAINER_TRACKING: {
    name: "GET_GRAFANA_CONTAINER_TRACKING",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaContainerTrackingCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_CONTAINER_TRACKING",
    buildPayload: () => grafanaContainerTracking.buildPayload(config.grafanaOrigin),
    validateResult: grafanaContainerTracking.validateResult,
    // Direct-login pilot (2026-09-23 urgent fix - operator on-site, this
    // capability's runtime-relay path was actively failing in production:
    // "Cannot access contents of the page. Extension manifest must request
    // permission to access the respective host." - see
    // grafanaContainerTrackingDirect.js's own header comment). Uses
    // grafanaAuth.js's existing SHARED single Grafana login (already
    // verified live for GET_GRAFANA_LOCKED_TOTES/_SUPERVISOR_DUMP) - no new
    // credential, no runtime/browser-tab session required.
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaContainerTrackingDirect.execute(appUserId, payload, signal),
  },
  // Bulk Inventory Check (2026-10-01, operator-requested: "put bulk tote and
  // I will get the barcode details") - given a bulk list of base tote IDs,
  // returns every per-partition barcode/SKU row for each in one request -
  // see grafanaToteInventoryCheck.js. Built DIRECT-ONLY from the start (no
  // runtime/buildPayload-only path was ever needed) - every other Grafana
  // capability's own runtime-relay path is already known broken in
  // production this week (see GET_GRAFANA_CONTAINER_TRACKING's own comment
  // above), so there was nothing working left to port FROM.
  GET_GRAFANA_TOTE_INVENTORY_CHECK: {
    name: "GET_GRAFANA_TOTE_INVENTORY_CHECK",
    minProtocolVersion: 1,
    readOnly: true,
    write: false,
    hostAllowList: [config.grafanaOrigin],
    timeoutMs: config.grafanaToteInventoryCheckCapabilityTimeoutMs,
    cancellationSupported: true,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: "CAPABILITY_GET_GRAFANA_TOTE_INVENTORY_CHECK",
    buildPayload: (params) => grafanaToteInventoryCheck.buildPayload(config.grafanaOrigin, params),
    validateResult: grafanaToteInventoryCheck.validateResult,
    authService: "grafana",
    directExecute: (appUserId, payload, signal) => grafanaToteInventoryCheckDirect.execute(appUserId, payload, signal),
  },
};

function getCapability(name) {
  return CAPABILITIES[name] || null;
}

function listCapabilityNames() {
  return Object.keys(CAPABILITIES);
}

module.exports = { getCapability, listCapabilityNames };
