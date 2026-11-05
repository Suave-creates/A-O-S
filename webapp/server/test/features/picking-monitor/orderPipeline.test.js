const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOrderPipeline, GROUPS, ALL_KEYS } = require("../../../features/picking-monitor/orderPipeline");

const full = Object.fromEntries(ALL_KEYS.map((k, i) => [k, i * 10]));

test("the strip is the order flow only, and tiles carry their counts and scope", () => {
  const r = buildOrderPipeline({ metrics: full, filters: { type: "ALL", priority: "ALL" }, windowMin: 60 });
  assert.deepEqual(r.groups.map((g) => g.key), ["flow"]);
  assert.deepEqual(r.groups[0].tiles.map((t) => t.key), ["synced", "created", "inProgress", "allocated", "completed"]);
  const completed = r.groups[0].tiles.find((t) => t.key === "completed");
  assert.equal(completed.value, full.completed);
  assert.equal(completed.scope, "window");
  assert.equal(r.groups[0].tiles.find((t) => t.key === "allocated").scope, "now");
  assert.deepEqual(r.unavailable, [], "a real 0 (the first metric here) is a value, not a gap");
});

test("a count that could not be read stays null with its reason - never 0", () => {
  const r = buildOrderPipeline({ metrics: { ...full, inProgress: null }, errors: { inProgress: "Grafana HTTP 500" }, filters: {}, windowMin: 15 });
  const tile = r.groups[0].tiles.find((t) => t.key === "inProgress");
  assert.equal(tile.value, null);
  assert.equal(tile.error, "Grafana HTTP 500");
  assert.deepEqual(r.unavailable, ["inProgress"]);
  // a genuine zero is a real value
  const zero = buildOrderPipeline({ metrics: { ...full, completed: 0 }, filters: {}, windowMin: 15 });
  assert.equal(zero.groups[0].tiles.find((t) => t.key === "completed").value, 0);
  assert.deepEqual(zero.unavailable.includes("completed"), false);
});

test("a missing metric is unavailable, and no counts at all is rejected", () => {
  const { created, ...rest } = full;
  assert.deepEqual(buildOrderPipeline({ metrics: rest, filters: {}, windowMin: 60 }).unavailable, ["created"]);
  assert.throws(() => buildOrderPipeline({ metrics: null }), /pipeline counts/);
  assert.equal(GROUPS.every((g) => g.tiles.every((t) => t.label && t.help)), true);
});
