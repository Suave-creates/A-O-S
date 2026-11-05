// Generic "poll a query row until it reaches a terminal status" helper -
// extracted out of quadronPull.js so read-only, non-mutating callers (e.g.
// server/features/locked-tote-info/classificationEngine.js) never need to import anything from a
// file named after pulling totes. Pure extraction: same behavior as before,
// just given a neutral home. quadronPull.js re-exports these for backward
// compatibility with its existing callers.

const config = require("../../config");
const queryManager = require("./queryManager");

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Local safety-net bound only - NOT the authoritative timeout for any one
// capability (capabilityManager.runCapability() already bounds actual
// execution to that specific capability's own timeoutMs via its own
// AbortSignal.timeout - see server/integrations/capabilities/registry.js). This helper
// is shared by every capability's provider (Grafana, Quadron, NexS
// single-PID and batch), so its local deadline must never be pinned to one
// capability family's config value - previously hardcoded to
// quadronCapabilityTimeoutMs, which only happened to work because every
// capability family's timeout defaulted to the same 30s value. Using the
// MAX of every configured capability timeout means this bound stays
// correct (never fires before the real, capability-specific timeout can)
// even after any one family's timeout is tuned independently - e.g. the
// NEXS batch capability, which will need a longer timeout than a
// single-PID lookup once Purge scales (see server/integrations/capabilities/registry.js's
// own comment on GET_NEXS_BLOCKED_INVENTORY_BATCH).
function maxConfiguredCapabilityTimeoutMs() {
  return Math.max(
    config.grafanaCapabilityTimeoutMs,
    config.quadronCapabilityTimeoutMs,
    config.quadronInventoryCapabilityTimeoutMs,
    config.nexsCapabilityTimeoutMs,
    config.nexsBlockedInventoryBatchCapabilityTimeoutMs,
    config.grafanaCcMetricsCapabilityTimeoutMs,
    config.grafanaTotePartitionCountsCapabilityTimeoutMs,
    config.nexsDiscrepancyReportBatchCapabilityTimeoutMs,
    config.grafanaToteFinderCapabilityTimeoutMs,
    config.grafanaTrackerHistoryCapabilityTimeoutMs,
    config.appsScriptTimeoutMs || 0
  );
}

// Polls the query row until it reaches a terminal status.
async function waitForTerminal(queryId, { pollMs = 300 } = {}) {
  const deadline = Date.now() + maxConfiguredCapabilityTimeoutMs() + 10000;
  for (;;) {
    const query = await queryManager.getQuery(queryId);
    if (!query) throw new Error(`Query ${queryId} not found while waiting for a terminal status`);
    if (TERMINAL_STATUSES.has(query.status)) return query;
    if (Date.now() > deadline) {
      throw new Error(`Timed out locally waiting for query ${queryId} to reach a terminal status`);
    }
    await sleep(pollMs);
  }
}

module.exports = { waitForTerminal, TERMINAL_STATUSES, maxConfiguredCapabilityTimeoutMs };
