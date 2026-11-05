// Unit tests for server/features/tote-puller/toteDispatchLoop.js's pull-rate-limiter
// enforcement specifically (the shared dispatch point both Manual and Auto
// use). Retry/zone-selection behavior itself is already fully covered
// indirectly via totePullEngine.test.js/autoEngine.test.js - these tests
// focus only on the NEW rolling-window wait/record behavior.

const test = require("node:test");
const assert = require("node:assert/strict");
const { dispatchToteWithRetry } = require("../../../features/tote-puller/toteDispatchLoop");
const pullRateLimiter = require("../../../integrations/quadron/pullRateLimiter");

test.beforeEach(() => {
  pullRateLimiter.reset();
});

function completedDispatch() {
  return async ({ toteId }) => ({
    ok: true,
    query: { query_id: "Q-1", status: "COMPLETED" },
    result: { verdict: "PICKED", rawMessage: "ok" },
  });
}

test("a normal dispatch (limiter nowhere near its cap) proceeds immediately and records exactly one pull", async () => {
  pullRateLimiter.configure({ max: 100, windowMs: 60000 });
  const outcome = await dispatchToteWithRetry({
    dispatchOne: completedDispatch(),
    retryDelayMs: 5,
    user: { id: 1 },
    toteId: "TL0000000001",
    sessionId: "S1",
    zoneConfig: { multiZone: false, zone: "5", instanceCode: "LK-069" },
    zoneCredits: {},
  });
  assert.equal(outcome.terminal, "COMPLETED");
  assert.equal(pullRateLimiter.snapshot().count, 1);
});

test("when the rolling window is already at its cap, dispatch WAITS (never errors the tote out) until a slot frees", async () => {
  pullRateLimiter.configure({ max: 1, windowMs: 80 });
  pullRateLimiter.record(); // pre-fill the single slot
  assert.equal(pullRateLimiter.snapshot().limitReached, true);

  const startedAt = Date.now();
  const outcome = await dispatchToteWithRetry({
    dispatchOne: completedDispatch(),
    retryDelayMs: 5,
    user: { id: 1 },
    toteId: "TL0000000002",
    sessionId: "S1",
    zoneConfig: { multiZone: false, zone: "5", instanceCode: "LK-069" },
    zoneCredits: {},
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(outcome.terminal, "COMPLETED", "the tote must still complete once the window frees - waiting, not failing");
  assert.ok(elapsed >= 80, `must have actually waited for the pre-filled slot to expire (waited ${elapsed}ms)`);
});

test("a stop request while waiting on the rate limit is honored - returns null, never dispatches", async () => {
  pullRateLimiter.configure({ max: 1, windowMs: 10 * 60000 }); // effectively never frees within this test
  pullRateLimiter.record();

  let dispatchCalled = false;
  let stopRequested = false;
  setTimeout(() => {
    stopRequested = true;
  }, 20);

  const outcome = await dispatchToteWithRetry({
    dispatchOne: async () => {
      dispatchCalled = true;
      return { ok: true, query: { query_id: "Q-1", status: "COMPLETED" }, result: { verdict: "PICKED" } };
    },
    retryDelayMs: 5,
    user: { id: 1 },
    toteId: "TL0000000003",
    sessionId: "S1",
    zoneConfig: { multiZone: false, zone: "5", instanceCode: "LK-069" },
    zoneCredits: {},
    isStopRequested: () => stopRequested,
  });

  assert.equal(outcome, null);
  assert.equal(dispatchCalled, false, "a stop request while waiting on the limiter must prevent the dispatch from ever happening");
});

test("every real dispatch attempt counts toward the cap, including ones that trigger a retry (not just the final terminal outcome)", async () => {
  pullRateLimiter.configure({ max: 100, windowMs: 60000 });
  let calls = 0;
  const outcome = await dispatchToteWithRetry({
    dispatchOne: async () => {
      calls++;
      if (calls < 3) return { ok: true, query: { query_id: "Q-" + calls, status: "FAILED", error: "transient" } };
      return { ok: true, query: { query_id: "Q-3", status: "COMPLETED" }, result: { verdict: "PICKED" } };
    },
    retryDelayMs: 5,
    user: { id: 1 },
    toteId: "TL0000000004",
    sessionId: "S1",
    zoneConfig: { multiZone: false, zone: "5", instanceCode: "LK-069" },
    zoneCredits: {},
  });
  assert.equal(outcome.terminal, "COMPLETED");
  assert.equal(calls, 3);
  assert.equal(pullRateLimiter.snapshot().count, 3, "all 3 attempts (2 retries + the final success) must each count toward the rolling window");
});

// ── resolution: did a skipped pull definitely fail, or may it have gone through? ─────────────────────

function dispatchSequence(results) {
  let i = 0;
  return async () => results[Math.min(i++, results.length - 1)];
}
async function skipped(results) {
  pullRateLimiter.configure({ max: 1000, windowMs: 60000 });
  return dispatchToteWithRetry({
    dispatchOne: dispatchSequence(results),
    retryDelayMs: 1,
    user: { id: 1 },
    toteId: "TL0000000009",
    sessionId: "S1",
    zoneConfig: { multiZone: false, zone: "5", instanceCode: "LK-069" },
    zoneCredits: {},
  });
}

test("refused every attempt (never reached Quadron) -> SKIPPED with resolution 'failed'", async () => {
  const outcome = await skipped([{ ok: false, reason: "no online runtime" }]);
  assert.equal(outcome.terminal, "SKIPPED");
  assert.equal(outcome.resolution, "failed");
});

test("query reported FAILED on every attempt -> resolution 'failed'", async () => {
  const outcome = await skipped([{ ok: true, query: { query_id: "Q-1", status: "FAILED", error: "boom" } }]);
  assert.equal(outcome.resolution, "failed");
});

test("a TIMEOUT on the last attempt -> resolution 'uncertain'", async () => {
  const outcome = await skipped([{ ok: true, query: { query_id: "Q-1", status: "TIMEOUT" } }]);
  assert.equal(outcome.terminal, "SKIPPED");
  assert.equal(outcome.resolution, "uncertain");
});

test("an earlier TIMEOUT followed by clean failures stays 'uncertain' (the timed-out pull may have executed)", async () => {
  const outcome = await skipped([
    { ok: true, query: { query_id: "Q-1", status: "TIMEOUT" } },
    { ok: false, reason: "no online runtime" },
  ]);
  assert.equal(outcome.resolution, "uncertain");
});
