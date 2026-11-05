const test = require("node:test");
const assert = require("node:assert/strict");
const { ALL_KEYS, normalizePanels, parseStored, effectivePanels, canAccess, canSeeTopic } = require("../../../platform/domain/panels");

test("NULL panels = every panel, so existing users keep working; admins always have everything", () => {
  assert.deepEqual(effectivePanels({ role: "USER", panels: null }), ALL_KEYS);
  assert.deepEqual(effectivePanels({ role: "ADMIN", panels: ["alerts"] }), ALL_KEYS);
  assert.equal(canAccess({ role: "USER", panels: null }, "totePurge"), true);
  assert.equal(canAccess({ role: "ADMIN", panels: [] }, "totePurge"), true);
});

test("a restricted user only reaches the panels granted; any one of several is enough", () => {
  const u = { role: "USER", panels: ["dashboard", "alerts"] };
  assert.equal(canAccess(u, "dashboard"), true);
  assert.equal(canAccess(u, "totePurge"), false);
  assert.equal(canAccess(u, "totePurge", "alerts"), true);
  assert.equal(canAccess(null, "dashboard"), false);
});

test("normalize drops junk and duplicates; parseStored tolerates bad JSON (falls back to all)", () => {
  assert.deepEqual(normalizePanels(["alerts", "nope", "dashboard", "alerts"]), ["dashboard", "alerts"]);
  assert.deepEqual(parseStored('["alerts","x"]'), ["alerts"]);
  assert.equal(parseStored(null), null);
  assert.equal(parseStored("{not json"), null);
});

test("live topics follow the panels: gated topics need the panel, open topics are always allowed", () => {
  const u = { role: "USER", panels: ["dashboard"] };
  assert.equal(canSeeTopic(u, "dashboard.cc"), true);
  assert.equal(canSeeTopic(u, "dashboard-detail:ccDone"), true);
  assert.equal(canSeeTopic(u, "alerts"), false);
  assert.equal(canSeeTopic(u, "tote-purge.current"), false);
  assert.equal(canSeeTopic(u, "locked-tote-info.latest"), true, "the Dashboard's Locked Totes tile");
  assert.equal(canSeeTopic(u, "locked-tote-info.history"), false, "the Locked Totes screen's own history list");
  assert.equal(canSeeTopic(u, "locked-tote-info.current"), false);
  assert.equal(canSeeTopic(u, "connections"), true);
});
