// Unit tests for server/live/liveHub.js - fake clock + manual scheduler, no
// real timers, no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHub, changedKeys } = require("../../live/liveHub");

function harness(opts = {}) {
  let t = 1_000_000;
  const timers = [];
  const hub = createHub({
    now: () => t,
    schedule: (fn, ms) => { const h = { fn, at: t + ms, dead: false }; timers.push(h); return h; },
    cancel: (h) => { h.dead = true; },
    idleGraceMs: 30000,
    ...opts,
  });
  // Advance the clock, firing due timers in order (and awaiting async runs).
  async function advance(ms) {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((h) => !h.dead && h.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = Math.max(t, due.at);
      due.dead = true;
      due.fn();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }
    t = end;
  }
  const pending = () => timers.filter((h) => !h.dead).length;
  return { hub, advance, pending, clock: () => t };
}

test("changedKeys reports only top-level keys that moved; null for non-objects", () => {
  assert.deepEqual(changedKeys({ a: 1, b: { x: 1 } }, { a: 1, b: { x: 2 }, c: 3 }).sort(), ["b", "c"]);
  assert.deepEqual(changedKeys({ a: 1 }, { a: 1 }), []);
  assert.equal(changedKeys([1], [2]), null);
});

test("nothing is fetched until someone subscribes (demand-driven)", async () => {
  const h = harness();
  let calls = 0;
  h.hub.registerFeed({ topic: "t", intervalMs: 1000, fetch: async () => { calls++; return { n: 1 }; } });
  await h.advance(60000);
  assert.equal(calls, 0);
});

test("many subscribers share ONE fetch per interval (single upstream call)", async () => {
  const h = harness();
  let calls = 0;
  h.hub.registerFeed({ topic: "t", intervalMs: 1000, fetch: async () => { calls++; return { n: calls }; } });
  const got = [[], [], []];
  const unsubs = got.map((arr) => h.hub.subscribe(["t"], (e) => arr.push(e)));
  await h.advance(0);
  assert.equal(calls, 1, "three browsers, one upstream call");
  for (const arr of got) assert.equal(arr.filter((e) => e.type === "data").length, 1);
  await h.advance(1000);
  assert.equal(calls, 2);
  unsubs.forEach((u) => u());
});

test("unchanged data sends a tiny 'checked' event, changed data sends 'data' with the changed keys", async () => {
  const h = harness();
  const seq = [{ a: 1, b: 1 }, { a: 1, b: 1 }, { a: 2, b: 1 }];
  let i = 0;
  h.hub.registerFeed({ topic: "t", intervalMs: 1000, fetch: async () => seq[Math.min(i++, 2)] });
  const events = [];
  h.hub.subscribe(["t"], (e) => events.push(e));
  await h.advance(0);
  await h.advance(1000);
  await h.advance(1000);
  assert.deepEqual(events.map((e) => e.type), ["data", "checked", "data"]);
  assert.deepEqual(events[2].changed, ["a"]);
  assert.equal(events[2].version, 2);
  assert.equal(events[0].version, 1);
});

test("a late subscriber gets the cached snapshot immediately, without a new fetch", async () => {
  const h = harness();
  let calls = 0;
  h.hub.registerFeed({ topic: "t", intervalMs: 10000, fetch: async () => { calls++; return { n: 1 }; } });
  h.hub.subscribe(["t"], () => {});
  await h.advance(0);
  const late = [];
  h.hub.subscribe(["t"], (e) => late.push(e));
  assert.equal(late.length, 1);
  assert.equal(late[0].initial, true);
  assert.deepEqual(late[0].data, { n: 1 });
  assert.equal(calls, 1);
});

test("polling stops after the last subscriber leaves (plus grace) and resumes on return", async () => {
  const h = harness();
  let calls = 0;
  h.hub.registerFeed({ topic: "t", intervalMs: 1000, fetch: async () => { calls++; return { n: calls }; } });
  const un = h.hub.subscribe(["t"], () => {});
  await h.advance(0);
  un();
  await h.advance(60000);
  const after = calls;
  assert.ok(after <= 31, `polling must stop after the grace period (calls=${after})`);
  await h.advance(60000);
  assert.equal(calls, after, "no more calls with nobody watching");
  h.hub.subscribe(["t"], () => {});
  await h.advance(0);
  assert.equal(calls, after + 1);
});

test("failures back off exponentially (capped) and subscribers are told the data is stale; recovery clears it", async () => {
  const h = harness();
  let fail = true;
  let calls = 0;
  h.hub.registerFeed({ topic: "t", intervalMs: 1000, fetch: async () => { calls++; if (fail) throw new Error("grafana down"); return { ok: true }; } });
  const events = [];
  h.hub.subscribe(["t"], (e) => events.push(e));
  await h.advance(0);
  assert.equal(calls, 1);
  await h.advance(1999);
  assert.equal(calls, 1, "2nd attempt waits 2s, not 1s");
  await h.advance(1);
  assert.equal(calls, 2);
  await h.advance(3999);
  assert.equal(calls, 2, "3rd attempt waits 4s");
  assert.equal(events.filter((e) => e.type === "feed-error").length, 1, "error announced once, not per retry");
  fail = false;
  await h.advance(1);
  assert.equal(calls, 3);
  const last = events[events.length - 1];
  assert.equal(last.type, "data");
  assert.equal(last.stale, false);
});

test("a throwing subscriber is dropped and never breaks the others", async () => {
  const h = harness();
  h.hub.registerFeed({ topic: "t", intervalMs: 1000, fetch: async () => ({ n: 1 }) });
  const good = [];
  h.hub.subscribe(["t"], () => { throw new Error("socket closed"); });
  h.hub.subscribe(["t"], (e) => good.push(e));
  await h.advance(0);
  assert.equal(good.length, 1);
  assert.equal(h.hub.stats()[0].subscribers, 1);
});

test("manual refresh is rate-limited and needs a subscriber", async () => {
  const h = harness();
  let calls = 0;
  h.hub.registerFeed({ topic: "t", intervalMs: 60000, minRefreshMs: 5000, fetch: async () => { calls++; return { n: calls }; } });
  assert.equal(h.hub.refresh("t").ok, false, "no subscribers");
  h.hub.subscribe(["t"], () => {});
  await h.advance(0);
  assert.equal(h.hub.refresh("t").started, false, "too soon after the last run");
  await h.advance(5000);
  assert.equal(h.hub.refresh("t").started, true);
  await h.advance(0);
  assert.equal(calls, 2);
  assert.equal(h.hub.refresh("nope").ok, false);
});

test("unknown topics are ignored on subscribe; duplicate registration is rejected", () => {
  const h = harness();
  h.hub.registerFeed({ topic: "t", intervalMs: 1000, fetch: async () => ({}) });
  assert.throws(() => h.hub.registerFeed({ topic: "t", intervalMs: 1000, fetch: async () => ({}) }));
  const un = h.hub.subscribe(["nope"], () => {});
  assert.equal(typeof un, "function");
});

// ── Scopes: user / key topics, roles, stopWhen ───────────────────────────

const U1 = { id: 1, role: "OPERATOR" };
const U2 = { id: 2, role: "OPERATOR" };
const ADMIN = { id: 9, role: "ADMIN" };

test("user-scoped topics get one instance per user, each fetching with its own user", async () => {
  const h = harness();
  const seen = [];
  h.hub.registerFeed({ topic: "mine", scope: "user", intervalMs: 1000, fetch: async ({ user }) => { seen.push(user.id); return { for: user.id }; } });
  const a = [], b = [];
  h.hub.subscribe(["mine"], (e) => a.push(e), { user: U1 });
  h.hub.subscribe(["mine"], (e) => b.push(e), { user: U2 });
  await h.advance(0);
  assert.deepEqual(seen.sort(), [1, 2]);
  assert.deepEqual(a[0].data, { for: 1 });
  assert.deepEqual(b[0].data, { for: 2 });
  assert.equal(a[0].topic, "mine");
});

test("user-scoped topics are refused without a user; shared topics refuse a key", () => {
  const h = harness();
  h.hub.registerFeed({ topic: "mine", scope: "user", intervalMs: 1000, fetch: async () => ({}) });
  h.hub.registerFeed({ topic: "all", intervalMs: 1000, fetch: async () => ({}) });
  assert.equal(h.hub.accepts("mine", {}), false);
  assert.equal(h.hub.accepts("mine", { user: U1 }), true);
  assert.equal(h.hub.accepts("all:x", { user: U1 }), false);
  assert.equal(h.hub.accepts("all", {}), true);
});

test("key-scoped topics validate the key and isolate the same key between users", async () => {
  const h = harness();
  const calls = [];
  h.hub.registerFeed({ topic: "job", scope: "key", intervalMs: 1000, fetch: async ({ user, key }) => { calls.push(`${user.id}:${key}`); return { key }; } });
  assert.equal(h.hub.accepts("job", { user: U1 }), false, "key required");
  assert.equal(h.hub.accepts("job:../etc", { user: U1 }), false, "bad key rejected");
  assert.equal(h.hub.accepts("job:Q-123", { user: U1 }), true);
  const got = [];
  h.hub.subscribe(["job:Q-123"], (e) => got.push(e), { user: U1 });
  h.hub.subscribe(["job:Q-123"], () => {}, { user: U2 });
  await h.advance(0);
  assert.deepEqual(calls.sort(), ["1:Q-123", "2:Q-123"]);
  assert.equal(got[0].topic, "job:Q-123");
});

test("roles restrict who can subscribe", () => {
  const h = harness();
  h.hub.registerFeed({ topic: "admin.only", roles: ["ADMIN"], intervalMs: 1000, fetch: async () => ({}) });
  assert.equal(h.hub.accepts("admin.only", { user: U1 }), false);
  assert.equal(h.hub.accepts("admin.only", { user: ADMIN }), true);
  assert.equal(h.hub.accepts("admin.only", {}), false);
});

test("stopWhen ends polling once a snapshot is terminal (finished job costs nothing more)", async () => {
  const h = harness();
  let n = 0;
  h.hub.registerFeed({ topic: "job", scope: "key", intervalMs: 1000, fetch: async () => ({ status: ++n >= 3 ? "COMPLETED" : "RUNNING" }), stopWhen: (d) => d.status === "COMPLETED" });
  const events = [];
  h.hub.subscribe(["job:a"], (e) => events.push(e), { user: U1 });
  await h.advance(0);
  await h.advance(5000);
  assert.equal(n, 3, "stops after the terminal snapshot");
  assert.equal(events[events.length - 1].data.status, "COMPLETED");
});

test("idle per-user instances are dropped so they cannot accumulate", async () => {
  const h = harness();
  h.hub.registerFeed({ topic: "mine", scope: "user", intervalMs: 1000, fetch: async () => ({ n: 1 }) });
  const off = h.hub.subscribe(["mine"], () => {}, { user: U1 });
  await h.advance(0);
  assert.equal(h.hub.stats().length, 1);
  off();
  await h.advance(31000);
  assert.equal(h.hub.stats().length, 0);
});

test("manual refresh works per user instance and is refused for a user who is not subscribed", async () => {
  const h = harness();
  let calls = 0;
  h.hub.registerFeed({ topic: "mine", scope: "user", intervalMs: 60000, minRefreshMs: 1000, fetch: async () => ({ n: ++calls }) });
  h.hub.subscribe(["mine"], () => {}, { user: U1 });
  await h.advance(0);
  assert.equal(h.hub.refresh("mine", { user: U2 }).ok, false);
  await h.advance(1000);
  assert.equal(h.hub.refresh("mine", { user: U1 }).started, true);
});

test("a late subscriber to a feed that has only failed is told so immediately", async () => {
  const h = harness();
  h.hub.registerFeed({ topic: "t", intervalMs: 1000, fetch: async () => { throw new Error("db down"); } });
  h.hub.subscribe(["t"], () => {});
  await h.advance(0);
  const late = [];
  h.hub.subscribe(["t"], (e) => late.push(e));
  assert.equal(late[0].type, "feed-error");
  assert.match(late[0].message, /db down/);
});

test("a manual refresh tells the feed (ctx.manual) so it can bypass its caches; scheduled polls do not", async () => {
  const h = harness();
  const seen = [];
  h.hub.registerFeed({ topic: "t", intervalMs: 60000, minRefreshMs: 1000, fetch: async (ctx) => { seen.push(!!ctx.manual); return { n: seen.length }; } });
  h.hub.subscribe(["t"], () => {});
  await h.advance(0);
  await h.advance(1000);
  h.hub.refresh("t");
  await h.advance(0);
  await h.advance(60000);
  assert.deepEqual(seen, [false, true, false]);
});

test("background guardrail: hidden-only subscribers poll slowly; a visible tab speeds it up at once", async () => {
  const h = harness();
  let calls = 0;
  h.hub.registerFeed({ topic: "t", intervalMs: 1000, backgroundIntervalMs: 60000, fetch: async () => ({ n: ++calls }) });
  const un = h.hub.subscribe(["t"], () => {}, { active: false });
  await h.advance(1);
  assert.equal(calls, 1); // first snapshot is fetched straight away
  await h.advance(30000);
  assert.equal(calls, 1); // hidden: nothing for a long while
  await h.advance(31000);
  assert.equal(calls, 2); // ...then one slow poll
  await h.advance(5000);
  un.setActive(true); // tab comes back, snapshot older than the fast interval -> fetch now
  await h.advance(1);
  assert.equal(calls, 3);
  await h.advance(3000);
  assert.ok(calls >= 5); // back to the fast pace
  un.setActive(false);
  const before = calls;
  await h.advance(30000);
  assert.ok(calls <= before + 1); // slow again
  un();
});

test("background guardrail: one visible subscriber keeps the fast pace for everyone; feeds that did not opt in are unaffected", async () => {
  const h = harness();
  let a = 0;
  let b = 0;
  h.hub.registerFeed({ topic: "slow", intervalMs: 1000, backgroundIntervalMs: 60000, fetch: async () => ({ n: ++a }) });
  h.hub.registerFeed({ topic: "plain", intervalMs: 1000, fetch: async () => ({ n: ++b }) });
  h.hub.subscribe(["slow", "plain"], () => {}, { active: false });
  h.hub.subscribe(["slow"], () => {}, { active: true });
  await h.advance(10000);
  assert.ok(a >= 8, "visible subscriber -> fast pace");
  assert.ok(b >= 8, "plain feed ignores visibility");
});

test("an on-demand topic is read once for the first viewer, then only when refreshed - no timer", async () => {
  const h = harness();
  let calls = 0;
  h.hub.registerFeed({ topic: "t", intervalMs: 1000, minRefreshMs: 0, fetch: async () => { calls++; return { n: calls }; } });
  h.hub.markOnDemand(["t"]);
  const got = [];
  h.hub.subscribe(["t"], (e) => got.push(e));
  await h.advance(0);
  assert.equal(calls, 1, "the first read");
  await h.advance(60000);
  assert.equal(calls, 1, "no timed re-read");
  assert.equal(h.pending(), 0);
  h.hub.refresh("t");
  await h.advance(0);
  assert.equal(calls, 2, "a screen's refresh reads again");
  // a second viewer gets the cached snapshot, no new read
  const second = [];
  h.hub.subscribe(["t"], (e) => second.push(e));
  await h.advance(0);
  assert.equal(calls, 2);
  assert.equal(second[0].data.n, 2);
});

test("an on-demand topic whose first read fails keeps retrying until it lands, then stops", async () => {
  const h = harness();
  let calls = 0;
  h.hub.registerFeed({ topic: "t", intervalMs: 1000, fetch: async () => { calls++; if (calls < 3) throw new Error("down"); return { ok: 1 }; } });
  h.hub.markOnDemand(["t"]);
  h.hub.subscribe(["t"], () => {});
  await h.advance(60000);
  assert.equal(calls, 3);
  await h.advance(600000);
  assert.equal(calls, 3, "once a read landed, no more automatic reads");
});

// ── Central auto refresh of on-demand topics (Dashboard tiles, admin-set - 2026-11-04) ─────────────────────

test("central auto refresh: one read per interval however many people watch; Refresh restarts the countdown", async () => {
  const h = harness();
  let calls = 0;
  h.hub.registerFeed({ topic: "t", intervalMs: 1000, minRefreshMs: 0, fetch: async () => { calls++; return { n: calls }; } });
  h.hub.markOnDemand(["t"]);
  h.hub.setAutoInterval("t", 60000);
  for (let i = 0; i < 10; i++) h.hub.subscribe(["t"], () => {});
  await h.advance(0);
  assert.equal(calls, 1, "the first read");
  assert.ok(h.hub.autoInfo("t").nextAt, "a countdown is running");
  await h.advance(60000);
  assert.equal(calls, 2, "ten viewers, still one read per interval");
  await h.advance(30000);
  h.hub.refresh("t"); // someone pressed Refresh half-way
  await h.advance(0);
  assert.equal(calls, 3);
  await h.advance(59000);
  assert.equal(calls, 3, "the countdown restarted from the Refresh");
  await h.advance(1000);
  assert.equal(calls, 4);
});

test("central auto refresh: nobody watching (or every viewer's tab hidden) -> no reads; off -> no reads", async () => {
  const h = harness();
  let calls = 0;
  h.hub.registerFeed({ topic: "t", intervalMs: 1000, minRefreshMs: 0, fetch: async () => { calls++; return { n: calls }; } });
  h.hub.markOnDemand(["t"]);
  h.hub.setAutoInterval("t", 60000);
  const off = h.hub.subscribe(["t"], () => {});
  await h.advance(0);
  off.setActive(false);
  await h.advance(300000);
  assert.equal(calls, 1, "a hidden tab does not drive reads");
  off.setActive(true);
  await h.advance(0);
  assert.equal(calls, 2, "coming back catches up at once");
  h.hub.setAutoInterval("t", 0);
  await h.advance(600000);
  assert.equal(calls, 2, "off: reads only when asked");
  assert.equal(h.hub.autoInfo("t").nextAt, null);
  h.hub.setAutoInterval("t", 60000);
  off();
  await h.advance(600000);
  assert.equal(calls, 2, "nobody subscribed: nothing runs");
});
