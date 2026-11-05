// Pure unit tests for server/integrations/quadron/quadronPullLock.js - zero dependencies, no
// database, no network, no Quadron call of any kind. This module is a plain
// async mutex; these tests prove its actual concurrency guarantee directly.

const test = require("node:test");
const assert = require("node:assert/strict");

function freshLock() {
  // Each test gets an independent module instance so tests can't leak
  // pending state into each other via Node's require cache.
  delete require.cache[require.resolve("../../../integrations/quadron/quadronPullLock")];
  return require("../../../integrations/quadron/quadronPullLock");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("withPullLock: two concurrent calls never overlap", async () => {
  const { withPullLock } = freshLock();
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];

  async function work(label, ms) {
    return withPullLock(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(ms);
      order.push(label);
      inFlight--;
    });
  }

  // Fired without awaiting between them - genuinely concurrent call sites.
  const p1 = work("A", 30);
  const p2 = work("B", 10);
  await Promise.all([p1, p2]);

  assert.equal(maxInFlight, 1, "at most one unit of work should ever be in flight");
  // A was queued first, so it must finish first even though B's own work is shorter.
  assert.deepEqual(order, ["A", "B"]);
});

test("withPullLock: a rejecting call does not break the queue for the next caller", async () => {
  const { withPullLock } = freshLock();
  const results = [];

  const p1 = withPullLock(async () => {
    throw new Error("boom");
  }).catch((e) => results.push("A:" + e.message));

  const p2 = withPullLock(async () => {
    results.push("B:ran");
    return "ok";
  });

  await Promise.all([p1, p2]);
  assert.deepEqual(results, ["A:boom", "B:ran"]);
});

test("isBusy(): true while a call is in flight, false once it settles", async () => {
  const { withPullLock, isBusy } = freshLock();
  assert.equal(isBusy(), false);

  let releaseWork;
  const gate = new Promise((r) => (releaseWork = r));
  const p = withPullLock(async () => {
    await gate;
  });

  assert.equal(isBusy(), true, "should be busy immediately - no await needed to observe it");
  releaseWork();
  await p;
  assert.equal(isBusy(), false);
});

test("isBusy(): still true for a queued (not yet running) second caller", async () => {
  const { withPullLock, isBusy } = freshLock();
  let releaseFirst;
  const gate = new Promise((r) => (releaseFirst = r));

  const p1 = withPullLock(async () => {
    await gate;
  });
  const p2 = withPullLock(async () => {
    await sleep(5);
  });

  assert.equal(isBusy(), true);
  releaseFirst();
  await Promise.all([p1, p2]);
  assert.equal(isBusy(), false);
});

test("withPullLock: three calls fired simultaneously (no await between them) still run strictly one at a time, in call order", async () => {
  const { withPullLock } = freshLock();
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];

  function work(label) {
    return withPullLock(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      order.push(label);
      inFlight--;
    });
  }

  await Promise.all([work("A"), work("B"), work("C")]);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(order, ["A", "B", "C"]);
});
