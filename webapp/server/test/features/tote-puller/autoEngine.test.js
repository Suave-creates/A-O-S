// Unit tests for server/features/tote-puller/autoEngine.js - the Auto Mode scheduler. No
// database, no runtime, no real Quadron call anywhere in this file.
// dispatchOne is either a scripted fake or the REAL quadronPullLock
// wrapping a fake underlying call (to prove cross-engine single-flight
// with the actual lock primitive). requestCapability/wait/getResult are
// fully injected fakes - zero real capability dispatch. classify/diff use
// the REAL classifyLockedTotes()/diffAndMerge() (already exhaustively unit
// tested elsewhere) so these tests exercise real orchestration, not a
// second copy of that logic.

const test = require("node:test");
const assert = require("node:assert/strict");
const { AutoEngine } = require("../../../features/tote-puller/autoEngine");
const { TotePullEngine } = require("../../../features/tote-puller/totePullEngine");
const { withPullLock } = require("../../../integrations/quadron/quadronPullLock");

const USER = { id: 1, role: "USER", employeeId: "EMP001" };
const ADMIN = { id: 99, role: "ADMIN", employeeId: "ADMIN001" };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Mirrors queryManagerMysql.js/queryManagerMemory.js's own registry Map +
// registerJob/cancelQuery contract exactly (just without the DB/HTTP
// layers), so these tests exercise the REAL abort-wiring AutoEngine now
// depends on, not a second, looser fake of it. `cancel(queryId)` is the
// test-only stand-in for what the real queryManager.cancelQuery() does to a
// registered job: flip cancelledByUser and abort() its controller.
function makeFakeQueryManager() {
  let n = 0;
  const calls = [];
  const registry = new Map(); // queryId -> { controller, cancelledByUser }
  return {
    calls,
    registry,
    async createQuery({ userId, operation, parameters }) {
      n++;
      const query_id = `AQ-${String(n).padStart(6, "0")}`;
      calls.push({ fn: "createQuery", userId, operation, parameters });
      return { query_id, created_at: new Date(0).toISOString() };
    },
    async markRunning(queryId) { calls.push({ fn: "markRunning", queryId }); },
    async completeQuery(queryId) { calls.push({ fn: "completeQuery", queryId }); registry.delete(queryId); },
    async finalizeCancelled(queryId) { calls.push({ fn: "finalizeCancelled", queryId }); registry.delete(queryId); },
    registerJob(queryId, controller) {
      const entry = { controller, cancelledByUser: false };
      registry.set(queryId, entry);
      calls.push({ fn: "registerJob", queryId });
      return { signal: controller.signal, wasCancelledByUser: () => entry.cancelledByUser };
    },
    unregisterJob(queryId) { registry.delete(queryId); },
    // Test-only helper standing in for the real cancelQuery(): returns
    // false (mirroring the real "Query already <terminal>" 409) once the
    // job has already been unregistered (finalized), so a test can assert
    // a second cancel is a no-op exactly like the real route would report.
    cancel(queryId) {
      const entry = registry.get(queryId);
      if (!entry) return false;
      entry.cancelledByUser = true;
      entry.controller.abort();
      return true;
    },
  };
}

function makeFakeAuditLog() {
  const calls = [];
  return { calls, async record(userId, action, detail) { calls.push({ userId, action, detail }); } };
}

// Controllable capability trio - a test can mutate what each capability
// "currently" returns between fetch cycles via setSources(), simulating a
// tote appearing/vanishing/reprioritizing in the live source dumps.
function makeControllableCapabilities(initial) {
  let sources = { GET_GRAFANA_LOCKED_TOTES: [], GET_GRAFANA_SUPERVISOR_DUMP: [], GET_QUADRON_INVENTORY: [], ...initial };
  const results = new Map();
  let counter = 0;
  const requestCapability = async ({ capabilityName }) => {
    const outcome = sources[capabilityName];
    if (outcome instanceof Error) return { ok: false, code: 502, reason: outcome.message };
    counter++;
    const queryId = `Q-FAKE-${counter}`;
    results.set(queryId, outcome || []);
    return { ok: true, query: { query_id: queryId, status: "RUNNING" } };
  };
  const wait = async (queryId) => ({ query_id: queryId, status: "COMPLETED" });
  const getResult = (queryId) => ({ rows: results.get(queryId) || [] });
  return { requestCapability, wait, getResult, setSources: (next) => { sources = { ...sources, ...next }; } };
}

function locked(toteId, overrides = {}) {
  return { toteId, zone: "5", location: "0012A", tracker: "T1", shuttle: "S1", ...overrides };
}
function invEntry(toteId, partitions) {
  return { toteId, quadronQty: partitions.reduce((s, p) => s + p.qty, 0), partitions };
}

function makeScriptedDispatcher(outcomes) {
  const cursors = {};
  const callOrder = [];
  let inFlight = 0;
  let maxInFlight = 0;
  async function dispatchOne({ toteId, zone, instanceCode }) {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    callOrder.push({ toteId, zone, instanceCode });
    await sleep(2);
    inFlight--;
    const script = outcomes[toteId];
    if (!script) throw new Error(`No scripted outcome for ${toteId}`);
    if (!Array.isArray(script)) return script;
    const idx = cursors[toteId] || 0;
    cursors[toteId] = Math.min(idx + 1, script.length - 1);
    return script[idx];
  }
  dispatchOne.callOrder = callOrder;
  dispatchOne.maxInFlight = () => maxInFlight;
  return dispatchOne;
}

function completed(queryId, verdict, rawMessage = "ok") {
  return { ok: true, query: { query_id: queryId, status: "COMPLETED", error: null }, result: { verdict, rawMessage } };
}
function failed(queryId, error = "network error") {
  return { ok: true, query: { query_id: queryId, status: "FAILED", error }, result: null };
}

async function waitUntil(fn, { timeoutMs = 3000, pollMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error("test timed out waiting for condition");
    await sleep(pollMs);
  }
}

function baseConfig(overrides = {}) {
  return {
    batchSize: 5,
    callIntervalMs: 5,
    batchIntervalMs: 10,
    retryDelayMs: 1,
    cooldownMs: 0,
    lockedDumpRefreshMs: 100000, // effectively "never" unless a test overrides it
    supervisorDumpRefreshMs: 100000,
    p0MaxTotes: 1,
    p1MaxTotes: 3,
    ...overrides,
  };
}

function makeEngine({ caps, dispatchOne }) {
  return new AutoEngine({
    dispatchOne,
    requestCapability: caps.requestCapability,
    wait: caps.wait,
    getResult: caps.getResult,
    queryManager: makeFakeQueryManager(),
    auditLog: makeFakeAuditLog(),
  });
}

// Same as makeEngine(), but also returns the fake queryManager/auditLog so
// a test can call qm.cancel(sessionId) - the SAME registry-entry-abort path
// the real POST /admin/queries/:id/cancel and POST /queries/:id/cancel
// routes exercise via queryManager.cancelQuery() - and inspect audit calls.
function makeCancellableEngine({ caps, dispatchOne }) {
  const queryManager = makeFakeQueryManager();
  const auditLog = makeFakeAuditLog();
  const engine = new AutoEngine({
    dispatchOne,
    requestCapability: caps.requestCapability,
    wait: caps.wait,
    getResult: caps.getResult,
    queryManager,
    auditLog,
  });
  return { engine, queryManager, auditLog };
}

// ── Initial fetch -> classify -> populate -> first batch ────────────────

test("Auto start performs an initial fetch/classify/populate before running the first batch", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("TS0000000001")] });
  const dispatchOne = makeScriptedDispatcher({ TS0000000001: completed("Q-A", "INSERTED") });
  const engine = makeEngine({ caps, dispatchOne });

  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig() });
  await waitUntil(() => engine.get(session.sessionId, USER).session.results.length >= 1);

  const final = engine.get(session.sessionId, USER).session;
  assert.equal(final.results[0].toteId, "TS0000000001");
  assert.equal(final.results[0].verdict, "INSERTED");
  assert.equal(final.results[0].priorityAtSelection, "P2");
  engine.stop(session.sessionId, USER);
});

// ── Batch construction / ordering ────────────────────────────────────────

test("batch construction respects SD -> P0 -> P1 -> P2 ordering and batchSize", async () => {
  const caps = makeControllableCapabilities({
    GET_GRAFANA_LOCKED_TOTES: [locked("SD-A"), locked("P2-A"), locked("P0-A"), locked("P1-A")],
    GET_GRAFANA_SUPERVISOR_DUMP: [{ toteId: "SD-A" }],
    GET_QUADRON_INVENTORY: [invEntry("P0-A", [{ part: 1, qty: 1, sku: "SKU-RARE" }]), invEntry("P1-A", [{ part: 1, qty: 1, sku: "SKU-MED" }]), invEntry("XX-1", [{ part: 1, qty: 1, sku: "SKU-MED" }]), invEntry("XX-2", [{ part: 1, qty: 1, sku: "SKU-MED" }])],
  });
  const dispatchOne = makeScriptedDispatcher({
    "SD-A": completed("Q1", "INSERTED"), "P0-A": completed("Q2", "INSERTED"), "P1-A": completed("Q3", "INSERTED"), "P2-A": completed("Q4", "INSERTED"),
  });
  const engine = makeEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ batchSize: 2 }) });

  await waitUntil(() => dispatchOne.callOrder.length >= 2);
  assert.deepEqual(dispatchOne.callOrder.slice(0, 2).map((c) => c.toteId), ["SD-A", "P0-A"], "first batch of size 2 must be SD then P0");
  engine.stop(session.sessionId, USER);
});

// Phase 7, Issue 4: snapshot() must expose worstPid (an existing AutoQueue
// entry field - see autoQueue.js's insert()) so the UI's "Current PID" is a
// real, already-computed value, never fabricated or a second computation.
test("snapshot() exposes the real worstPid for the current batch entry ('Current PID')", async () => {
  const caps = makeControllableCapabilities({
    GET_GRAFANA_LOCKED_TOTES: [locked("P0-A")],
    GET_QUADRON_INVENTORY: [invEntry("P0-A", [{ part: 1, qty: 1, sku: "SKU-RARE" }])],
  });
  const dispatchOne = makeScriptedDispatcher({ "P0-A": completed("Q1", "INSERTED") });
  const engine = makeEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ batchSize: 1 }) });

  assert.equal(session.currentBatch[0].priority, "P0");
  assert.equal(session.currentBatch[0].worstPid, "SKU-RARE", "worstPid must be the real scarce SKU classifyLockedTotes() already computed, not null/fabricated");
  await waitUntil(() => engine.get(session.sessionId, USER).session.status === "WAITING");
  engine.stop(session.sessionId, USER);
});

// ── Vanished / reappearing / priority-change totes ──────────────────────

test("vanished tote: removed from the queue before its turn, never dispatched", async () => {
  // batchSize:1 means only the FIRST tote (T1) is unavoidably pulled into
  // a batch synchronously during start() - it is therefore already
  // "in-flight" by the time any test code can react (matching the real
  // "in-flight batch is outside diff scope" rule this replicates). T2 and
  // T3 remain genuinely QUEUED (not yet batched) after T1 completes, which
  // is the state this test actually needs to exercise a vanish-before-
  // dispatch scenario against.
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("T1"), locked("T2"), locked("T3")] });
  const dispatchOne = makeScriptedDispatcher({ T1: completed("Q1", "INSERTED"), T3: completed("Q3", "INSERTED") });
  const engine = makeEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000, batchSize: 1, batchIntervalMs: 300 }) });
  const s = engine.sessions.get(session.sessionId);

  // Wait for T1's dispatch to fully RESOLVE (not just be initiated) so
  // callHistory/results are settled before this test's own manipulation -
  // otherwise a race exists between the scripted dispatcher's internal
  // delay and this test's next steps.
  await waitUntil(() => engine.get(session.sessionId, USER).session.results.length >= 1);

  // T2 vanishes from the source dump before batch 2 (the 300ms
  // batchIntervalMs window) ever reaches it.
  caps.setSources({ GET_GRAFANA_LOCKED_TOTES: [locked("T1"), locked("T3")] });
  await engine.runFetchCycle(s);

  await waitUntil(() => dispatchOne.callOrder.some((c) => c.toteId === "T3"), { timeoutMs: 3000 });
  assert.ok(!dispatchOne.callOrder.some((c) => c.toteId === "T2"), "the vanished tote must never be dispatched");
  engine.stop(session.sessionId, USER);
});

test("reappearing tote: vanishes then genuinely reappears via a later fetch cycle - treated as a fresh queue entry and eventually dispatched", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [] });
  const dispatchOne = makeScriptedDispatcher({ TS0000000001: completed("Q-A", "INSERTED") });
  const engine = makeEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });
  const s = engine.sessions.get(session.sessionId);
  await waitUntil(() => engine.get(session.sessionId, USER).session.status === "WAITING");

  caps.setSources({ GET_GRAFANA_LOCKED_TOTES: [locked("TS0000000001")] });
  await engine.runFetchCycle(s);

  await waitUntil(() => dispatchOne.callOrder.some((c) => c.toteId === "TS0000000001"), { timeoutMs: 2000 });
  engine.stop(session.sessionId, USER);
});

test("priority change: a still-queued tote reclassified P2->P0 between fetch cycles is dispatched ahead of an unrelated, unchanged tote", async () => {
  // Same reasoning as the vanished-tote test above: T1 is unavoidably
  // batched during start() (batchSize:1), so the reclassification is
  // exercised against T2/T3, which remain genuinely queued after T1.
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("T1"), locked("T2"), locked("T3")] });
  const dispatchOne = makeScriptedDispatcher({ T1: completed("Q1", "INSERTED"), T2: completed("Q2", "INSERTED"), T3: completed("Q3", "INSERTED") });
  const engine = makeEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000, batchSize: 1, batchIntervalMs: 300 }) });
  const s = engine.sessions.get(session.sessionId);

  await waitUntil(() => engine.get(session.sessionId, USER).session.results.length >= 1);

  // T2 and T3 are still queued (P2). Reclassify T3 as P0 before batch 2 runs.
  caps.setSources({ GET_QUADRON_INVENTORY: [invEntry("T3", [{ part: 1, qty: 1, sku: "SKU-RARE" }])] });
  await engine.runFetchCycle(s);

  await waitUntil(() => dispatchOne.callOrder.length >= 3, { timeoutMs: 3000 });
  const order = dispatchOne.callOrder.map((c) => c.toteId);
  assert.deepEqual(order, ["T1", "T3", "T2"], "T3 (now P0) must be dispatched ahead of T2 (still P2), proving the relocation took effect before either was ever dispatched");
  engine.stop(session.sessionId, USER);
});

// ── Preemption ────────────────────────────────────────────────────────────

test("preemption: SD arriving mid-batch requeues the unused remainder and rebuilds - but the FIRST tote of the active batch always completes", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("P2-A"), locked("P2-B"), locked("P2-C")] });
  const dispatchOne = makeScriptedDispatcher({
    "P2-A": completed("Q1", "INSERTED"), "P2-B": completed("Q2", "INSERTED"), "P2-C": completed("Q3", "INSERTED"), "SD-NEW": completed("Q4", "INSERTED"),
  });
  const engine = makeEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000, batchSize: 3, callIntervalMs: 40 }) });
  const s = engine.sessions.get(session.sessionId);

  // Let the first tote (P2-A) dispatch, then - while batchIndex > 0 - inject an SD tote.
  await waitUntil(() => dispatchOne.callOrder.length >= 1);
  caps.setSources({ GET_GRAFANA_LOCKED_TOTES: [locked("P2-A"), locked("P2-B"), locked("P2-C"), locked("SD-NEW")], GET_GRAFANA_SUPERVISOR_DUMP: [{ toteId: "SD-NEW" }] });
  await engine.runFetchCycle(s); // sets the preempt flag

  await waitUntil(() => dispatchOne.callOrder.some((c) => c.toteId === "SD-NEW"), { timeoutMs: 3000 });

  const order = dispatchOne.callOrder.map((c) => c.toteId);
  assert.equal(order[0], "P2-A", "the first tote of the active batch must always complete before any preemption check runs");
  const sdIndex = order.indexOf("SD-NEW");
  const bIndex = order.indexOf("P2-B");
  const cIndex = order.indexOf("P2-C");
  assert.ok(sdIndex < bIndex || bIndex === -1, "SD-NEW must be dispatched ahead of the requeued P2-B");
  assert.ok(sdIndex < cIndex || cIndex === -1, "SD-NEW must be dispatched ahead of the requeued P2-C");
  engine.stop(session.sessionId, USER);
});

// ── Retry: zone can change, exhaustion -> SKIPPED ────────────────────────

test("retry changing zone: a retried tote can land on a different configured zone than its first attempt", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("TS0000000001")] });
  const seen = [];
  const dispatchOne = async ({ toteId, zone, instanceCode }) => {
    seen.push(zone);
    if (seen.length === 1) return failed("Q1"); // force a retry
    return completed("Q2", "INSERTED");
  };
  const engine = makeEngine({ caps, dispatchOne });
  const { session } = await engine.start({
    user: USER,
    multiZone: true,
    zones: [{ id: "z5", zone: "5", instanceCode: "LK-A", percentage: 70 }, { id: "z12", zone: "12", instanceCode: "LK-B", percentage: 30 }],
    config: baseConfig({ lockedDumpRefreshMs: 100000, retryDelayMs: 1 }),
  });
  await waitUntil(() => seen.length >= 2, { timeoutMs: 3000 });
  assert.equal(seen[0], "5");
  assert.equal(seen[1], "12", "the 70/30 sequence's second pick must be zone 12, proving the retry re-picked a zone");
  engine.stop(session.sessionId, USER);
});

test("retry exhaustion: 5 failed attempts records SKIPPED and the batch continues to the next tote", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("TS0000000001"), locked("TS0000000002")] });
  const dispatchOne = makeScriptedDispatcher({ TS0000000001: failed("Q-A", "persistent error"), TS0000000002: completed("Q-B", "INSERTED") });
  const engine = makeEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000, retryDelayMs: 1 }) });

  await waitUntil(() => engine.get(session.sessionId, USER).session.results.length >= 2, { timeoutMs: 3000 });
  const results = engine.get(session.sessionId, USER).session.results;
  assert.equal(results[0].terminal, "SKIPPED");
  assert.equal(results[0].attempt, 5);
  assert.equal(results[1].terminal, "COMPLETED");
  engine.stop(session.sessionId, USER);
});

// ── Cooldown ──────────────────────────────────────────────────────────────

test("cooldown: a tote still within cooldown after being called is ignored (not re-dispatched) if it reappears in the queue", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("TS0000000001")] });
  const dispatchOne = makeScriptedDispatcher({ TS0000000001: completed("Q-A", "ALREADY_QUEUED") });
  const engine = makeEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000, cooldownMs: 60000 }) });
  const s = engine.sessions.get(session.sessionId);

  // Wait for the dispatch to fully RESOLVE (results.length, not just
  // callOrder) so callHistory is guaranteed to be recorded before this
  // test's manipulation - otherwise a race exists between the dispatcher's
  // own internal delay and the next fetch cycle.
  await waitUntil(() => engine.get(session.sessionId, USER).session.results.length >= 1);
  // The tote is still present in the (fake) Locked Dump on the next fetch -
  // it gets re-queued (it was removed from the queue by next() when
  // batched, so a fresh fetch re-inserts it) but must be COOLDOWN-ignored,
  // not re-dispatched, since cooldownMs (60s) hasn't elapsed. Waits
  // deterministically for the ignore to register (batchIntervalMs must
  // first elapse before batch 2 even runs) rather than a fixed sleep,
  // which flakes under load when many test files run in one process.
  await engine.runFetchCycle(s);
  await waitUntil(() => engine.get(session.sessionId, USER).session.stats.ignored >= 1, { timeoutMs: 3000 });

  assert.equal(dispatchOne.callOrder.length, 1, "the tote must not be dispatched a second time within its cooldown window");
  const final = engine.get(session.sessionId, USER).session;
  assert.equal(final.stats.ignored, 1);
  engine.stop(session.sessionId, USER);
});

// ── Empty queue -> WAITING -> auto-resume ────────────────────────────────

test("empty queue enters WAITING, and a later fetch cycle bringing in a new tote auto-resumes without operator action", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [] });
  const dispatchOne = makeScriptedDispatcher({ TS0000000001: completed("Q-A", "INSERTED") });
  const engine = makeEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });

  await waitUntil(() => engine.get(session.sessionId, USER).session.status === "WAITING");

  caps.setSources({ GET_GRAFANA_LOCKED_TOTES: [locked("TS0000000001")] });
  await engine.runFetchCycle(engine.sessions.get(session.sessionId));

  await waitUntil(() => engine.get(session.sessionId, USER).session.status === "RUNNING" || dispatchOne.callOrder.length >= 1, { timeoutMs: 2000 });
  await waitUntil(() => dispatchOne.callOrder.length >= 1, { timeoutMs: 2000 });
  engine.stop(session.sessionId, USER);
});

// ── Stop ──────────────────────────────────────────────────────────────────

test("stop(): the in-flight tote finishes, remaining totes are never dispatched, status becomes STOPPED", async () => {
  let releaseA;
  const gate = new Promise((r) => (releaseA = r));
  const calls = [];
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("TL0000000001"), locked("TL0000000002")] });
  const dispatchOne = async ({ toteId }) => {
    calls.push(toteId);
    if (toteId === "TL0000000001") await gate;
    return completed(`Q-${toteId}`, "INSERTED");
  };
  const engine = makeEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });

  await waitUntil(() => calls.length >= 1);
  const stopResult = await engine.stop(session.sessionId, USER);
  assert.equal(stopResult.ok, true);
  releaseA();

  await waitUntil(() => engine.get(session.sessionId, USER).session.status === "STOPPED");
  await sleep(30);
  assert.deepEqual(calls, ["TL0000000001"], "the second tote must never be dispatched once stop was requested");
});

// Auto Puller is ONE shared line (operator decision 2026-11-04): anyone may pause, resume or stop it.
test("shared line: another (non-admin) user may pause, resume and stop the session; the log says who", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("TS0000000001")] });
  const dispatchOne = makeScriptedDispatcher({ TS0000000001: [failed("Q-A")] });
  const engine = makeEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000, retryDelayMs: 50 }) });

  const other = { id: 2, role: "USER", employeeId: "E2" };
  const paused = engine.pause(session.sessionId, other);
  assert.equal(paused.ok, true);
  const resumed = await engine.resume(session.sessionId, other);
  assert.equal(resumed.ok, true);
  const stopped = await engine.stop(session.sessionId, other);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.session.stoppedBy, "E2");
  const messages = stopped.session.log.map((l) => l.message);
  assert.ok(messages.includes("Paused by E2.") && messages.includes("Resumed by E2.") && messages.includes("Stopped by E2."));
});

test("shared line: Start by a second user while a session runs joins it - never a second Auto session", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [] });
  const dispatchOne = makeScriptedDispatcher({});
  const { engine } = makeCancellableEngine({ caps, dispatchOne });
  const first = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });
  const second = await engine.start({ user: { id: USER.id + 1, role: "USER", employeeId: "E2" }, zone: "9", instanceCode: "LK-070", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });
  assert.equal(second.started, false);
  assert.equal(second.session.sessionId, first.session.sessionId);
  assert.equal(engine.findActive().sessionId, first.session.sessionId);
  await engine.stop(first.session.sessionId, USER);
  assert.equal(engine.findActive(), null);
});

// ── Pause / resume ────────────────────────────────────────────────────────

test("pause halts dispatching; resume continues from where it left off", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("TS0000000001"), locked("TS0000000002")] });
  const dispatchOne = makeScriptedDispatcher({ TS0000000001: completed("Q-A", "INSERTED"), TS0000000002: completed("Q-B", "INSERTED") });
  const engine = makeEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000, batchSize: 1, callIntervalMs: 200 }) });

  await waitUntil(() => dispatchOne.callOrder.length >= 1);
  const pauseResult = engine.pause(session.sessionId, USER);
  assert.equal(pauseResult.ok, true);
  assert.equal(engine.get(session.sessionId, USER).session.status, "PAUSED");

  await sleep(50);
  assert.equal(dispatchOne.callOrder.length, 1, "no further dispatch may happen while paused");

  const resumeResult = await engine.resume(session.sessionId, USER);
  assert.equal(resumeResult.ok, true);
  await waitUntil(() => dispatchOne.callOrder.length >= 2, { timeoutMs: 3000 });
  engine.stop(session.sessionId, USER);
});

// ── Grouped audit logging ─────────────────────────────────────────────────

test("grouped audit logging: exactly ONE audit record is written for the whole session, embedding every tote's result", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("TS0000000001"), locked("TS0000000002")] });
  const dispatchOne = makeScriptedDispatcher({ TS0000000001: completed("Q-A", "INSERTED"), TS0000000002: completed("Q-B", "NOT_AVAILABLE") });
  const auditLog = makeFakeAuditLog();
  const engine = new AutoEngine({
    dispatchOne, requestCapability: caps.requestCapability, wait: caps.wait, getResult: caps.getResult,
    queryManager: makeFakeQueryManager(), auditLog,
  });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });

  await waitUntil(() => engine.get(session.sessionId, USER).session.results.length >= 2);
  await engine.stop(session.sessionId, USER);

  const sessionLogs = auditLog.calls.filter((c) => c.detail && c.detail.sessionId === session.sessionId && c.action === "AUTO_ENGINE_SESSION_STOPPED");
  assert.equal(sessionLogs.length, 1, "exactly one grouped operation-log-eligible audit record for the whole session");
  assert.equal(sessionLogs[0].detail.results.length, 2, "both tote results must be embedded in the single record");
});

// ── Auto + Manual sharing the REAL quadronPullLock ───────────────────────

test("Auto + Manual sharing the real quadronPullLock never dispatch overlapping real Quadron pulls", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  async function realLockDispatchOne({ toteId }) {
    return withPullLock(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
      return completed(`Q-${toteId}`, "INSERTED");
    });
  }

  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("TS0000000011"), locked("TS0000000012"), locked("TS0000000013")] });
  const autoEngine = new AutoEngine({
    dispatchOne: realLockDispatchOne, requestCapability: caps.requestCapability, wait: caps.wait, getResult: caps.getResult,
    queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(),
  });
  const manualEngine = new TotePullEngine({ dispatchOne: realLockDispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });

  const startAuto = autoEngine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });
  const startManual = manualEngine.createAndStart({ user: { id: 2, role: "USER" }, totes: ["TS0000000021", "TS0000000022", "TS0000000023"], zone: "12", instanceCode: "LK-069" });
  const [{ session: autoSession }, { session: manualSession }] = await Promise.all([startAuto, startManual]);

  await waitUntil(() => autoEngine.get(autoSession.sessionId, USER).session.results.length >= 3, { timeoutMs: 4000 });
  const manualFinal = await (async () => {
    const deadline = Date.now() + 4000;
    for (;;) {
      // ADMIN, not USER - the Manual session belongs to a different user
      // ({id:2}), and only ADMIN or the owner may view/poll a session.
      const got = manualEngine.get(manualSession.sessionId, ADMIN);
      if (got.session.status !== "RUNNING") return got.session;
      if (Date.now() > deadline) throw new Error("manual session timed out");
      await sleep(5);
    }
  })();

  assert.equal(maxInFlight, 1, "PULL A (Auto) + PULL B (Manual) must never be concurrent");
  assert.equal(manualFinal.status, "COMPLETED");
  autoEngine.stop(autoSession.sessionId, USER);
});

// ── Real cancellation (Phase 7, Issue 1/2) ───────────────────────────────
// Every test below cancels via queryManager.cancel(sessionId) - the SAME
// registerJob()->AbortController->abort() path the real POST
// /admin/queries/:id/cancel and POST /queries/:id/cancel routes exercise -
// never AutoEngine.stop() directly. This is what actually proves the Active
// Queries "Cancel Query" button stops the engine, not just a DB status flip.

test("cancellation: session is registered as a real Query Manager job at start()", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [] });
  const dispatchOne = makeScriptedDispatcher({});
  const { engine, queryManager } = makeCancellableEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });

  assert.ok(queryManager.registry.has(session.sessionId), "AutoEngine.start() must call queryManager.registerJob() for its own session query");
  engine.stop(session.sessionId, USER);
});

test("cancel while idle (queue empty, WAITING): stops cleanly, no tote is ever dispatched", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [] });
  const dispatchOne = makeScriptedDispatcher({});
  const { engine, queryManager } = makeCancellableEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });

  await waitUntil(() => engine.get(session.sessionId, USER).session.status === "WAITING");

  const cancelled = queryManager.cancel(session.sessionId);
  assert.equal(cancelled, true);

  await waitUntil(() => engine.get(session.sessionId, USER).session.status === "STOPPED");
  const final = engine.get(session.sessionId, USER).session;
  assert.equal(final.cancelledByUser, true);
  assert.equal(dispatchOne.callOrder.length, 0, "an idle session must never dispatch after cancellation");
  assert.equal(queryManager.calls.filter((c) => c.fn === "finalizeCancelled").length, 1);
});

test("cancel between batches: no new batch starts", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("T1"), locked("T2")] });
  const dispatchOne = makeScriptedDispatcher({ T1: completed("Q1", "INSERTED"), T2: completed("Q2", "INSERTED") });
  const { engine, queryManager } = makeCancellableEngine({ caps, dispatchOne });
  // batchSize:1 + a long batchIntervalMs -> after T1's batch completes,
  // the engine sits in the RUNNING "waiting for next batch" gap (its own
  // callTimer scheduled for batchIntervalMs out) before batch 2 would start.
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000, batchSize: 1, batchIntervalMs: 500 }) });

  await waitUntil(() => dispatchOne.callOrder.length >= 1);
  await sleep(20); // safely inside the inter-batch gap, well before the 500ms batchIntervalMs elapses

  const cancelled = queryManager.cancel(session.sessionId);
  assert.equal(cancelled, true);

  await waitUntil(() => engine.get(session.sessionId, USER).session.status === "STOPPED");
  await sleep(600); // longer than batchIntervalMs - if the orphaned inter-batch timer weren't cleared, batch 2 would start here
  assert.deepEqual(dispatchOne.callOrder.map((c) => c.toteId), ["T1"], "no second batch may start once cancelled while waiting between batches");
});

test("cancel while a tote pull is in flight: that pull runs to completion (documented limitation), but no further tote is ever dispatched", async () => {
  let releaseA;
  const gate = new Promise((r) => (releaseA = r));
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("T1"), locked("T2")] });
  const dispatchOne = async ({ toteId }) => {
    dispatchOne.callOrder.push({ toteId });
    if (toteId === "T1") await gate;
    return completed(`Q-${toteId}`, "INSERTED");
  };
  dispatchOne.callOrder = [];
  const { engine, queryManager, auditLog } = makeCancellableEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });

  await waitUntil(() => dispatchOne.callOrder.length >= 1);
  const cancelled = queryManager.cancel(session.sessionId);
  assert.equal(cancelled, true);

  // The session must already report STOPPED/cancelled even though T1's
  // dispatch has not resolved yet - cancellation stops the SCHEDULER, it
  // does not wait for the in-flight pull.
  await waitUntil(() => engine.get(session.sessionId, USER).session.status === "STOPPED");
  assert.equal(engine.get(session.sessionId, USER).session.cancelledByUser, true);

  releaseA();
  await sleep(30);

  assert.deepEqual(dispatchOne.callOrder.map((c) => c.toteId), ["T1"], "T2 must never be dispatched once cancellation was requested, even after T1's in-flight pull resolves");
  const stoppedLogs = auditLog.calls.filter((c) => c.action === "AUTO_ENGINE_SESSION_STOPPED" && c.detail.sessionId === session.sessionId);
  assert.equal(stoppedLogs.length, 1, "exactly one terminal audit record, even though T1 resolved after finalize already ran");
});

test("cancel after completion (already STOPPED): is a no-op, does not double-finalize", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [] });
  const dispatchOne = makeScriptedDispatcher({});
  const { engine, queryManager, auditLog } = makeCancellableEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });

  await engine.stop(session.sessionId, USER);
  assert.equal(engine.get(session.sessionId, USER).session.status, "STOPPED");

  const cancelled = queryManager.cancel(session.sessionId);
  assert.equal(cancelled, false, "the job was already unregistered on finalize - nothing left to cancel");

  await sleep(20);
  const stoppedLogs = auditLog.calls.filter((c) => c.action === "AUTO_ENGINE_SESSION_STOPPED" && c.detail.sessionId === session.sessionId);
  assert.equal(stoppedLogs.length, 1, "no duplicate terminal audit record from the no-op cancel attempt");
});

test("cancel twice: the second call is a no-op, exactly one terminal transition happens", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [] });
  const dispatchOne = makeScriptedDispatcher({});
  const { engine, queryManager, auditLog } = makeCancellableEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });

  await waitUntil(() => engine.get(session.sessionId, USER).session.status === "WAITING");
  queryManager.cancel(session.sessionId);
  queryManager.cancel(session.sessionId); // fires synchronously again - AbortController.abort() is a no-op once already aborted

  await waitUntil(() => engine.get(session.sessionId, USER).session.status === "STOPPED");
  await sleep(20);
  assert.equal(queryManager.calls.filter((c) => c.fn === "finalizeCancelled").length, 1, "finalize must run exactly once");
  const stoppedLogs = auditLog.calls.filter((c) => c.action === "AUTO_ENGINE_SESSION_STOPPED" && c.detail.sessionId === session.sessionId);
  assert.equal(stoppedLogs.length, 1);
});

test("cancellation race with an operator's own Stop button: whichever wins, exactly one finalize happens", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [] });
  const dispatchOne = makeScriptedDispatcher({});
  const { engine, queryManager, auditLog } = makeCancellableEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });

  await waitUntil(() => engine.get(session.sessionId, USER).session.status === "WAITING");

  // Fire both "routes" at effectively the same time - queryManager.cancel()
  // synchronously triggers the abort listener's _finalize() call (fire-and-
  // forget); stop() is awaited directly. _finalize()'s own already-terminal
  // guard (autoEngine.js) is what must make this race safe.
  queryManager.cancel(session.sessionId);
  const stopResult = await engine.stop(session.sessionId, USER);

  await sleep(20);
  assert.equal(queryManager.calls.filter((c) => c.fn === "finalizeCancelled").length, 1, "exactly one finalize, regardless of which trigger reached _finalize() first");
  const stoppedLogs = auditLog.calls.filter((c) => c.action === "AUTO_ENGINE_SESSION_STOPPED" && c.detail.sessionId === session.sessionId);
  assert.equal(stoppedLogs.length, 1, "exactly one terminal audit record from the race, never two");
  // stop() itself may report either ok:true (it won the race) or the
  // already-terminal 409 (the abort listener won first) - both are correct;
  // what must never happen is two finalizations.
  assert.ok(stopResult.ok === true || stopResult.code === 409);
});

// ── Browser-refresh reconnect / no duplicate session (Phase 7, Issue 6/7) ──
// The engine itself never depended on the browser tab (see the cancellation
// tests above - none of them touch a "frontend"). These tests cover the
// actual gap: findActiveForUser() (the backend half of the frontend's
// reconnect-on-load call) and start()'s new idempotency guard, which is
// what stops "refresh, then click Start again" from spinning up a second,
// independent engine/queue/timer pair against the same zone.

test("findActiveForUser: finds a session that is RUNNING or WAITING, scoped to that user only", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [] });
  const dispatchOne = makeScriptedDispatcher({});
  const { engine } = makeCancellableEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });

  const found = engine.findActiveForUser(USER.id);
  assert.equal(found && found.sessionId, session.sessionId, "must find the session this same user just started");

  const otherUser = { id: USER.id + 1, role: "USER" };
  assert.equal(engine.findActiveForUser(otherUser.id), null, "must never return another user's session");

  await engine.stop(session.sessionId, USER);
});

test("findActiveForUser: returns null once the session reaches a terminal state", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [] });
  const dispatchOne = makeScriptedDispatcher({});
  const { engine } = makeCancellableEngine({ caps, dispatchOne });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });

  await engine.stop(session.sessionId, USER);
  assert.equal(engine.findActiveForUser(USER.id), null, "a STOPPED session is not 'active' - a fresh Start must be allowed");
});

test("start() while the same user already has an active session returns the EXISTING session (ok, started:false) instead of creating a second one", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [] });
  const dispatchOne = makeScriptedDispatcher({});
  const { engine, queryManager } = makeCancellableEngine({ caps, dispatchOne });

  const first = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });
  const second = await engine.start({ user: USER, zone: "9", instanceCode: "LK-070", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });

  assert.equal(second.ok, true);
  assert.equal(second.started, false, "must report it did NOT start a new session");
  assert.equal(second.session.sessionId, first.session.sessionId, "must return the SAME session, not a new one");
  assert.equal(queryManager.calls.filter((c) => c.fn === "registerJob").length, 1, "exactly one job/session was ever registered - no duplicate engine/queue/timer pair");

  await engine.stop(first.session.sessionId, USER);
});

test("start() after the previous session is stopped creates a genuinely new session (idempotency guard does not over-block)", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [] });
  const dispatchOne = makeScriptedDispatcher({});
  const { engine } = makeCancellableEngine({ caps, dispatchOne });

  const first = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });
  await engine.stop(first.session.sessionId, USER);

  const second = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });
  assert.notEqual(second.started, false, "must NOT take the 'already active, return existing' short-circuit - the old session is terminal");
  assert.notEqual(second.session.sessionId, first.session.sessionId, "must be a different session, not the stopped one");
  await engine.stop(second.session.sessionId, USER);
});

test("activeSummaries lists every running Auto session (who, how far) and leaves out finished ones - and carries no tote data", () => {
  const engine = new AutoEngine({ dispatchOne: async () => ({}), requestCapability: async () => ({ ok: false }), wait: async () => ({}), getResult: () => ({}), queryManager: {}, auditLog: {} });
  const queue = (n) => ({ totalSize: () => n });
  const mk = (id, by, status, called, queued) => ({ sessionId: id, user: by ? { employeeId: by } : null, status, startedAt: "2026-10-17T05:00:00.000Z", stats: { called }, queue: queue(queued), results: [{ toteId: "TL0000000001" }], log: ["x"] });
  engine.sessions.set("Q-1", mk("Q-1", "181212", "RUNNING", 12, 40));
  engine.sessions.set("Q-2", mk("Q-2", "181213", "STOPPED", 3, 0));
  engine.sessions.set("Q-3", mk("Q-3", "181214", "COMPLETED", 9, 0));
  engine.sessions.set("Q-4", mk("Q-4", null, "WAITING", 1, 5));
  const list = engine.activeSummaries();
  assert.deepEqual(list.map((s) => s.sessionId), ["Q-1", "Q-4"]);
  assert.equal(list[0].by, "181212");
  assert.equal(list[0].called, 12);
  assert.equal(list[0].queued, 40);
  assert.equal(list[1].by, null, "an unknown user stays unknown, never guessed");
  assert.ok(list.every((s) => !("results" in s) && !("log" in s) && !("queue" in s)));
});

// ── "Is anyone watching?" reminder + the Manual-only pull limit (operator decision 2026-11-04) ─────────────

const pullRateLimiter = require("../../../integrations/quadron/pullRateLimiter");

test("reminder: asks after its interval; anyone's acknowledgement starts the next interval", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [] });
  const engine = makeEngine({ caps, dispatchOne: makeScriptedDispatcher({}) });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000, reminderMs: 30, reminderAckMs: 5000 }) });
  assert.ok(session.reminder.nextAt, "a reminder is scheduled from the start");
  await sleep(60);
  const asked = engine.get(session.sessionId, USER).session;
  assert.ok(asked.reminder.askedAt && asked.reminder.deadline, "the question is open");
  const acked = engine.acknowledge(session.sessionId, { id: 9, role: "USER", employeeId: "E9" });
  assert.equal(acked.ok, true);
  assert.equal(acked.session.reminder.askedAt, null);
  assert.equal(acked.session.reminder.lastAckBy, "E9");
  assert.ok(acked.session.log.some((l) => l.message === "Reminder acknowledged by E9."));
  assert.notEqual(acked.session.status, "STOPPED");
  await engine.stop(session.sessionId, USER);
});

test("reminder: nobody acknowledges within the answer window -> the session stops itself", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [] });
  const engine = makeEngine({ caps, dispatchOne: makeScriptedDispatcher({}) });
  const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000, reminderMs: 20, reminderAckMs: 30 }) });
  await sleep(120);
  const after = engine.get(session.sessionId, USER).session;
  assert.equal(after.status, "STOPPED");
  assert.equal(after.stoppedBy, "no one acknowledged the reminder");
  assert.equal(engine.findActive(), null);
});

test("Auto pulls are not under (and do not count toward) the Manual Puller's pull-rate limit", async () => {
  pullRateLimiter.reset();
  pullRateLimiter.configure({ max: 1, windowMs: 60000 });
  pullRateLimiter.record(); // the Manual limit is already full
  try {
    const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("TS0000000001")] });
    const dispatchOne = makeScriptedDispatcher({ TS0000000001: completed("Q-A", "INSERTED") });
    const engine = makeEngine({ caps, dispatchOne });
    const { session } = await engine.start({ user: USER, zone: "5", instanceCode: "LK-069", config: baseConfig({ lockedDumpRefreshMs: 100000 }) });
    await sleep(80);
    const s = engine.get(session.sessionId, USER).session;
    assert.equal(s.stats.called, 1, "Auto called the tote although the Manual limit is full");
    assert.equal(pullRateLimiter.snapshot().count, 1, "and its pull did not count toward the Manual limit");
    await engine.stop(session.sessionId, USER);
  } finally {
    pullRateLimiter.reset();
  }
});
