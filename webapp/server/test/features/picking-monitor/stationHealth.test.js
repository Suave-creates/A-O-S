const test = require("node:test");
const assert = require("node:assert/strict");
const h = require("../../../features/picking-monitor/stationHealth");

test("priority comes from the configured weight: 0 normal, 300000000 priority, anything else needs a supervisor", () => {
  assert.equal(h.priorityClass(0), "NONPRIORITY");
  assert.equal(h.priorityClass(300000000), "PRIORITY");
  for (const w of [25000000, 1, 300000001, null, undefined]) assert.equal(h.priorityClass(w), "CHECK", String(w));
});

test("non-priority bands: green above 85%, yellow 70-85%, red below 70% of 300/hour", () => {
  assert.equal(h.healthOf("NONPRIORITY", 85.4), "green");
  assert.equal(h.healthOf("NONPRIORITY", 85), "yellow");
  assert.equal(h.healthOf("NONPRIORITY", 70), "yellow");
  assert.equal(h.healthOf("NONPRIORITY", 69.9), "red");
});

test("priority bands: green above 65%, yellow 50-65%, red below 50%", () => {
  assert.equal(h.healthOf("PRIORITY", 65.1), "green");
  assert.equal(h.healthOf("PRIORITY", 65), "yellow");
  assert.equal(h.healthOf("PRIORITY", 50), "yellow");
  assert.equal(h.healthOf("PRIORITY", 49.9), "red");
  assert.equal(h.healthOf("CHECK", 90), null, "a station to be checked gets no verdict");
});

test("assess scales the window to an hour against the 300 design capacity, and only judges stations that are picking", () => {
  const picking = { id: "GS1", loggedIn: true, operationType: "PICKING", priorityWeight: 0 };
  const a = h.assess(picking, 64, 15); // 256 / hour = 85.3%
  assert.equal(a.ratePerHour, 256);
  assert.equal(a.pct, 85);
  assert.equal(a.health, "green", "judged on the exact 85.3%, not the rounded 85");
  assert.equal(h.assess({ ...picking, priorityWeight: 300000000 }, 100, 60).health, "red");
  assert.equal(h.assess({ ...picking, loggedIn: false }, 300, 60).health, null);
  assert.equal(h.assess({ ...picking, operationType: "COMPACTION" }, 300, 60).health, null);
  assert.equal(h.assess(undefined, 300, 60).known, false);
});
