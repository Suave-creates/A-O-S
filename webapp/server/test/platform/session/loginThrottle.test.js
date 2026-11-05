const test = require("node:test");
const assert = require("node:assert/strict");
const { create, BLOCK_MS } = require("../../../platform/session/loginThrottle");

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("5 wrong passwords for one ID block it for 15 min; other IDs are unaffected", () => {
  const c = clock();
  const th = create({ now: c.now });
  for (let i = 0; i < 4; i++) { assert.equal(th.blockedFor("E1", "a"), 0); th.fail("E1", "a"); }
  assert.equal(th.blockedFor("E1", "a"), 0);
  th.fail("E1", "a");
  assert.equal(th.blockedFor("e1 ", "b"), BLOCK_MS, "same ID, any case/spacing, any address");
  assert.equal(th.blockedFor("E2", "c"), 0);
  c.advance(BLOCK_MS - 1000);
  assert.equal(th.blockedFor("E1", "a"), 1000);
  c.advance(1000);
  assert.equal(th.blockedFor("E1", "a"), 0);
});

test("a correct login clears the ID's count", () => {
  const th = create({ now: clock().now });
  for (let i = 0; i < 4; i++) th.fail("E1", "a");
  th.succeed("E1");
  th.fail("E1", "a");
  assert.equal(th.blockedFor("E1", "a"), 0);
});

test("20 failures from one address across many IDs block that address", () => {
  const th = create({ now: clock().now });
  for (let i = 0; i < 20; i++) th.fail(`E${i}`, "10.0.0.9");
  assert.ok(th.blockedFor("NEW", "10.0.0.9") > 0);
  assert.equal(th.blockedFor("NEW", "10.0.0.8"), 0);
});
