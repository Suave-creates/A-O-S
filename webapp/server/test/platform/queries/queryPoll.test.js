// Unit tests for server/platform/queries/queryPoll.js's maxConfiguredCapabilityTimeoutMs()
// - the local safety-net deadline waitForTerminal() uses. Pure config-math,
// no DB, no network, no real query polling (which would need the deadline's
// own ~10s+ buffer to elapse to observe - out of proportion for a unit
// test; this function is what actually changed, and is tested directly).

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../../../config");
const { maxConfiguredCapabilityTimeoutMs } = require("../../../platform/queries/queryPoll");

function withConfig(overrides, fn) {
  const original = {};
  for (const key of Object.keys(overrides)) original[key] = config[key];
  Object.assign(config, overrides);
  try {
    return fn();
  } finally {
    Object.assign(config, original);
  }
}

test("returns the largest of every configured capability timeout, not one hardcoded family", () => {
  withConfig(
    { grafanaCapabilityTimeoutMs: 1000, quadronCapabilityTimeoutMs: 2000, quadronInventoryCapabilityTimeoutMs: 2000, nexsCapabilityTimeoutMs: 90000, appsScriptTimeoutMs: 3000 },
    () => {
      assert.equal(
        maxConfiguredCapabilityTimeoutMs(),
        90000,
        "must track whichever capability family has the largest configured timeout, not stay pinned to Quadron's"
      );
    }
  );
});

test("regression: previously hardcoded to quadronCapabilityTimeoutMs alone - a smaller Quadron timeout than NexS's must not shrink the shared bound", () => {
  withConfig({ quadronCapabilityTimeoutMs: 5000, quadronInventoryCapabilityTimeoutMs: 5000, nexsCapabilityTimeoutMs: 60000 }, () => {
    assert.ok(
      maxConfiguredCapabilityTimeoutMs() >= 60000,
      "the shared local deadline must be bounded by the SLOWEST configured capability, so a future NEXS batch timeout increase (see registry.js's own comment) is never silently undercut by Quadron's separate config value"
    );
  });
});

test("Quadron's own timeout alone still determines the bound when it happens to be the largest (today's actual configuration - all three default to 30000ms)", () => {
  withConfig(
    {
      grafanaCapabilityTimeoutMs: 10000,
      quadronCapabilityTimeoutMs: 30000, quadronInventoryCapabilityTimeoutMs: 30000,
      nexsCapabilityTimeoutMs: 15000,
      appsScriptTimeoutMs: 15000,
      nexsBlockedInventoryBatchCapabilityTimeoutMs: 15000,
      grafanaCcMetricsCapabilityTimeoutMs: 15000,
      grafanaTotePartitionCountsCapabilityTimeoutMs: 15000,
      nexsDiscrepancyReportBatchCapabilityTimeoutMs: 15000,
      grafanaToteFinderCapabilityTimeoutMs: 15000,
      grafanaTrackerHistoryCapabilityTimeoutMs: 15000,
    },
    () => {
      assert.equal(maxConfiguredCapabilityTimeoutMs(), 30000);
    }
  );
});

test("Phase 6: includes the dedicated NEXS batch capability timeout - the shared local deadline must never undercut the batch's own, independently-configured (and now larger) timeout", () => {
  withConfig(
    { grafanaCapabilityTimeoutMs: 10000, quadronCapabilityTimeoutMs: 30000, quadronInventoryCapabilityTimeoutMs: 30000, nexsCapabilityTimeoutMs: 30000, appsScriptTimeoutMs: 30000, nexsBlockedInventoryBatchCapabilityTimeoutMs: 60000, grafanaCcMetricsCapabilityTimeoutMs: 30000 },
    () => {
      assert.equal(maxConfiguredCapabilityTimeoutMs(), 60000);
    }
  );
});

// Phase FINAL: includes the dedicated GET_GRAFANA_CC_METRICS timeout - same
// reasoning as the NEXS batch test above (this capability runs 6 real
// Grafana queries per execution, not 1 - see config.js's own comment on
// grafanaCcMetricsCapabilityTimeoutMs, added after live verification hit the
// shared 30s ceiling on the very first real Dashboard attempt).
test("Phase FINAL: includes the dedicated GET_GRAFANA_CC_METRICS timeout - the shared local deadline must never undercut its own, independently-configured (and now largest) timeout", () => {
  withConfig(
    { grafanaCapabilityTimeoutMs: 10000, quadronCapabilityTimeoutMs: 30000, quadronInventoryCapabilityTimeoutMs: 30000, nexsCapabilityTimeoutMs: 30000, appsScriptTimeoutMs: 30000, nexsBlockedInventoryBatchCapabilityTimeoutMs: 60000, grafanaCcMetricsCapabilityTimeoutMs: 90000 },
    () => {
      assert.equal(maxConfiguredCapabilityTimeoutMs(), 90000);
    }
  );
});

test("with today's real defaults (30s everywhere except 60s NEXS batch / 60s CC metrics), the bound is 60000ms", () => {
  const config = require("../../../config");
  assert.equal(config.nexsBlockedInventoryBatchCapabilityTimeoutMs, 60000);
  assert.equal(config.grafanaCcMetricsCapabilityTimeoutMs, 60000);
  assert.equal(maxConfiguredCapabilityTimeoutMs(), 60000);
});

// CNG Inv Validator: includes the two new dedicated timeouts - same reasoning
// as every other batched-item capability above (a many-tote/many-partition
// execution must never be undercut by the shared local deadline).
test("CNG Validator: includes the dedicated Grafana tote-partition-counts timeout when it's the largest", () => {
  withConfig(
    {
      grafanaCapabilityTimeoutMs: 10000,
      quadronCapabilityTimeoutMs: 30000, quadronInventoryCapabilityTimeoutMs: 30000,
      nexsCapabilityTimeoutMs: 30000,
      appsScriptTimeoutMs: 30000,
      nexsBlockedInventoryBatchCapabilityTimeoutMs: 30000,
      grafanaCcMetricsCapabilityTimeoutMs: 30000,
      grafanaTotePartitionCountsCapabilityTimeoutMs: 90000,
      nexsDiscrepancyReportBatchCapabilityTimeoutMs: 30000,
    },
    () => {
      assert.equal(maxConfiguredCapabilityTimeoutMs(), 90000);
    }
  );
});

test("CNG Validator: includes the dedicated NexS discrepancy-report-batch timeout when it's the largest", () => {
  withConfig(
    {
      grafanaCapabilityTimeoutMs: 10000,
      quadronCapabilityTimeoutMs: 30000, quadronInventoryCapabilityTimeoutMs: 30000,
      nexsCapabilityTimeoutMs: 30000,
      appsScriptTimeoutMs: 30000,
      nexsBlockedInventoryBatchCapabilityTimeoutMs: 30000,
      grafanaCcMetricsCapabilityTimeoutMs: 30000,
      grafanaTotePartitionCountsCapabilityTimeoutMs: 30000,
      nexsDiscrepancyReportBatchCapabilityTimeoutMs: 90000,
    },
    () => {
      assert.equal(maxConfiguredCapabilityTimeoutMs(), 90000);
    }
  );
});

test("includes the Quadron inventory dump's own timeout - the shared local deadline must never undercut it", () => {
  withConfig(
    {
      grafanaCapabilityTimeoutMs: 10000,
      quadronCapabilityTimeoutMs: 30000,
      quadronInventoryCapabilityTimeoutMs: 95000,
      nexsCapabilityTimeoutMs: 30000,
      appsScriptTimeoutMs: 30000,
      nexsBlockedInventoryBatchCapabilityTimeoutMs: 60000,
      grafanaCcMetricsCapabilityTimeoutMs: 30000,
      grafanaTotePartitionCountsCapabilityTimeoutMs: 30000,
      nexsDiscrepancyReportBatchCapabilityTimeoutMs: 30000,
      grafanaToteFinderCapabilityTimeoutMs: 30000,
      grafanaTrackerHistoryCapabilityTimeoutMs: 30000,
    },
    () => {
      assert.equal(maxConfiguredCapabilityTimeoutMs(), 95000);
    }
  );
});
