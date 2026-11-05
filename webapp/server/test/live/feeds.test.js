// The registry of live topics: who may subscribe to what, and the scopes that
// keep per-user data per-user. Uses the real hub with the real feed
// definitions but never subscribes (so nothing is fetched).

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHub } = require("../../live/liveHub");
const { registerFeeds } = require("../../live/feeds");

const hub = createHub();
registerFeeds(hub);

const OPERATOR = { id: 5, role: "OPERATOR" };
const ADMIN = { id: 1, role: "ADMIN" };

test("every expected live topic is registered", () => {
  const expected = [
    "connections", "dashboard.compaction", "dashboard.aisle", "dashboard.cc", "dashboard.outside", "dashboard.utilisation", "dashboard-detail", "alerts", "asrs-locations.current", "asrs-locations.marks", "aisle-occupancy.current",
    "locked-tote-info.current", "locked-tote-info.latest", "locked-tote-info.history", "tote-utilisation.history", "one-pager.current",
    "tote-purge.current", "one-pager.bulk", "auto.session", "auto.active", "picking.monitor", "picking.pipeline", "admin.queries", "operations",
    "query", "tote-session", "auto-session",
    "shared.tracker", "shared.cngValidator", "shared.bulkInventoryCheck", "dashboard.autoRefresh", // the latest run of each run-type screen, shared with everyone
  ];
  assert.deepEqual(hub.topics().sort(), expected.sort());
});

test("admin-only topics refuse operators", () => {
  for (const t of ["admin.queries"]) {
    assert.equal(hub.accepts(t, { user: OPERATOR }), false, t);
    assert.equal(hub.accepts(t, { user: ADMIN }), true, t);
  }
});

test("site data is ONE shared feed for everyone - whoever produced it, every user sees the same rows", () => {
  for (const t of ["locked-tote-info.history", "tote-utilisation.history", "operations"]) {
    hub.subscribe([t], () => {}, { user: OPERATOR });
    hub.subscribe([t], () => {}, { user: ADMIN });
    const instances = hub.stats().filter((s) => s.topic === t);
    assert.equal(instances.length, 1, `${t} must be one shared instance`);
    assert.ok(instances.every((i) => i.scope === "shared"));
  }
  hub.closeAll();
});

test("only 'my own running session' is per-user", () => {
  for (const t of ["auto.session"]) {
    hub.subscribe([t], () => {}, { user: OPERATOR });
    hub.subscribe([t], () => {}, { user: ADMIN });
    const instances = hub.stats().filter((s) => s.topic === t);
    assert.equal(instances.length, 2, `${t} must have one instance per user`);
    assert.ok(instances.every((i) => i.scope === "user"));
  }
  hub.closeAll();
});

test("the Dashboard's Locked Totes tile reads ONE shared snapshot feed, so a non-admin sees the same latest snapshot as an admin", () => {
  hub.subscribe(["locked-tote-info.latest"], () => {}, { user: OPERATOR });
  hub.subscribe(["locked-tote-info.latest"], () => {}, { user: ADMIN });
  const instances = hub.stats().filter((s) => s.topic === "locked-tote-info.latest");
  assert.equal(instances.length, 1, "one shared instance for everyone");
  assert.ok(instances.every((i) => i.scope === "shared"));
  hub.closeAll();
});

test("job-progress topics need a valid job id and reject path-like keys", () => {
  for (const t of ["query", "tote-session", "auto-session"]) {
    assert.equal(hub.accepts(t, { user: OPERATOR }), false, `${t} without a key`);
    assert.equal(hub.accepts(`${t}:../../x`, { user: OPERATOR }), false);
    assert.equal(hub.accepts(`${t}:abc-123`, { user: OPERATOR }), true);
  }
});

test("shared topics never accept a key and need no login context", () => {
  assert.equal(hub.accepts("connections", {}), true);
  assert.equal(hub.accepts("connections:x", { user: OPERATOR }), false);
});

test("dashboard-detail is per user + metric and accepts only a plain metric id", () => {
  assert.equal(hub.accepts("dashboard-detail", { user: OPERATOR }), false, "needs a metric key");
  assert.equal(hub.accepts("dashboard-detail:ccDone", { user: OPERATOR }), true);
  assert.equal(hub.accepts("dashboard-detail:../x", { user: OPERATOR }), false);
  assert.equal(hub.accepts("dashboard-detail:ccDone", {}), false, "needs a signed-in user");
});
