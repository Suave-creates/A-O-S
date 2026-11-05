// Unit tests for server/features/cng-validator/cngValidator.js - orchestration only (the
// verdict math itself is covered directly in cngReconcile.test.js).
// requestCapability/wait/getResult/qm are all injected fakes - no real
// capability dispatch, no runtime, no network, no real MySQL call.

const test = require("node:test");
const assert = require("node:assert/strict");
const cngValidator = require("../../../features/cng-validator/cngValidator");

const USER = { id: 1, employeeId: "EMP001", role: "USER" };

function makeFakeQueryManager() {
  const calls = [];
  return {
    calls,
    async markRunning(queryId) { calls.push({ fn: "markRunning", queryId }); },
    async completeQuery(queryId) { calls.push({ fn: "completeQuery", queryId }); },
    async failQuery(queryId, error) { calls.push({ fn: "failQuery", queryId, error }); },
    async finalizeCancelled(queryId) { calls.push({ fn: "finalizeCancelled", queryId }); },
    async cancelQuery(innerQueryId) { calls.push({ fn: "cancelQuery", innerQueryId }); },
    registerJob(queryId, controller) {
      calls.push({ fn: "registerJob", queryId });
      return { signal: controller.signal, wasCancelledByUser: () => false };
    },
    unregisterJob(queryId) { calls.push({ fn: "unregisterJob", queryId }); },
  };
}

// Builds a fake requestCapability/wait/getResult trio that resolves each of
// the 3 real capabilities to caller-supplied canned results, tracking which
// capabilities were actually dispatched (and with what params).
function makeFakeCapabilities({ quadronRows = [], grafanaRows = [], nexsResults = [] } = {}) {
  const dispatched = [];
  let n = 0;
  const resultsByQueryId = {};
  return {
    dispatched,
    requestCapability: async ({ capabilityName, params }) => {
      dispatched.push({ capabilityName, params });
      n++;
      const queryId = `CAP-${n}`;
      if (capabilityName === "GET_QUADRON_INVENTORY") resultsByQueryId[queryId] = { rows: quadronRows };
      if (capabilityName === "GET_GRAFANA_TOTE_PARTITION_COUNTS") resultsByQueryId[queryId] = { rows: grafanaRows };
      if (capabilityName === "GET_NEXS_DISCREPANCY_REPORT_BATCH") resultsByQueryId[queryId] = { results: nexsResults };
      return { ok: true, query: { query_id: queryId } };
    },
    wait: async (queryId) => ({ query_id: queryId, status: "COMPLETED" }),
    getResult: (queryId) => resultsByQueryId[queryId],
  };
}

test("run(): dispatches Quadron and Grafana in parallel, then NexS for exactly the union of partitions found", async () => {
  const fake = makeFakeCapabilities({
    quadronRows: [{ toteId: "TS0000018492", quadronQty: 5, partitions: [{ part: 1, qty: 5, sku: "SKU1" }] }],
    grafanaRows: [{ container: "TS0000018492-1", qty: 5 }],
    nexsResults: [{ base: "TS0000018492", part: 1, status: "ok", imsCount: 5, error: null }],
  });
  const qm = makeFakeQueryManager();

  const result = await cngValidator.run({
    queryId: "Q-1", user: USER, totes: ["TS0000018492"], facility: "NXS1",
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });

  const names = fake.dispatched.map((d) => d.capabilityName);
  assert.ok(names.includes("GET_QUADRON_INVENTORY"));
  assert.ok(names.includes("GET_GRAFANA_TOTE_PARTITION_COUNTS"));
  assert.ok(names.includes("GET_NEXS_DISCREPANCY_REPORT_BATCH"));
  const nexsCall = fake.dispatched.find((d) => d.capabilityName === "GET_NEXS_DISCREPANCY_REPORT_BATCH");
  assert.deepEqual(nexsCall.params.items, [{ base: "TS0000018492", part: 1 }]);
  assert.deepEqual(nexsCall.params.facilityCode, "NXS1");

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].verdict, "MATCH");
  assert.ok(result.fetchedAt);
});

test("run(): focusMode dispatches NexS for every possible partition even when Quadron and Grafana reveal none", async () => {
  const fake = makeFakeCapabilities({
    quadronRows: [],
    grafanaRows: [],
    nexsResults: [{ base: "TL0000002995", part: 3, status: "ok", imsCount: 12, error: null }],
  });
  const qm = makeFakeQueryManager();

  const result = await cngValidator.run({
    queryId: "Q-FOCUS", user: USER, totes: ["TL0000002995"], facility: "NXS1", focusMode: true,
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });

  const nexsCall = fake.dispatched.find((d) => d.capabilityName === "GET_NEXS_DISCREPANCY_REPORT_BATCH");
  assert.ok(nexsCall, "NexS must be dispatched in focusMode even with nothing from Quadron/Grafana");
  assert.equal(nexsCall.params.items.length, 8, "TL totes get all 8 partitions swept");

  assert.equal(result.rows[0].nexs, 12);
  assert.equal(result.rows[0].verdict, "PARTIAL");
});

test("run(): when Quadron and Grafana reveal no partitions at all, NexS is never dispatched", async () => {
  const fake = makeFakeCapabilities({ quadronRows: [], grafanaRows: [] });
  const qm = makeFakeQueryManager();

  const result = await cngValidator.run({
    queryId: "Q-2", user: USER, totes: ["TS0000018492"], facility: "NXS1",
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });

  assert.ok(!fake.dispatched.some((d) => d.capabilityName === "GET_NEXS_DISCREPANCY_REPORT_BATCH"));
  assert.equal(result.rows[0].verdict, "MISSING");
});

test("run(): registers/unregisters the Query Manager job, completes on success", async () => {
  const fake = makeFakeCapabilities({
    quadronRows: [{ toteId: "TS0000018492", quadronQty: 5, partitions: [{ part: 1, qty: 5, sku: "SKU1" }] }],
    grafanaRows: [],
    nexsResults: [{ base: "TS0000018492", part: 1, status: "ok", imsCount: 5, error: null }],
  });
  const qm = makeFakeQueryManager();
  await cngValidator.run({
    queryId: "Q-3", user: USER, totes: ["TS0000018492"], facility: "NXS1",
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });
  assert.deepEqual(qm.calls.map((c) => c.fn), ["registerJob", "markRunning", "completeQuery", "unregisterJob"]);
});

test("run(): Quadron dispatch failure fails the query and rethrows - Grafana/NexS are never consulted for a fabricated result", async () => {
  const qm = makeFakeQueryManager();
  await assert.rejects(
    cngValidator.run({
      queryId: "Q-4", user: USER, totes: ["TS0000018492"], facility: "NXS1",
      requestCapability: async ({ capabilityName }) =>
        capabilityName === "GET_QUADRON_INVENTORY" ? { ok: false, code: 503, reason: "No online runtime" } : { ok: true, query: { query_id: "X" } },
      wait: async () => ({ status: "COMPLETED" }),
      getResult: () => ({ rows: [] }),
      qm,
    }),
    /No online runtime/
  );
  assert.ok(qm.calls.some((c) => c.fn === "failQuery"));
  assert.ok(!qm.calls.some((c) => c.fn === "completeQuery"));
});

test("run(): a non-COMPLETED terminal status on any of the 3 capabilities fails the query, never silently substitutes empty data", async () => {
  const qm = makeFakeQueryManager();
  await assert.rejects(
    cngValidator.run({
      queryId: "Q-5", user: USER, totes: ["TS0000018492"], facility: "NXS1",
      requestCapability: async () => ({ ok: true, query: { query_id: "X" } }),
      wait: async () => ({ status: "TIMEOUT" }),
      getResult: () => null,
      qm,
    }),
    /TIMEOUT/
  );
  assert.ok(qm.calls.some((c) => c.fn === "failQuery"));
});

// Regression coverage for the bug this pass fixed (operator-reported:
// Q-001900 stuck with no way to cancel). Simulates a cancel arriving while
// the NexS batch dispatch is the one currently in flight (the same stage
// that actually ran long in production) and verifies: (1) the in-flight
// inner query is itself cancelled via qm.cancelQuery(), not just the outer
// wrapper's own status flipped, and (2) the outer query finalizes as
// CANCELLED (finalizeCancelled), never FAILED, for a genuine user cancel.
test("run(): a cancel that arrives while a capability dispatch is in flight cascades a real cancel to that inner query and finalizes CANCELLED", async () => {
  const calls = [];
  let cancelledByUser = false;
  let capturedController = null;
  const cancelledInnerIds = [];
  const qm = {
    async markRunning(queryId) { calls.push({ fn: "markRunning", queryId }); },
    async completeQuery(queryId) { calls.push({ fn: "completeQuery", queryId }); },
    async failQuery(queryId, error) { calls.push({ fn: "failQuery", queryId, error }); },
    async finalizeCancelled(queryId) { calls.push({ fn: "finalizeCancelled", queryId }); },
    async cancelQuery(innerId) { cancelledInnerIds.push(innerId); },
    registerJob(queryId, controller) {
      calls.push({ fn: "registerJob", queryId });
      capturedController = controller;
      return { signal: controller.signal, wasCancelledByUser: () => cancelledByUser };
    },
    unregisterJob(queryId) { calls.push({ fn: "unregisterJob", queryId }); },
  };

  let releaseNexsWait;
  const nexsWaitGate = new Promise((resolve) => { releaseNexsWait = resolve; });

  const requestCapability = async ({ capabilityName }) => {
    if (capabilityName === "GET_QUADRON_INVENTORY") return { ok: true, query: { query_id: "CAP-Q" } };
    if (capabilityName === "GET_GRAFANA_TOTE_PARTITION_COUNTS") return { ok: true, query: { query_id: "CAP-G" } };
    if (capabilityName === "GET_NEXS_DISCREPANCY_REPORT_BATCH") return { ok: true, query: { query_id: "CAP-N" } };
    throw new Error("unexpected capability " + capabilityName);
  };
  const wait = async (queryId) => {
    if (queryId === "CAP-N") {
      // The cancel "arrives" (mirrors queryManager.cancelQuery() setting
      // cancelledByUser=true THEN calling controller.abort()) while this
      // dispatch is the one still pending.
      cancelledByUser = true;
      capturedController.abort();
      await nexsWaitGate;
      return { query_id: queryId, status: "CANCELLED" };
    }
    return { query_id: queryId, status: "COMPLETED" };
  };
  const getResult = (queryId) => {
    if (queryId === "CAP-Q") return { rows: [{ toteId: "TS0000018492", quadronQty: 5, partitions: [{ part: 1, qty: 5, sku: "SKU1" }] }] };
    if (queryId === "CAP-G") return { rows: [] };
    return null;
  };

  const runPromise = cngValidator.run({
    queryId: "Q-CANCEL", user: USER, totes: ["TS0000018492"], facility: "NXS1",
    requestCapability, wait, getResult, qm,
  });

  await new Promise((r) => setTimeout(r, 10)); // let the NexS dispatch actually reach its wait()
  releaseNexsWait();

  await assert.rejects(runPromise);
  assert.ok(cancelledInnerIds.includes("CAP-N"), "the in-flight NexS query should itself be cancelled, not just the outer wrapper's status flipped");
  assert.ok(calls.some((c) => c.fn === "finalizeCancelled"), "a genuine user cancel finalizes CANCELLED");
  assert.ok(!calls.some((c) => c.fn === "failQuery"), "never FAILED for a user-requested cancel");
});

test("validateTotes: rejects an empty/missing list and any tote id that doesn't match TL/TS + 10 digits", () => {
  assert.equal(cngValidator.validateTotes([]).ok, false);
  assert.equal(cngValidator.validateTotes(undefined).ok, false);
  assert.equal(cngValidator.validateTotes(["not-a-tote"]).ok, false);
  assert.equal(cngValidator.validateTotes(["TS0000018492"]).ok, true);
});
