// Pure unit tests for server/integrations/quadron/pullRateLimiter.js - zero dependencies, no
// database, no network, no Quadron call of any kind.

const test = require("node:test");
const assert = require("node:assert/strict");
const pullRateLimiter = require("../../../integrations/quadron/pullRateLimiter");

test.beforeEach(() => {
  pullRateLimiter.reset();
});

test("snapshot(): starts empty - count 0, remaining == max, not limit-reached", () => {
  pullRateLimiter.configure({ max: 3, windowMs: 60000 });
  const s = pullRateLimiter.snapshot();
  assert.equal(s.count, 0);
  assert.equal(s.remaining, 3);
  assert.equal(s.limitReached, false);
  assert.equal(s.nextFreeAt, null);
});

test("record(): each call increments count, decrements remaining, until the max is reached", () => {
  pullRateLimiter.configure({ max: 3, windowMs: 60000 });
  pullRateLimiter.record();
  assert.equal(pullRateLimiter.snapshot().count, 1);
  pullRateLimiter.record();
  pullRateLimiter.record();
  const s = pullRateLimiter.snapshot();
  assert.equal(s.count, 3);
  assert.equal(s.remaining, 0);
  assert.equal(s.limitReached, true);
});

test("limitReached is true the instant count reaches max, never allowing count to exceed it silently in the caller's own bookkeeping", () => {
  pullRateLimiter.configure({ max: 1, windowMs: 60000 });
  assert.equal(pullRateLimiter.snapshot().limitReached, false);
  pullRateLimiter.record();
  assert.equal(pullRateLimiter.snapshot().limitReached, true);
});

test("a timestamp older than the window is pruned on the next snapshot() - the window genuinely rolls, not a fixed bucket", async () => {
  pullRateLimiter.configure({ max: 1, windowMs: 50 });
  pullRateLimiter.record();
  assert.equal(pullRateLimiter.snapshot().limitReached, true);
  await new Promise((r) => setTimeout(r, 80));
  const s = pullRateLimiter.snapshot();
  assert.equal(s.count, 0, "the single old timestamp must have aged out of the 50ms window");
  assert.equal(s.limitReached, false);
});

test("nextFreeAt is null unless the limit is currently reached, and points at exactly when the oldest counted pull expires", () => {
  pullRateLimiter.configure({ max: 1, windowMs: 1000 });
  assert.equal(pullRateLimiter.snapshot().nextFreeAt, null);
  const before = Date.now();
  pullRateLimiter.record();
  const s = pullRateLimiter.snapshot();
  assert.ok(s.nextFreeAt >= before + 1000 && s.nextFreeAt <= Date.now() + 1000, "nextFreeAt should be ~windowMs after the recorded pull");
});

test("only entries within the window count - a mix of expired and live timestamps prunes correctly", async () => {
  pullRateLimiter.configure({ max: 5, windowMs: 60 });
  pullRateLimiter.record(); // will expire
  await new Promise((r) => setTimeout(r, 80));
  pullRateLimiter.record(); // still live
  pullRateLimiter.record(); // still live
  const s = pullRateLimiter.snapshot();
  assert.equal(s.count, 2, "only the two most recent recordings should still be inside the window");
});

test("configure() with an invalid (non-numeric, zero, negative) value leaves the existing setting unchanged", () => {
  pullRateLimiter.configure({ max: 7, windowMs: 5000 });
  pullRateLimiter.configure({ max: 0, windowMs: -100 });
  pullRateLimiter.configure({ max: "nope", windowMs: null });
  const s = pullRateLimiter.snapshot();
  assert.equal(s.max, 7);
  assert.equal(s.windowMs, 5000);
});

test("reset(): clears recorded timestamps AND restores the default max/windowMs", () => {
  pullRateLimiter.configure({ max: 1, windowMs: 1000 });
  pullRateLimiter.record();
  assert.equal(pullRateLimiter.snapshot().limitReached, true);
  pullRateLimiter.reset();
  const s = pullRateLimiter.snapshot();
  assert.equal(s.count, 0);
  assert.equal(s.max, pullRateLimiter.DEFAULT_MAX_PULLS);
  assert.equal(s.windowMs, pullRateLimiter.DEFAULT_WINDOW_MS);
});

test("snapshot() returns a defensive copy of timestamps - mutating the returned array never affects internal state", () => {
  pullRateLimiter.configure({ max: 5, windowMs: 60000 });
  pullRateLimiter.record();
  const s1 = pullRateLimiter.snapshot();
  s1.timestamps.push(123456789);
  const s2 = pullRateLimiter.snapshot();
  assert.equal(s2.count, 1, "external mutation of a returned snapshot must never leak into the module's own state");
});
