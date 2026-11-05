// Pure unit coverage for server/platform/queries/cancellationSupport.js - no DB, no
// server, no network. See that file's own comment for the full reasoning
// behind which operations report true/false.

const test = require("node:test");
const assert = require("node:assert/strict");

const { isCancellationSupported } = require("../../../integrations/capabilities/cancellationSupport");

const CAPABILITY_OPERATIONS = [
  "GET_GRAFANA_LOCKED_TOTES",
  "GET_GRAFANA_SUPERVISOR_DUMP",
  "GET_QUADRON_INVENTORY",
  "PULL_QUADRON_TOTE",
  "GET_NEXS_BLOCKED_INVENTORY",
  "GET_GRAFANA_CC_METRICS",
];

const BACKEND_ONLY_OPERATIONS = [
  "TOTE_UTILISATION",
  "NEXS_ASRS_DUMP_REFRESH",
  "TOTE_PURGE_GENERATE",
  "PULL_QUADRON_TOTE_MANUAL_SESSION",
  // Dashboard's CC-metrics wrapper query (Phase FINAL) - registerJob() is
  // called only so reconcileStale() doesn't treat it as abandoned (same
  // reason as TOTE_UTILISATION/NEXS_ASRS_DUMP_REFRESH above); its
  // AbortController is never checked inside dashboardEngine.getCcMetrics()'s
  // body, so a Cancel here would be the same fake-cancel this whole
  // module's own comment warns against - correctly reported as unsupported.
  "DASHBOARD_CC_METRICS",
];

// Phase 7, Issue 1/2: AUTO_ENGINE_SESSION now has a real, verified
// registerJob()->AbortController->engine-stop path (see autoEngine.js's
// start()) and must report cancellation supported, same as any
// capability-backed operation.
//
// CNG_VALIDATOR_RUN (operator-reported: Q-001900 stuck on a slow
// GET_NEXS_DISCREPANCY_REPORT_BATCH batch with no way to cancel) now has
// the same kind of real wiring - cngValidator.js's run() tracks whichever
// inner capability quer(ies) are in flight and cascades a real
// queryManager.cancelQuery() to each of them on abort - see cngValidator.js
// and cancellationSupport.js's own comment for the full mechanism.
const CANCELLABLE_SESSION_OPERATIONS = ["AUTO_ENGINE_SESSION", "CNG_VALIDATOR_RUN"];

test("every capability-backed operation reports cancellation supported", () => {
  for (const op of CAPABILITY_OPERATIONS) {
    assert.equal(isCancellationSupported(op), true, `expected ${op} to be cancellable`);
  }
});

test("AUTO_ENGINE_SESSION and CNG_VALIDATOR_RUN report cancellation supported (real, verified stop/cancel wiring)", () => {
  for (const op of CANCELLABLE_SESSION_OPERATIONS) {
    assert.equal(isCancellationSupported(op), true, `expected ${op} to be cancellable`);
  }
});

test("backend-only operations without a verified real cancel path report unsupported", () => {
  for (const op of BACKEND_ONLY_OPERATIONS) {
    assert.equal(isCancellationSupported(op), false, `expected ${op} to be non-cancellable`);
  }
});

test("an unrecognized operation reports unsupported, never throws", () => {
  assert.equal(isCancellationSupported("SOME_MADE_UP_OPERATION"), false);
  assert.equal(isCancellationSupported(undefined), false);
  assert.equal(isCancellationSupported(null), false);
});
