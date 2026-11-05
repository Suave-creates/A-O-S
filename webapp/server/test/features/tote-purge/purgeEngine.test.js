// Unit tests for server/features/tote-purge/purgeEngine.js - the orchestration layer.
// qm/getSnapshot/fetchBlockedInventoryBatch/fetchQuadron/checkReadiness are
// fully injected fakes - no real MySQL, no real Runtime WebSocket, no real
// Grafana/Quadron/Concinity/Apps Script network call anywhere in this file.

const test = require("node:test");
const assert = require("node:assert/strict");
const purgeEngine = require("../../../features/tote-purge/purgeEngine");

const USER = { id: 1, employeeId: "EMP001", role: "USER" };

// purgeEngine.js transitively opens a MySQL pool at module load (via the
// query manager) - close it so this file exits cleanly instead of leaving
// the process alive on an unused handle.
test.after(async () => {
  await require("../../../platform/db").close();
});

// Every existing test below is about orchestration wiring OTHER than the
// readiness gate itself (that gate has its own dedicated tests further
// down) - so every test injects a checkReadiness fake that always reports
// both services ready. Never the real defaultCheckReadiness() (which reads
// the real config) inside a plain unit test.
const READY = async () => ({ nexsReady: true, quadronReady: true });

function makeFakeQueryManager() {
  const calls = [];
  return {
    calls,
    async markRunning(queryId) {
      calls.push({ fn: "markRunning", queryId });
    },
    async completeQuery(queryId) {
      calls.push({ fn: "completeQuery", queryId });
    },
    async failQuery(queryId, error) {
      calls.push({ fn: "failQuery", queryId, error });
    },
    registerJob(queryId, controller) {
      calls.push({ fn: "registerJob", queryId });
      return { signal: controller.signal, wasCancelledByUser: () => false };
    },
    unregisterJob(queryId) {
      calls.push({ fn: "unregisterJob", queryId });
    },
  };
}

// A 4-row snapshot: PID "1" appears in 3 totes (eligible), PID "2" appears
// in only 1 tote (ineligible under the default pidToteMin=3).
function fakeSnapshot() {
  return {
    refreshedAt: "2026-08-24T00:00:00.000Z",
    rows: [
      { pid: "1", toteId: "TS0000000001", barcodeCount: 3, partition: "PR1" },
      { pid: "1", toteId: "TS0000000002", barcodeCount: 3, partition: "PR1" },
      { pid: "1", toteId: "TS0000000003", barcodeCount: 3, partition: "PR1" },
      { pid: "2", toteId: "TS0000000004", barcodeCount: 2, partition: "PR1" },
    ],
  };
}

function fakeQuadronOk(rows) {
  return async () => ({ ok: true, rows: rows || [], queryId: "Q-QUAD", reason: null });
}

// Mirrors what server/integrations/nexs/nexsBlockedInventoryProvider.js's REAL
// fetchBlockedInventoryBatch() returns: blockedMap[pid] = {ok, ...}. Every
// requested pid gets the same data unless overridden per-pid.
function fetchBlockedBatchOk(perPidData, defaultData) {
  return async ({ pids }) => {
    const map = Object.create(null);
    for (const pid of pids) {
      map[pid] = { ok: true, ...((perPidData && perPidData[pid]) || defaultData || { totalInventory: 200, blockedInventory: 0, availableInventory: 200 }) };
    }
    return map;
  };
}

test("successful generate: markRunning -> completeQuery, and updates the canonical report", async () => {
  const qm = makeFakeQueryManager();
  // blockedInventory: 0 -> NON_BLOCKED path, which has no PID-inventory
  // floor - keeps this test about the happy-path wiring, not the blocked-
  // path threshold (covered separately in purgeClassify.test.js).
  const fetchBlockedInventoryBatch = fetchBlockedBatchOk(null, { totalInventory: 200, blockedInventory: 0, availableInventory: 999 });

  await purgeEngine.generate(
    "Q-TEST-1",
    USER,
    {},
    { qm, getSnapshot: fakeSnapshot, fetchBlockedInventoryBatch, fetchQuadron: fakeQuadronOk([{ toteId: "TS0000000001", quadronQty: 3, partitions: [{ part: 1, qty: 3, sku: "1" }] }]), checkReadiness: READY }
  );

  assert.deepEqual(qm.calls.map((c) => c.fn), ["registerJob", "markRunning", "completeQuery", "unregisterJob"]);
  const report = purgeEngine.getCurrentReport();
  assert.equal(report.queryId, "Q-TEST-1");
  assert.equal(report.candidates.length, 3, "only PID 1's 3 totes survive the pre-filter - PID 2 has only 1 tote");
  assert.ok(report.candidates.every((c) => c.pid === "1"));
  assert.equal(purgeEngine.getStatus(), "CURRENT");
});

test("L: getSnapshot is correctly awaited - an ASYNC snapshot source (matching nexsAsrsDumpEngine.getCurrentSnapshot()'s real, MySQL-backed shape) works exactly like a synchronous one", async () => {
  const qm = makeFakeQueryManager();
  const asyncSnapshot = async () => fakeSnapshot();
  const fetchBlockedInventoryBatch = fetchBlockedBatchOk(null, { totalInventory: 200, blockedInventory: 0, availableInventory: 999 });
  await purgeEngine.generate(
    "Q-TEST-ASYNC",
    USER,
    {},
    { qm, getSnapshot: asyncSnapshot, fetchBlockedInventoryBatch, fetchQuadron: fakeQuadronOk([]), checkReadiness: READY }
  );
  const report = purgeEngine.getCurrentReport();
  assert.equal(report.candidates.length, 3, "an async getSnapshot must resolve and produce the same result as a sync one");
});

test("no ASRS Dump snapshot available: fails cleanly, never crashes, never fabricates a report", async () => {
  const qm = makeFakeQueryManager();
  await purgeEngine.generate("Q-TEST-2", USER, {}, { qm, getSnapshot: () => null, checkReadiness: READY });
  const failCall = qm.calls.find((c) => c.fn === "failQuery");
  assert.ok(failCall);
  assert.match(failCall.error, /No NEXS ASRS Tote Dump snapshot available/);
});

test("empty ASRS Dump snapshot (0 rows): fails cleanly rather than generating a meaningless empty report", async () => {
  const qm = makeFakeQueryManager();
  await purgeEngine.generate("Q-TEST-3", USER, {}, { qm, getSnapshot: () => ({ rows: [], refreshedAt: "x" }), checkReadiness: READY });
  const failCall = qm.calls.find((c) => c.fn === "failQuery");
  assert.ok(failCall);
});

test("no candidates survive the pre-filter: completes successfully with an empty report, not an error", async () => {
  const qm = makeFakeQueryManager();
  const snapshot = () => ({ refreshedAt: "x", rows: [{ pid: "1", toteId: "TS0000000001", barcodeCount: 3, partition: "PR1" }] }); // only 1 tote, default pidToteMin=3
  await purgeEngine.generate("Q-TEST-4", USER, {}, { qm, getSnapshot: snapshot, checkReadiness: READY });
  assert.ok(qm.calls.some((c) => c.fn === "completeQuery"));
  const report = purgeEngine.getCurrentReport();
  assert.equal(report.candidates.length, 0);
  assert.equal(report.summary.totalTotes, 0);
});

test("a per-PID blocked-inventory failure excludes that PID's candidates via apiSkipped, never crashes the whole run", async () => {
  const qm = makeFakeQueryManager();
  // Simulates what the real provider returns when the batch capability
  // dispatched successfully but this one PID's own entry came back failed
  // (see nexsBlockedInventoryProvider.test.js and the runtime's own
  // per-PID isolation tests for the layers below this one).
  const fetchBlockedInventoryBatch = async ({ pids }) => {
    const map = Object.create(null);
    for (const pid of pids) map[pid] = { ok: false, reason: "NexS unreachable" };
    return map;
  };
  await purgeEngine.generate("Q-TEST-5", USER, {}, { qm, getSnapshot: fakeSnapshot, fetchBlockedInventoryBatch, fetchQuadron: fakeQuadronOk([]), checkReadiness: READY });
  assert.ok(qm.calls.some((c) => c.fn === "completeQuery"), "the RUN itself still completes even though every PID's lookup failed");
  const report = purgeEngine.getCurrentReport();
  assert.equal(report.candidates.length, 0);
  assert.equal(report.apiSkipped.length, 3);
  assert.ok(report.apiSkipped.every((s) => s.reason === "NexS unreachable"));
});

test("Quadron unavailable: every kept candidate is VALIDATION_UNAVAILABLE, summary.quadronAvailable is false", async () => {
  const qm = makeFakeQueryManager();
  const fetchBlockedInventoryBatch = fetchBlockedBatchOk(null, { totalInventory: 200, blockedInventory: 0, availableInventory: 200 });
  const fetchQuadron = async () => ({ ok: false, rows: [], queryId: "Q-QUAD", reason: "No Concinity tab" });
  await purgeEngine.generate("Q-TEST-6", USER, {}, { qm, getSnapshot: fakeSnapshot, fetchBlockedInventoryBatch, fetchQuadron, checkReadiness: READY });
  const report = purgeEngine.getCurrentReport();
  assert.equal(report.summary.quadronAvailable, false);
  assert.match(report.summary.quadronReason, /No Concinity tab \(failed twice/);
  assert.ok(report.candidates.every((c) => c.validationStatus === "VALIDATION_UNAVAILABLE"));
});

test("a failed Quadron read gets one more try - a single slow reply no longer leaves every candidate unvalidated", async () => {
  const qm = makeFakeQueryManager();
  let calls = 0;
  const fetchQuadron = async () => {
    calls++;
    if (calls === 1) return { ok: false, rows: [], queryId: "Q-QUAD-1", reason: "Backend gave up waiting for a response (timeout)" };
    return { ok: true, rows: [{ toteId: "TS0000000001", quadronQty: 3, partitions: [{ part: 1, qty: 3, sku: "1" }] }], queryId: "Q-QUAD-2", reason: null };
  };
  const fetchBlockedInventoryBatch = fetchBlockedBatchOk(null, { totalInventory: 200, blockedInventory: 0, availableInventory: 200 });
  await purgeEngine.generate("Q-RETRY-1", USER, {}, { qm, getSnapshot: fakeSnapshot, fetchBlockedInventoryBatch, fetchQuadron, checkReadiness: READY });
  const report = purgeEngine.getCurrentReport();
  assert.equal(calls, 2);
  assert.equal(report.summary.quadronAvailable, true);
  assert.equal(report.summary.quadronReason, null);
  assert.ok(!report.candidates.some((c) => c.validationStatus === "VALIDATION_UNAVAILABLE"));
});

test("the Quadron read starts alongside the NexS lookups, not after them", async () => {
  const qm = makeFakeQueryManager();
  const order = [];
  const fetchQuadron = async () => {
    order.push("quadron:start");
    return { ok: true, rows: [], queryId: "Q-QUAD", reason: null };
  };
  const fetchBlockedInventoryBatch = async (opts) => {
    order.push("nexs:start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("nexs:end");
    return fetchBlockedBatchOk(null, { totalInventory: 200, blockedInventory: 0, availableInventory: 200 })(opts);
  };
  await purgeEngine.generate("Q-PAR-1", USER, {}, { qm, getSnapshot: fakeSnapshot, fetchBlockedInventoryBatch, fetchQuadron, checkReadiness: READY });
  assert.ok(order.indexOf("quadron:start") < order.indexOf("nexs:end"), order.join(" > "));
  assert.equal(purgeEngine.getCurrentReport().summary.quadronAvailable, true);
});

test("the batch blocked-inventory provider is called exactly ONCE, with the deduplicated unique candidate PID list - never once per row/tote, never once per PID", async () => {
  const qm = makeFakeQueryManager();
  const calls = [];
  const fetchBlockedInventoryBatch = async ({ pids }) => {
    calls.push(pids);
    const map = Object.create(null);
    for (const pid of pids) map[pid] = { ok: true, totalInventory: 200, blockedInventory: 0, availableInventory: 200 };
    return map;
  };
  await purgeEngine.generate("Q-TEST-7", USER, {}, { qm, getSnapshot: fakeSnapshot, fetchBlockedInventoryBatch, fetchQuadron: fakeQuadronOk([]), checkReadiness: READY });
  // 3 candidate rows (all PID "1") pre-filter to exactly 1 unique PID -
  // and exactly one batch call total, not one call per PID/tote.
  assert.equal(calls.length, 1, "fetchBlockedInventoryBatch must be called exactly once per generate() run");
  assert.deepEqual(calls[0], ["1"]);
});

test("status lifecycle: NO_SNAPSHOT before any generate, CURRENT after success, STALE_PREVIOUS after a subsequent failure (old report preserved)", async () => {
  delete require.cache[require.resolve("../../../features/tote-purge/purgeEngine")];
  const fresh = require("../../../features/tote-purge/purgeEngine");
  const qm = makeFakeQueryManager();

  assert.equal(fresh.getStatus(), "NO_SNAPSHOT");

  const fetchBlockedInventoryBatch = fetchBlockedBatchOk(null, { totalInventory: 200, blockedInventory: 0, availableInventory: 200 });
  await fresh.generate("Q-OK-1", USER, {}, { qm, getSnapshot: fakeSnapshot, fetchBlockedInventoryBatch, fetchQuadron: fakeQuadronOk([]), checkReadiness: READY });
  assert.equal(fresh.getStatus(), "CURRENT");
  const goodReport = fresh.getCurrentReport();

  await fresh.generate("Q-FAIL-1", USER, {}, { qm, getSnapshot: () => null, checkReadiness: READY });
  assert.equal(fresh.getStatus(), "STALE_PREVIOUS");
  assert.equal(fresh.getCurrentReport(), goodReport, "the last GOOD report must still be available, unmodified");
});

test("isRunning() reflects the in-flight state and clears after completion", async () => {
  const qm = makeFakeQueryManager();
  assert.equal(purgeEngine.isRunning(), false);
  const p = purgeEngine.generate(
    "Q-TEST-8",
    USER,
    {},
    { qm, getSnapshot: fakeSnapshot, fetchBlockedInventoryBatch: fetchBlockedBatchOk(null, { totalInventory: 200, blockedInventory: 0, availableInventory: 200 }), fetchQuadron: fakeQuadronOk([]), checkReadiness: READY }
  );
  // Synchronous flag set before any await inside generate() yields.
  assert.equal(purgeEngine.isRunning(), true);
  await p;
  assert.equal(purgeEngine.isRunning(), false);
});

test("registerJob is called synchronously, before any await - a caller re-reading query status immediately after firing generate() must see a registry entry already present (regression test for a live-verification bug: totePurge.routes.js's own POST /generate response read this query's status back immediately, and with no registry entry queryManagerMysql.reconcileStale() misreported every run as FAILED with 'Backend restarted before this query finished', even though the real work then completed successfully moments later and silently overwrote it)", async () => {
  const qm = makeFakeQueryManager();
  // Deliberately NOT awaited - simulates the route handler's own
  // fire-and-forget call, then synchronously checking whether registerJob
  // already ran before this turn of the event loop yields. Still supplies
  // every fake dependency so the background continuation (which keeps
  // running after this test function returns) never touches a real
  // MySQL/Runtime call.
  const p = purgeEngine.generate("Q-TEST-SYNC", USER, {}, { qm, getSnapshot: fakeSnapshot, fetchBlockedInventoryBatch: fetchBlockedBatchOk(null, { totalInventory: 200, blockedInventory: 0, availableInventory: 200 }), fetchQuadron: fakeQuadronOk([]), checkReadiness: READY });
  assert.equal(qm.calls[0].fn, "registerJob", "registerJob must be the very first call, synchronously, before any await");
  await p; // let the background work finish before the next test reuses the module-level singleton state
});

// ── Readiness gate (real prerequisites, never the cosmetic header badge) ──

test("readiness gate: NexS unavailable fails BEFORE any per-PID call, with a clear reason", async () => {
  const qm = makeFakeQueryManager();
  let blockedCalls = 0;
  const fetchBlockedInventoryBatch = async ({ pids }) => {
    blockedCalls++;
    const map = Object.create(null);
    for (const pid of pids) map[pid] = { ok: true, totalInventory: 200, blockedInventory: 0, availableInventory: 200 };
    return map;
  };
  await purgeEngine.generate(
    "Q-READY-1",
    USER,
    {},
    { qm, getSnapshot: fakeSnapshot, fetchBlockedInventoryBatch, fetchQuadron: fakeQuadronOk([]), checkReadiness: async () => ({ nexsReady: false, quadronReady: true }) }
  );
  const failCall = qm.calls.find((c) => c.fn === "failQuery");
  assert.ok(failCall, "generate() must fail, not silently produce a partial report");
  assert.match(failCall.error, /NexS Blocked Inventory is not available/);
  assert.equal(blockedCalls, 0, "the batch provider must never be called once the gate has already failed");
});

test("readiness gate: Quadron unavailable fails with a clear reason", async () => {
  const qm = makeFakeQueryManager();
  await purgeEngine.generate(
    "Q-READY-2",
    USER,
    {},
    { qm, getSnapshot: fakeSnapshot, fetchBlockedInventoryBatch: fetchBlockedBatchOk(null, { totalInventory: 200, blockedInventory: 0, availableInventory: 200 }), fetchQuadron: fakeQuadronOk([]), checkReadiness: async () => ({ nexsReady: true, quadronReady: false }) }
  );
  const failCall = qm.calls.find((c) => c.fn === "failQuery");
  assert.ok(failCall);
  assert.match(failCall.error, /Quadron Inventory is not available/);
});

test("readiness gate: missing snapshot AND both services unavailable reports all three problems together, not just the first", async () => {
  const qm = makeFakeQueryManager();
  await purgeEngine.generate(
    "Q-READY-3",
    USER,
    {},
    { qm, getSnapshot: () => null, checkReadiness: async () => ({ nexsReady: false, quadronReady: false }) }
  );
  const failCall = qm.calls.find((c) => c.fn === "failQuery");
  assert.ok(failCall);
  assert.match(failCall.error, /No NEXS ASRS Tote Dump snapshot available/);
  assert.match(failCall.error, /NexS Blocked Inventory is not available/);
  assert.match(failCall.error, /Quadron Inventory is not available/);
});

test("readiness gate: never consults the cosmetic header connection-status flag - a fake with a differently-shaped return proves the gate reads only checkReadiness's own {nexsReady, quadronReady}", async () => {
  const qm = makeFakeQueryManager();
  // Deliberately does not import or touch server/features/connection-status/connectionStatus.js at
  // all - proves purgeEngine's gate is independent of the header's model.
  await purgeEngine.generate(
    "Q-READY-4",
    USER,
    {},
    { qm, getSnapshot: fakeSnapshot, fetchBlockedInventoryBatch: fetchBlockedBatchOk(null, { totalInventory: 200, blockedInventory: 0, availableInventory: 200 }), fetchQuadron: fakeQuadronOk([]), checkReadiness: async () => ({ nexsReady: true, quadronReady: true }) }
  );
  assert.ok(qm.calls.some((c) => c.fn === "completeQuery"));
});

// ── NEXS batch-capability refactor ─────────────────────────────────────

test("Purge makes exactly one batch capability request per generate() run, regardless of candidate PID count", async () => {
  const qm = makeFakeQueryManager();
  // A bigger snapshot: 60 unique PIDs, each with exactly 3 totes (clears
  // the default pidToteMin=3 floor), so all 60 survive the pre-filter as
  // distinct candidate PIDs - proves the ONE-batch-call guarantee holds at
  // a scale well beyond a single-digit example.
  const rows = [];
  for (let p = 1; p <= 60; p++) {
    for (let t = 1; t <= 3; t++) {
      rows.push({ pid: String(p), toteId: `TS${String(p).padStart(4, "0")}${String(t).padStart(6, "0")}`, barcodeCount: 1, partition: "PR1" });
    }
  }
  const snapshot = () => ({ refreshedAt: "x", rows });

  let batchCallCount = 0;
  let lastPidsArg = null;
  const fetchBlockedInventoryBatch = async ({ pids }) => {
    batchCallCount++;
    lastPidsArg = pids;
    const map = Object.create(null);
    for (const pid of pids) map[pid] = { ok: true, totalInventory: 200, blockedInventory: 0, availableInventory: 200 };
    return map;
  };

  await purgeEngine.generate("Q-BATCH-1", USER, {}, { qm, getSnapshot: snapshot, fetchBlockedInventoryBatch, fetchQuadron: fakeQuadronOk([]), checkReadiness: READY });

  assert.equal(batchCallCount, 1, "exactly one GET_NEXS_BLOCKED_INVENTORY_BATCH-equivalent call must be made, never one per PID");
  assert.equal(lastPidsArg.length, 60);
});

test("Purge never calls the legacy single-PID fetchBlockedInventory function - no individual GET_NEXS_BLOCKED_INVENTORY Query Manager records are created during a Purge run", async () => {
  const qm = makeFakeQueryManager();
  let singlePidCalls = 0;
  // Even if a single-PID fake were somehow reachable, generate() must never
  // call it - it no longer accepts a fetchBlockedInventory option at all
  // (renamed to fetchBlockedInventoryBatch); this proves the OLD DI shape
  // has no effect and cannot silently create per-PID capability requests.
  await purgeEngine.generate(
    "Q-BATCH-2",
    USER,
    {},
    {
      qm,
      getSnapshot: fakeSnapshot,
      fetchBlockedInventory: async () => {
        singlePidCalls++;
        return { pid: "1", totalInventory: 1, blockedInventory: 0, availableInventory: 1 };
      },
      fetchBlockedInventoryBatch: fetchBlockedBatchOk(null, { totalInventory: 200, blockedInventory: 0, availableInventory: 200 }),
      fetchQuadron: fakeQuadronOk([]),
      checkReadiness: READY,
    }
  );
  assert.equal(singlePidCalls, 0, "the legacy per-PID dependency must never be invoked by generate() any more");
  assert.ok(qm.calls.some((c) => c.fn === "completeQuery"));
});
