// Pure unit tests for server/integrations/capabilities/requestCoalescer.js. No network,
// no runtime, no queryManager - just the key-building/in-flight/cache
// state machine itself.

const test = require("node:test");
const assert = require("node:assert/strict");
const coalescer = require("../../../integrations/capabilities/requestCoalescer");

test.beforeEach(() => coalescer.reset());

// ── buildKey ─────────────────────────────────────────────────────────────

test("buildKey is stable regardless of key insertion order in params", () => {
  const a = coalescer.buildKey("GET_NEXS_BLOCKED_INVENTORY_BATCH", { facilityCode: "NXS1", pids: ["1", "2"] });
  const b = coalescer.buildKey("GET_NEXS_BLOCKED_INVENTORY_BATCH", { pids: ["1", "2"], facilityCode: "NXS1" });
  assert.equal(a, b);
});

test("buildKey differs for different capability names with identical params", () => {
  const a = coalescer.buildKey("GET_GRAFANA_LOCKED_TOTES", { x: 1 });
  const b = coalescer.buildKey("GET_QUADRON_INVENTORY", { x: 1 });
  assert.notEqual(a, b);
});

test("buildKey differs for meaningfully different params", () => {
  const a = coalescer.buildKey("GET_GRAFANA_TOTE_FINDER", { totes: ["TL1"] });
  const b = coalescer.buildKey("GET_GRAFANA_TOTE_FINDER", { totes: ["TL2"] });
  assert.notEqual(a, b);
});

test("buildKey treats undefined/null params the same as an empty object - a no-params capability always gets the same key", () => {
  const a = coalescer.buildKey("GET_GRAFANA_LOCKED_TOTES", undefined);
  const b = coalescer.buildKey("GET_GRAFANA_LOCKED_TOTES", null);
  const c = coalescer.buildKey("GET_GRAFANA_LOCKED_TOTES", {});
  assert.equal(a, b);
  assert.equal(b, c);
});

// ── in-flight tracking ──────────────────────────────────────────────────

test("getInFlight returns null when nothing is tracked for a key", () => {
  assert.equal(coalescer.getInFlight("some-key"), null);
});

test("setInFlight/getInFlight round-trips the exact same promise reference", () => {
  const p = Promise.resolve("x");
  coalescer.setInFlight("k1", p);
  assert.equal(coalescer.getInFlight("k1"), p);
  p.catch(() => {});
});

test("clearInFlight removes tracking so a later getInFlight returns null again", () => {
  coalescer.setInFlight("k1", Promise.resolve("x").catch(() => {}));
  coalescer.clearInFlight("k1");
  assert.equal(coalescer.getInFlight("k1"), null);
});

test("in-flight tracking is per-key - unrelated keys never see each other's entries", () => {
  const p1 = Promise.resolve("a");
  coalescer.setInFlight("k1", p1);
  assert.equal(coalescer.getInFlight("k2"), null);
  p1.catch(() => {});
});

// ── result cache ─────────────────────────────────────────────────────────

test("getCached returns null when nothing has ever been cached for a key", () => {
  assert.equal(coalescer.getCached("k1"), null);
});

test("setCached then getCached (within the TTL window) returns the exact cached value", () => {
  const result = { rows: [1, 2, 3] };
  coalescer.setCached("k1", result, { now: 1000 });
  assert.equal(coalescer.getCached("k1", { ttlMs: 3000, now: 2000 }), result);
});

test("getCached returns null once the TTL window has elapsed - never serves stale data past its budget", () => {
  coalescer.setCached("k1", { rows: [] }, { now: 1000 });
  assert.equal(coalescer.getCached("k1", { ttlMs: 3000, now: 4001 }), null);
});

test("getCached returns the value exactly AT the TTL boundary (inclusive) and null just past it", () => {
  coalescer.setCached("k1", { rows: [] }, { now: 1000 });
  assert.notEqual(coalescer.getCached("k1", { ttlMs: 3000, now: 4000 }), null);
  assert.equal(coalescer.getCached("k1", { ttlMs: 3000, now: 4001 }), null);
});

test("getCached with ttlMs: 0 (caching disabled) always returns null, regardless of how recent the entry is", () => {
  coalescer.setCached("k1", { rows: [] }, { now: 1000 });
  assert.equal(coalescer.getCached("k1", { ttlMs: 0, now: 1000 }), null);
});

test("a fresh setCached() overwrites a previous entry for the same key", () => {
  coalescer.setCached("k1", { rows: ["old"] }, { now: 1000 });
  coalescer.setCached("k1", { rows: ["new"] }, { now: 1500 });
  const cached = coalescer.getCached("k1", { ttlMs: 3000, now: 1600 });
  assert.deepEqual(cached, { rows: ["new"] });
});

test("reset() clears both in-flight tracking and the result cache", () => {
  coalescer.setInFlight("k1", Promise.resolve().catch(() => {}));
  coalescer.setCached("k1", { rows: [] }, { now: 1000 });
  coalescer.reset();
  assert.equal(coalescer.getInFlight("k1"), null);
  assert.equal(coalescer.getCached("k1", { ttlMs: 999999, now: 1000 }), null);
});
