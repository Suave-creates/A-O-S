// Unit tests for server/features/tracker/trackerEngine.js - orchestration only (the
// reconciliation math itself is covered directly in trackerReconcile.test.js).
// requestCapability/wait/getResult/qm are all injected fakes - no real
// capability dispatch, no runtime, no network, no real MySQL call.

const test = require("node:test");
const assert = require("node:assert/strict");
const trackerEngine = require("../../../features/tracker/trackerEngine");

const USER = { id: 1, employeeId: "EMP001", role: "USER" };

function makeFakeQueryManager() {
  const calls = [];
  return {
    calls,
    async markRunning(queryId) { calls.push({ fn: "markRunning", queryId }); },
    async completeQuery(queryId) { calls.push({ fn: "completeQuery", queryId }); },
    async failQuery(queryId, error) { calls.push({ fn: "failQuery", queryId, error }); },
    registerJob(queryId, controller) {
      calls.push({ fn: "registerJob", queryId });
      return { signal: controller.signal, wasCancelledByUser: () => false };
    },
    unregisterJob(queryId) { calls.push({ fn: "unregisterJob", queryId }); },
  };
}

function makeFakeCapabilities(resultsByCapability) {
  const dispatched = [];
  let n = 0;
  const resultsByQueryId = {};
  return {
    dispatched,
    requestCapability: async ({ capabilityName, params }) => {
      dispatched.push({ capabilityName, params });
      n++;
      const queryId = `CAP-${n}`;
      resultsByQueryId[queryId] = resultsByCapability[capabilityName];
      return { ok: true, query: { query_id: queryId } };
    },
    wait: async (queryId) => ({ query_id: queryId, status: "COMPLETED" }),
    getResult: (queryId) => resultsByQueryId[queryId],
  };
}

test("run(): an all-On-Location result never dispatches tracker history, Quadron, or NexS", async () => {
  const fake = makeFakeCapabilities({
    GET_GRAFANA_TOTE_FINDER: { finderRows: [{ tracker: "T1", container: "TL0000000001", location: "007-01", lane: "L1", updated_timestamp: "x" }], scanRows: [] },
  });
  const qm = makeFakeQueryManager();
  const result = await trackerEngine.run({
    queryId: "Q-1", user: USER, totes: ["TL0000000001"], facility: "NXS1",
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });
  assert.equal(fake.dispatched.length, 1, "only the finder capability should be dispatched");
  assert.equal(result.rows[0].status, "On Location");
});

test("run(): a Bad Tracker result dispatches GET_GRAFANA_TRACKER_HISTORY for its tracker id, and applies lastGood", async () => {
  const fake = makeFakeCapabilities({
    GET_GRAFANA_TOTE_FINDER: { finderRows: [{ tracker: "TR1", container: "TL0000000001", location: "ASRS_BT_1", lane: "L1", updated_timestamp: "x" }], scanRows: [] },
    GET_GRAFANA_TRACKER_HISTORY: { rows: [{ tracker: "TR1", destination: "007-05", rn: 2 }] },
  });
  const qm = makeFakeQueryManager();
  const result = await trackerEngine.run({
    queryId: "Q-2", user: USER, totes: ["TL0000000001"], facility: "NXS1",
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });
  const historyCall = fake.dispatched.find((d) => d.capabilityName === "GET_GRAFANA_TRACKER_HISTORY");
  assert.ok(historyCall);
  assert.deepEqual(historyCall.params.trackers, ["TR1"]);
  assert.equal(result.rows[0].lastGood, "007-05");
});

test("run(): an Outside Tote result dispatches Quadron then NexS blocked-inventory-batch for its SKUs", async () => {
  const fake = makeFakeCapabilities({
    GET_GRAFANA_TOTE_FINDER: { finderRows: [{ tracker: "T1", container: "TL0000000001", location: "OUTBOUND_1", lane: "L1", updated_timestamp: "x" }], scanRows: [] },
    GET_QUADRON_INVENTORY: { rows: [{ toteId: "TL0000000001", partitions: [{ part: 1, sku: "SKU_A" }] }] },
    GET_NEXS_BLOCKED_INVENTORY_BATCH: { results: [{ pid: "SKU_A", status: "ok", blockedInventory: 5 }] },
  });
  const qm = makeFakeQueryManager();
  const result = await trackerEngine.run({
    queryId: "Q-3", user: USER, totes: ["TL0000000001"], facility: "NXS1",
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });
  const nexsCall = fake.dispatched.find((d) => d.capabilityName === "GET_NEXS_BLOCKED_INVENTORY_BATCH");
  assert.deepEqual(nexsCall.params.pids, ["SKU_A"]);
  assert.equal(result.rows[0].blocked, 5);
});

test("run(): a candidate tote with no resolvable SKUs at all never dispatches NexS (nothing to look up)", async () => {
  const fake = makeFakeCapabilities({
    GET_GRAFANA_TOTE_FINDER: { finderRows: [{ tracker: "T1", container: "TL0000000001", location: "OUTBOUND_1", lane: "L1", updated_timestamp: "x" }], scanRows: [] },
    GET_QUADRON_INVENTORY: { rows: [] }, // tote not found in Quadron at all
  });
  const qm = makeFakeQueryManager();
  const result = await trackerEngine.run({
    queryId: "Q-4", user: USER, totes: ["TL0000000001"], facility: "NXS1",
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });
  assert.ok(!fake.dispatched.some((d) => d.capabilityName === "GET_NEXS_BLOCKED_INVENTORY_BATCH"));
  assert.equal(result.rows[0].blocked, null);
});

test("run(): registers/unregisters the Query Manager job, completes on success", async () => {
  const fake = makeFakeCapabilities({ GET_GRAFANA_TOTE_FINDER: { finderRows: [], scanRows: [] } });
  const qm = makeFakeQueryManager();
  await trackerEngine.run({
    queryId: "Q-5", user: USER, totes: ["TL0000000001"], facility: "NXS1",
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });
  assert.deepEqual(qm.calls.map((c) => c.fn), ["registerJob", "markRunning", "completeQuery", "unregisterJob"]);
});

test("run(): a capability dispatch failure fails the query and rethrows", async () => {
  const qm = makeFakeQueryManager();
  await assert.rejects(
    trackerEngine.run({
      queryId: "Q-6", user: USER, totes: ["TL0000000001"], facility: "NXS1",
      requestCapability: async () => ({ ok: false, code: 503, reason: "No online runtime" }),
      wait: async () => ({ status: "COMPLETED" }),
      getResult: () => null,
      qm,
    }),
    /No online runtime/
  );
  assert.ok(qm.calls.some((c) => c.fn === "failQuery"));
});

test("run(): a non-COMPLETED terminal status fails the query", async () => {
  const qm = makeFakeQueryManager();
  await assert.rejects(
    trackerEngine.run({
      queryId: "Q-7", user: USER, totes: ["TL0000000001"], facility: "NXS1",
      requestCapability: async () => ({ ok: true, query: { query_id: "X" } }),
      wait: async () => ({ status: "TIMEOUT" }),
      getResult: () => null,
      qm,
    }),
    /TIMEOUT/
  );
});

test("validateTotes: rejects an empty/missing list and any tote id that doesn't match TL/TS + 10 digits", () => {
  assert.equal(trackerEngine.validateTotes([]).ok, false);
  assert.equal(trackerEngine.validateTotes(undefined).ok, false);
  assert.equal(trackerEngine.validateTotes(["not-a-tote"]).ok, false);
  assert.equal(trackerEngine.validateTotes(["TL0000000001"]).ok, true);
});

// ── runAuto() ────────────────────────────────────────────────────────────

test("runAuto(): no Location=OUT candidates at all short-circuits before dispatching the finder", async () => {
  const fake = makeFakeCapabilities({
    GET_GRAFANA_CONTAINER_TRACKING: { rows: [{ container: "TL0000000001", location: "007-01" }] },
  });
  const qm = makeFakeQueryManager();
  const result = await trackerEngine.runAuto({
    queryId: "A-1", user: USER, facility: "NXS1",
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });
  assert.equal(fake.dispatched.length, 1, "only the container-tracking capability should be dispatched");
  assert.deepEqual(result, { rows: [], fetchedAt: result.fetchedAt, discovered: 0, stale: 0 });
});

test("runAuto(): a candidate whose finder timestamp is NOT yet 12h stale is discovered but excluded from the final list", async () => {
  // filterStaleByFinder treats updated_timestamp's raw digits as this
  // facility's IST wall-clock (Grafana quirk - see istTimestamp.js) and
  // corrects by -5.5h before comparing to a true-UTC cutoff. To fabricate a
  // "genuinely right now" fixture under that model, the raw digits fed in
  // must be true-now + 5.5h (so the -5.5h correction lands back on true
  // now) - not a literal new Date().toISOString(), which would be
  // misread as 5.5h in the past post-correction.
  const rightNowAsRawIstDigits = new Date(Date.now() + 5.5 * 3600000).toISOString();
  const fake = makeFakeCapabilities({
    GET_GRAFANA_CONTAINER_TRACKING: { rows: [{ container: "TL0000000001", location: "OUT" }] },
    GET_GRAFANA_TOTE_FINDER: { finderRows: [{ tracker: "T1", container: "TL0000000001", location: "OUT", lane: "L1", updated_timestamp: rightNowAsRawIstDigits }], scanRows: [] },
  });
  const qm = makeFakeQueryManager();
  const result = await trackerEngine.runAuto({
    queryId: "A-2", user: USER, facility: "NXS1",
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });
  assert.equal(result.discovered, 1);
  assert.equal(result.stale, 0);
  assert.deepEqual(result.rows, []);
  assert.ok(!fake.dispatched.some((d) => d.capabilityName === "GET_QUADRON_INVENTORY"), "never classifies past the finder step when nothing is stale");
});

test("runAuto(): a stale Location=OUT candidate is reclassified through the same depth run() uses, plus the merged container-tracking fields", async () => {
  // Same raw-IST-digits-vs-true-UTC correction as the test above: to encode
  // a TRUE age of 13h under the corrected model, the raw digits fed in must
  // be (true-now - 13h) + 5.5h, not a literal 13h-ago ISO string.
  const staleTimestamp = new Date(Date.now() - 13 * 3600000 + 5.5 * 3600000).toISOString();
  const fake = makeFakeCapabilities({
    GET_GRAFANA_CONTAINER_TRACKING: {
      rows: [{ container: "TL0000000001", location: "OUT", zone: "aisle_03_zone_03", shuttle: "QD_Shuttle_03_03", shuttleHealthStatus: "HEALTHY", stockCheckBlocked: "NO", binBlocked: "NO", badTracker: "NO" }],
    },
    GET_GRAFANA_TOTE_FINDER: { finderRows: [{ tracker: "T1", container: "TL0000000001", location: "OUT", lane: "L1", updated_timestamp: staleTimestamp }], scanRows: [] },
    GET_QUADRON_INVENTORY: { rows: [{ toteId: "TL0000000001", partitions: [{ part: 1, sku: "SKU_A" }] }] },
    GET_NEXS_BLOCKED_INVENTORY_BATCH: { results: [{ pid: "SKU_A", status: "ok", blockedInventory: 2 }] },
  });
  const qm = makeFakeQueryManager();
  const result = await trackerEngine.runAuto({
    queryId: "A-3", user: USER, facility: "NXS1",
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });
  assert.equal(result.discovered, 1);
  assert.equal(result.stale, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].status, "Outside Tote");
  assert.equal(result.rows[0].blocked, 2, "the exact same Quadron/NexS depth run() uses");
  assert.equal(result.rows[0].zone, "aisle_03_zone_03");
  assert.equal(result.rows[0].shuttleHealthStatus, "HEALTHY");
});

test("runAuto(): dispatches GET_GRAFANA_TOTE_FINDER sequentially in chunks of FINDER_CHUNK_SIZE, never all at once", async () => {
  const chunkSize = trackerEngine.FINDER_CHUNK_SIZE;
  const containerRows = Array.from({ length: chunkSize + 1 }, (_, i) => ({ container: `TL${String(i).padStart(10, "0")}`, location: "OUT" }));
  const fake = makeFakeCapabilities({ GET_GRAFANA_CONTAINER_TRACKING: { rows: containerRows } });
  // Every finder chunk resolves with no rows at all - nothing survives staleness filtering, but the dispatch count is what this test checks.
  const qm = makeFakeQueryManager();
  await trackerEngine.runAuto({
    queryId: "A-4", user: USER, facility: "NXS1",
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });
  const finderDispatches = fake.dispatched.filter((d) => d.capabilityName === "GET_GRAFANA_TOTE_FINDER");
  assert.equal(finderDispatches.length, 2, "chunkSize+1 candidates must split into 2 sequential finder dispatches");
  assert.equal(finderDispatches[0].params.totes.length, chunkSize);
  assert.equal(finderDispatches[1].params.totes.length, 1);
});

test("runAuto(): registers/unregisters the Query Manager job, completes on success", async () => {
  const fake = makeFakeCapabilities({ GET_GRAFANA_CONTAINER_TRACKING: { rows: [] } });
  const qm = makeFakeQueryManager();
  await trackerEngine.runAuto({
    queryId: "A-5", user: USER, facility: "NXS1",
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });
  assert.deepEqual(qm.calls.map((c) => c.fn), ["registerJob", "markRunning", "completeQuery", "unregisterJob"]);
});

test("runAuto(): a capability dispatch failure fails the query and rethrows", async () => {
  const qm = makeFakeQueryManager();
  await assert.rejects(
    trackerEngine.runAuto({
      queryId: "A-6", user: USER, facility: "NXS1",
      requestCapability: async () => ({ ok: false, code: 503, reason: "No online runtime" }),
      wait: async () => ({ status: "COMPLETED" }),
      getResult: () => null,
      qm,
    }),
    /No online runtime/
  );
  assert.ok(qm.calls.some((c) => c.fn === "failQuery"));
});
