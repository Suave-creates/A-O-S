// Unit tests for server/features/tote-puller/totePullEngine.js. No database, no runtime, no
// real Quadron call anywhere in this file - queryManager and auditLog are
// injected fakes, and dispatchOne is either a scripted fake (for pure
// sequencing/retry/verdict logic) or the REAL quadronPullLock wrapping a
// fake underlying call (specifically to prove the cross-session single-
// flight guarantee with the actual lock primitive, not just a mock of it).

const test = require("node:test");
const assert = require("node:assert/strict");
const { TotePullEngine } = require("../../../features/tote-puller/totePullEngine");
const { withPullLock } = require("../../../integrations/quadron/quadronPullLock");

const USER = { id: 1, role: "USER" };
const ADMIN = { id: 99, role: "ADMIN" };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// A fake queryManager sufficient for the Engine's own needs - createQuery/
// markRunning/completeQuery/finalizeCancelled - with no MySQL involved.
function makeFakeQueryManager() {
  let n = 0;
  const calls = [];
  return {
    calls,
    async createQuery({ userId, operation, parameters }) {
      n++;
      const query_id = `Q-${String(n).padStart(6, "0")}`;
      calls.push({ fn: "createQuery", userId, operation, parameters });
      return { query_id, created_at: new Date(0).toISOString() };
    },
    async markRunning(queryId) {
      calls.push({ fn: "markRunning", queryId });
    },
    async completeQuery(queryId) {
      calls.push({ fn: "completeQuery", queryId });
    },
    async finalizeCancelled(queryId) {
      calls.push({ fn: "finalizeCancelled", queryId });
    },
  };
}

function makeFakeAuditLog() {
  const calls = [];
  return {
    calls,
    async record(userId, action, detail) {
      calls.push({ userId, action, detail });
    },
  };
}

// outcomes: { [toteId]: outcomeOrArrayOfOutcomes }. An array is consumed one
// entry per attempt (last entry repeats once exhausted). Also tracks
// concurrency so sequential-execution tests can assert on it directly.
function makeScriptedDispatcher(outcomes) {
  const cursors = {};
  const callOrder = [];
  let inFlight = 0;
  let maxInFlight = 0;

  async function dispatchOne({ toteId }) {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    callOrder.push(toteId);
    await sleep(2); // force a real async gap so overlap would be observable if it happened
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
function timedOut(queryId) {
  return { ok: true, query: { query_id: queryId, status: "TIMEOUT", error: null }, result: null };
}
function cancelled(queryId) {
  return { ok: true, query: { query_id: queryId, status: "CANCELLED", error: null }, result: null };
}
function dispatchFailed(reason = "No online, approved runtime currently advertises this capability") {
  return { ok: false, code: 503, reason };
}

async function waitUntilTerminal(engine, sessionId, timeoutMs = 3000, asUser = ADMIN) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = engine.get(sessionId, asUser);
    if (!got.ok) throw new Error(`engine.get(${sessionId}) failed: ${got.reason}`);
    if (got.session.status !== "RUNNING") return got.session;
    if (Date.now() > deadline) throw new Error("test timed out waiting for session to finish");
    await sleep(5);
  }
}

// ── Sequential execution ────────────────────────────────────────────────

test("sequential execution: dispatchOne is called once per tote, in order, never overlapping", async () => {
  const dispatchOne = makeScriptedDispatcher({
    TL0000000001: completed("Q-A", "INSERTED"),
    TL0000000002: completed("Q-B", "RELEASED"),
    TL0000000003: completed("Q-C", "INSERTED"),
  });
  const engine = new TotePullEngine({ dispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });

  const { session: created } = await engine.createAndStart({ user: USER, totes: ["TL0000000001", "TL0000000002", "TL0000000003"], zone: "5", instanceCode: "LK-069" });
  const final = await waitUntilTerminal(engine, created.sessionId);

  assert.equal(dispatchOne.maxInFlight(), 1, "no two dispatches should ever be in flight at once");
  assert.deepEqual(dispatchOne.callOrder, ["TL0000000001", "TL0000000002", "TL0000000003"], "totes must be called in exactly the submitted order");
  assert.equal(final.status, "COMPLETED");
  assert.equal(final.results.length, 3);
});

// ── All four Quadron verdicts ───────────────────────────────────────────

test("all four Quadron verdicts are recorded as COMPLETED terminal outcomes, none treated as a retry", async () => {
  const dispatchOne = makeScriptedDispatcher({
    TL0000000001: completed("Q-A", "INSERTED"),
    TL0000000002: completed("Q-B", "RELEASED"),
    TL0000000003: completed("Q-C", "ALREADY_QUEUED"),
    TL0000000004: completed("Q-D", "NOT_AVAILABLE"),
  });
  const engine = new TotePullEngine({ dispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });

  const { session: created } = await engine.createAndStart({ user: USER, totes: ["TL0000000001", "TL0000000002", "TL0000000003", "TL0000000004"], zone: "5", instanceCode: "LK-069" });
  const final = await waitUntilTerminal(engine, created.sessionId);

  assert.equal(final.status, "COMPLETED");
  const verdicts = final.results.map((r) => r.verdict);
  assert.deepEqual(verdicts, ["INSERTED", "RELEASED", "ALREADY_QUEUED", "NOT_AVAILABLE"]);
  assert.ok(final.results.every((r) => r.terminal === "COMPLETED"));
  assert.ok(final.results.every((r) => r.attempt === 1), "none of these should have needed a retry");
});

// ── Retry behavior ──────────────────────────────────────────────────────

test("retry: a FAILED outcome is retried and succeeds on a later attempt", async () => {
  const dispatchOne = makeScriptedDispatcher({
    TL0000000001: [failed("Q-A1"), failed("Q-A2"), completed("Q-A3", "INSERTED")],
  });
  const engine = new TotePullEngine({ dispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });

  const { session: created } = await engine.createAndStart({ user: USER, totes: ["TL0000000001"], zone: "5", instanceCode: "LK-069" });
  const final = await waitUntilTerminal(engine, created.sessionId);

  assert.equal(final.status, "COMPLETED");
  assert.equal(final.results[0].terminal, "COMPLETED");
  assert.equal(final.results[0].verdict, "INSERTED");
  assert.equal(final.results[0].attempt, 3);
});

test("retry: TIMEOUT is retried exactly like FAILED", async () => {
  const dispatchOne = makeScriptedDispatcher({ TL0000000001: [timedOut("Q-A1"), completed("Q-A2", "RELEASED")] });
  const engine = new TotePullEngine({ dispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });

  const { session: created } = await engine.createAndStart({ user: USER, totes: ["TL0000000001"], zone: "5", instanceCode: "LK-069" });
  const final = await waitUntilTerminal(engine, created.sessionId);

  assert.equal(final.results[0].verdict, "RELEASED");
  assert.equal(final.results[0].attempt, 2);
});

test("retry: a dispatch-level failure (no runtime available) is retried the same as a FAILED query", async () => {
  const dispatchOne = makeScriptedDispatcher({ TL0000000001: [dispatchFailed(), dispatchFailed(), completed("Q-A3", "INSERTED")] });
  const engine = new TotePullEngine({ dispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });

  const { session: created } = await engine.createAndStart({ user: USER, totes: ["TL0000000001"], zone: "5", instanceCode: "LK-069" });
  const final = await waitUntilTerminal(engine, created.sessionId);

  assert.equal(final.results[0].verdict, "INSERTED");
  assert.equal(final.results[0].attempt, 3);
});

// ── Failure handling: exhausted retries → SKIPPED, session continues ───

test("failure handling: exhausting all 5 attempts records SKIPPED and the session continues to the next tote", async () => {
  const dispatchOne = makeScriptedDispatcher({
    TL0000000001: failed("Q-A", "persistent network error"), // always fails
    TL0000000002: completed("Q-B", "INSERTED"),
  });
  const engine = new TotePullEngine({ dispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });

  const { session: created } = await engine.createAndStart({ user: USER, totes: ["TL0000000001", "TL0000000002"], zone: "5", instanceCode: "LK-069" });
  const final = await waitUntilTerminal(engine, created.sessionId);

  assert.equal(final.status, "COMPLETED", "the SESSION completes even though one tote was skipped");
  assert.equal(final.results[0].toteId, "TL0000000001");
  assert.equal(final.results[0].terminal, "SKIPPED");
  assert.equal(final.results[0].attempt, 5, "must exhaust exactly MAX_RETRIES attempts before giving up");
  assert.equal(final.results[0].reason, "persistent network error");
  assert.equal(final.results[1].toteId, "TL0000000002");
  assert.equal(final.results[1].terminal, "COMPLETED");
});

test("a CANCELLED underlying query stops the whole session, not just that tote", async () => {
  const dispatchOne = makeScriptedDispatcher({
    TL0000000001: cancelled("Q-A"),
    TL0000000002: completed("Q-B", "INSERTED"), // must never be reached
  });
  const engine = new TotePullEngine({ dispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });

  const { session: created } = await engine.createAndStart({ user: USER, totes: ["TL0000000001", "TL0000000002"], zone: "5", instanceCode: "LK-069" });
  const final = await waitUntilTerminal(engine, created.sessionId);

  assert.equal(final.status, "STOPPED");
  assert.equal(final.results.length, 1);
  assert.equal(final.results[0].terminal, "CANCELLED");
  assert.deepEqual(dispatchOne.callOrder, ["TL0000000001"], "tote B must never be dispatched");
});

// ── Stop behavior ────────────────────────────────────────────────────────

test("stop(): halts before the next tote, never aborts the tote already in flight, remaining totes are simply not attempted", async () => {
  let releaseA;
  const gate = new Promise((r) => (releaseA = r));
  const calls = [];
  const dispatchOne = async ({ toteId }) => {
    calls.push(toteId);
    if (toteId === "TL0000000001") await gate; // hold tote A "in flight" until the test releases it
    return completed(`Q-${toteId}`, "INSERTED");
  };

  const engine = new TotePullEngine({ dispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });
  const { session: created } = await engine.createAndStart({ user: USER, totes: ["TL0000000001", "TL0000000002", "TL0000000003"], zone: "5", instanceCode: "LK-069" });

  await sleep(10); // let the engine actually start dispatching A
  const stopResult = engine.stop(created.sessionId, USER);
  assert.equal(stopResult.ok, true);

  releaseA(); // let the in-flight A finish naturally - stop() never aborts it
  const final = await waitUntilTerminal(engine, created.sessionId);

  assert.equal(final.status, "STOPPED");
  assert.deepEqual(calls, ["TL0000000001"], "B and C must never be dispatched once stop was requested");
  assert.equal(final.results.length, 1);
  assert.equal(final.results[0].toteId, "TL0000000001");
  assert.equal(final.results[0].terminal, "COMPLETED", "the in-flight pull that was already running is allowed to finish normally");
});

test("stop() on an already-finished session is rejected with 409", async () => {
  const dispatchOne = makeScriptedDispatcher({ TL0000000001: completed("Q-A", "INSERTED") });
  const engine = new TotePullEngine({ dispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });
  const { session: created } = await engine.createAndStart({ user: USER, totes: ["TL0000000001"], zone: "5", instanceCode: "LK-069" });
  await waitUntilTerminal(engine, created.sessionId);

  const result = engine.stop(created.sessionId, USER);
  assert.equal(result.ok, false);
  assert.equal(result.code, 409);
});

test("stop() by a different, non-admin user is rejected with 403", async () => {
  const dispatchOne = makeScriptedDispatcher({ TL0000000001: [failed("Q-A")] });
  const engine = new TotePullEngine({ dispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 50 });
  const { session: created } = await engine.createAndStart({ user: USER, totes: ["TL0000000001"], zone: "5", instanceCode: "LK-069" });

  const otherUser = { id: 2, role: "USER" };
  const result = engine.stop(created.sessionId, otherUser);
  assert.equal(result.ok, false);
  assert.equal(result.code, 403);

  engine.stop(created.sessionId, ADMIN); // clean up so the test doesn't leave a dangling timer
});

// ── Input validation ────────────────────────────────────────────────────

test("createAndStart rejects an empty tote list, an invalid tote id, a missing zone, and a missing instanceCode", async () => {
  const engine = new TotePullEngine({ dispatchOne: async () => completed("Q-X", "INSERTED"), queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog() });

  assert.equal((await engine.createAndStart({ user: USER, totes: [], zone: "5", instanceCode: "LK-069" })).code, 400);
  assert.equal((await engine.createAndStart({ user: USER, totes: ["BADID"], zone: "5", instanceCode: "LK-069" })).code, 400);
  assert.equal((await engine.createAndStart({ user: USER, totes: ["TL0000002607"], zone: "", instanceCode: "LK-069" })).code, 400);
  assert.equal((await engine.createAndStart({ user: USER, totes: ["TL0000002607"], zone: "5", instanceCode: "" })).code, 400);
});

test("createAndStart rejects a multi-zone config whose percentages don't sum to exactly 100", async () => {
  const engine = new TotePullEngine({ dispatchOne: async () => completed("Q-X", "INSERTED"), queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog() });
  const result = await engine.createAndStart({
    user: USER,
    totes: ["TL0000002607"],
    multiZone: true,
    zones: [
      { id: "a", zone: "5", instanceCode: "LK-069", percentage: 60 },
      { id: "b", zone: "12", instanceCode: "LK-070", percentage: 30 },
    ],
  });
  assert.equal(result.code, 400);
  assert.match(result.reason, /90%/);
});

// ── Multi-zone integration (end-to-end through the real Engine, not just
//    the pure zonePicker unit) ──────────────────────────────────────────

test("multi-zone: each dispatched call receives the exact zone/instanceCode pickNextZone would select, and results record it", async () => {
  const seen = [];
  const dispatchOne = async ({ toteId, zone, instanceCode }) => {
    seen.push({ toteId, zone, instanceCode });
    return completed(`Q-${toteId}`, "INSERTED");
  };
  const engine = new TotePullEngine({ dispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });

  const { session: created } = await engine.createAndStart({
    user: USER,
    totes: ["TL0000000001", "TL0000000002", "TL0000000003"],
    multiZone: true,
    zones: [
      { id: "z5", zone: "5", instanceCode: "LK-A", percentage: 70 },
      { id: "z12", zone: "12", instanceCode: "LK-B", percentage: 30 },
    ],
  });
  const final = await waitUntilTerminal(engine, created.sessionId);

  // Matches the Blueprint's 70/30 sequence exactly for the first 3 calls.
  assert.deepEqual(seen, [
    { toteId: "TL0000000001", zone: "5", instanceCode: "LK-A" },
    { toteId: "TL0000000002", zone: "12", instanceCode: "LK-B" },
    { toteId: "TL0000000003", zone: "5", instanceCode: "LK-A" },
  ]);
  assert.deepEqual(
    final.results.map((r) => ({ toteId: r.toteId, zone: r.zone, instanceCode: r.instanceCode })),
    seen
  );
});

test("multi-zone: credits reset between sessions - a second session reproduces the same opening sequence as the first", async () => {
  const dispatchOne = async ({ toteId }) => completed(`Q-${toteId}`, "INSERTED");
  const zones = [
    { id: "z5", zone: "5", instanceCode: "LK-A", percentage: 70 },
    { id: "z12", zone: "12", instanceCode: "LK-B", percentage: 30 },
  ];

  const engine1 = new TotePullEngine({ dispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });
  const { session: s1 } = await engine1.createAndStart({ user: USER, totes: ["TL0000000001", "TL0000000002"], multiZone: true, zones });
  const f1 = await waitUntilTerminal(engine1, s1.sessionId);

  const engine2 = new TotePullEngine({ dispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });
  const { session: s2 } = await engine2.createAndStart({ user: USER, totes: ["TL0000000003", "TL0000000004"], multiZone: true, zones });
  const f2 = await waitUntilTerminal(engine2, s2.sessionId);

  assert.deepEqual(f1.results.map((r) => r.zone), ["5", "12"]);
  assert.deepEqual(f2.results.map((r) => r.zone), ["5", "12"], "a fresh session must not inherit the previous session's accumulated credit");
});

// ── Global single-flight, using the REAL lock (not a mock of it) ───────

test("single-flight enforcement: two sessions running concurrently, sharing the real quadronPullLock, never dispatch overlapping pulls", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];

  // dispatchOne wraps the REAL withPullLock, exactly as quadronPull.pullOneTote
  // does in production - this is what proves cross-session exclusivity, not
  // merely the Engine's own single-await-at-a-time discipline within one session.
  async function realLockDispatchOne({ toteId }) {
    return withPullLock(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(toteId);
      await sleep(5);
      inFlight--;
      return completed(`Q-${toteId}`, "INSERTED");
    });
  }

  const engineA = new TotePullEngine({ dispatchOne: realLockDispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });
  const engineB = new TotePullEngine({ dispatchOne: realLockDispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });

  // Started back-to-back, no await between them - genuinely concurrent attempts.
  const startA = engineA.createAndStart({ user: USER, totes: ["TL0000000011", "TL0000000012", "TL0000000013"], zone: "5", instanceCode: "LK-069" });
  const startB = engineB.createAndStart({ user: { id: 2, role: "USER" }, totes: ["TS0000000021", "TS0000000022", "TS0000000023"], zone: "12", instanceCode: "LK-069" });
  const [{ session: sessA }, { session: sessB }] = await Promise.all([startA, startB]);

  const finalA = await waitUntilTerminal(engineA, sessA.sessionId);
  const finalB = await waitUntilTerminal(engineB, sessB.sessionId);

  assert.equal(maxInFlight, 1, "PULL A + PULL B must never be concurrent, across two different sessions");
  assert.equal(order.length, 6, "all six totes across both sessions were eventually dispatched");
  assert.equal(finalA.status, "COMPLETED");
  assert.equal(finalB.status, "COMPLETED");
});

test("duplicate concurrent engine dispatch attempts: starting the same tote list twice at once still only ever runs one dispatch at a time", async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  async function realLockDispatchOne({ toteId }) {
    return withPullLock(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      inFlight--;
      return completed(`Q-${toteId}-${Date.now()}`, "INSERTED");
    });
  }

  const engine = new TotePullEngine({ dispatchOne: realLockDispatchOne, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1 });

  const p1 = engine.createAndStart({ user: USER, totes: ["TL0000000001", "TL0000000002"], zone: "5", instanceCode: "LK-069" });
  const p2 = engine.createAndStart({ user: USER, totes: ["TL0000000003", "TL0000000004"], zone: "5", instanceCode: "LK-069" });
  const [r1, r2] = await Promise.all([p1, p2]);

  const f1 = await waitUntilTerminal(engine, r1.session.sessionId);
  const f2 = await waitUntilTerminal(engine, r2.session.sessionId);

  assert.equal(maxInFlight, 1);
  assert.equal(f1.status, "COMPLETED");
  assert.equal(f2.status, "COMPLETED");
});

// ── Purge pulls ─────────────────────────────────────────────────────────

function makeFakePurgeMarks({ failRecord = false } = {}) {
  const recorded = [];
  return { recorded, async record(totes, meta) { if (failRecord) throw new Error("db down"); recorded.push({ totes, ...meta }); } };
}

test("purpose PURGE: the totes are recorded as purged BEFORE the first pull, and the purpose rides on the session and audit", async () => {
  const purgeMarks = makeFakePurgeMarks();
  const auditLog = makeFakeAuditLog();
  const order = [];
  const dispatchOne = async ({ toteId }) => { order.push("pull:" + toteId + ":marks=" + purgeMarks.recorded.length); return completed("Q-P", "INSERTED"); };
  const engine = new TotePullEngine({ dispatchOne, queryManager: makeFakeQueryManager(), auditLog, retryDelayMs: 1, purgeMarks });
  const { session } = await engine.createAndStart({ user: USER, totes: ["TL0000000001", "TL0000000002"], zone: "5", instanceCode: "LK-069", purpose: "PURGE" });
  const done = await waitUntilTerminal(engine, session.sessionId);
  assert.equal(done.purpose, "PURGE");
  assert.deepEqual(purgeMarks.recorded.map((r) => r.totes), [["TL0000000001", "TL0000000002"]]);
  assert.ok(order.every((o) => o.endsWith("marks=1")), "recorded before any pull");
  const finished = auditLog.calls.find((c) => c.action === "TOTE_ENGINE_SESSION_COMPLETED");
  assert.equal(finished.detail.purpose, "PURGE");
});

test("a normal pull records nothing as purged", async () => {
  const purgeMarks = makeFakePurgeMarks();
  const engine = new TotePullEngine({ dispatchOne: async () => completed("Q-N", "INSERTED"), queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1, purgeMarks });
  const { session } = await engine.createAndStart({ user: USER, totes: ["TL0000000001"], zone: "5", instanceCode: "LK-069" });
  const done = await waitUntilTerminal(engine, session.sessionId);
  assert.equal(done.purpose, "NORMAL");
  assert.equal(purgeMarks.recorded.length, 0);
});

test("if the purge cannot be recorded, nothing is pulled", async () => {
  let pulls = 0;
  const engine = new TotePullEngine({ dispatchOne: async () => { pulls += 1; return completed("Q-X", "INSERTED"); }, queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1, purgeMarks: makeFakePurgeMarks({ failRecord: true }) });
  const res = await engine.createAndStart({ user: USER, totes: ["TL0000000001"], zone: "5", instanceCode: "LK-069", purpose: "PURGE" });
  assert.equal(res.ok, false);
  assert.equal(res.code, 500);
  await sleep(20);
  assert.equal(pulls, 0);
});

test("a finished PURGE session calls the baseline hook once; a normal one never does; a failing hook does not break the session", async () => {
  const done = [];
  const mk = () => new TotePullEngine({ dispatchOne: async () => completed("Q-H", "INSERTED"), queryManager: makeFakeQueryManager(), auditLog: makeFakeAuditLog(), retryDelayMs: 1, purgeMarks: makeFakePurgeMarks() });

  const purge = mk();
  purge.onPurgeSessionDone = async (id) => { done.push(id); throw new Error("quadron down"); };
  const { session } = await purge.createAndStart({ user: USER, totes: ["TL0000000001"], zone: "5", instanceCode: "LK-069", purpose: "PURGE" });
  await waitUntilTerminal(purge, session.sessionId);
  await sleep(10);
  assert.deepEqual(done, [session.sessionId]);

  const normal = mk();
  normal.onPurgeSessionDone = async (id) => { done.push("normal:" + id); };
  const n = await normal.createAndStart({ user: USER, totes: ["TL0000000001"], zone: "5", instanceCode: "LK-069" });
  await waitUntilTerminal(normal, n.session.sessionId);
  await sleep(10);
  assert.equal(done.length, 1);
});
