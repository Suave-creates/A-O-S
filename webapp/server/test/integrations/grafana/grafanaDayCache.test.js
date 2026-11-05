const test = require("node:test");
const assert = require("node:assert/strict");
const dayCache = require("../../../integrations/grafana/grafanaDayCache");
const { memoryStore } = require("../../../platform/storage/liveDayCache");

const DATE = "2026-11-04";
const ist = (h, m = 0) => Date.UTC(2026, 10, 4, h, m) - 5.5 * 3600000; // h may run past 24 for shift C

// A fake section: records which slots each refresh asked Grafana for; a slot's value is "<slot>@<read time>".
function harness(store = memoryStore()) {
  const reads = [];
  const run = (now, perShift = false) =>
    dayCache.refreshSection({
      dateStr: DATE, section: "t:v1", perShift, now, store,
      fetch: async (slots) => {
        const asked = slots.filter((s) => !s.skip).map((s) => s.slot);
        reads.push(asked);
        return new Map(asked.map((s) => [s, `${s}@${now}`]));
      },
    });
  return { reads, run, store, last: () => reads[reads.length - 1] };
}

test.beforeEach(() => dayCache._resetForTests());

test("first refresh reads the running shift in full; hours not started are never asked for", async () => {
  const h = harness();
  const got = await h.run(ist(9, 10));
  assert.deepEqual(h.last(), ["A0", "A1", "A2", "A3"]);
  assert.deepEqual([...got.keys()], ["A0", "A1", "A2", "A3"]);
});

test("next refresh reads only the last 60 minutes; older hours come from the cache", async () => {
  const h = harness();
  await h.run(ist(9, 10));
  const got = await h.run(ist(9, 15));
  // 06-07 and 07-08 were read 60+ min after they ended: settled. 08-09 ended 15 min ago, 09-10 is running.
  assert.deepEqual(h.last(), ["A2", "A3"]);
  assert.equal(got.get("A0"), `A0@${ist(9, 10)}`);
  assert.equal(got.get("A3"), `A3@${ist(9, 15)}`);
});

test("the running shift is read in full again once its last full read is 30+ minutes old", async () => {
  const h = harness();
  await h.run(ist(9, 10));
  await h.run(ist(9, 39));
  assert.deepEqual(h.last(), ["A2", "A3"]);
  await h.run(ist(9, 40));
  assert.deepEqual(h.last(), ["A0", "A1", "A2", "A3"]);
});

test("30 min after a shift ends it gets one final read and is frozen for the day", async () => {
  const h = harness();
  await h.run(ist(14, 5)); // A in full; B has just started: in full too
  assert.deepEqual(h.last(), ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "B0"]);
  await h.run(ist(14, 29)); // A still in its grace period: only its last hour (ended 29 min ago) + B's running hour
  assert.deepEqual(h.last(), ["A7", "B0"]);
  await h.run(ist(14, 31)); // final read of A
  assert.deepEqual(h.last(), ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "B0"]);
  await h.run(ist(16, 0));
  assert.ok(!h.last().some((s) => s.startsWith("A")), "a frozen shift is never read again");
  const frozen = h.store.rows.get(`${DATE}|t:v1`);
  assert.ok(["A0", "A7"].every((s) => frozen.get(s).frozen));
});

test("settled and frozen slots survive a restart; the running shift is read in full once", async () => {
  const store = memoryStore();
  const h1 = harness(store);
  await h1.run(ist(14, 31)); // A final (frozen), B0 full
  await h1.run(ist(16, 5)); // B full again (fullAt 14:31 is 30+ min old)
  dayCache._resetForTests(); // restart: memory gone, MySQL (store) kept
  const h2 = harness(store);
  await h2.run(ist(16, 6));
  assert.deepEqual(h2.last(), ["B0", "B1", "B2"], "only the running shift - A comes from storage");
  const got = await h2.run(ist(16, 7));
  assert.equal(got.get("A0"), `A0@${ist(14, 31)}`);
});

test("per-shift sections: the running shift is read every refresh, finished shifts once then frozen", async () => {
  const h = harness();
  await h.run(ist(15, 0), true);
  assert.deepEqual(h.last(), ["A", "B"]); // A: final read (ended 14:00), B: running
  await h.run(ist(15, 5), true);
  assert.deepEqual(h.last(), ["B"]);
  await h.run(ist(22, 31), true);
  assert.deepEqual(h.last(), ["B", "C"]);
  await h.run(ist(23, 0), true);
  assert.deepEqual(h.last(), ["C"]);
});

test("a failed read keeps what was cached and is tried again on the next refresh", async () => {
  const store = memoryStore();
  await harness(store).run(ist(9, 10));
  await assert.rejects(() => dayCache.refreshSection({ dateStr: DATE, section: "t:v1", perShift: false, now: ist(9, 15), store, fetch: async () => { throw new Error("Grafana down"); } }));
  const h = harness(store);
  await h.run(ist(9, 16));
  assert.deepEqual(h.last(), ["A2", "A3"]);
});

test("ccRows: hourly rows are put back together per shift; hourlyCounts: hours not started are 0", async () => {
  const store = memoryStore();
  const asked = [];
  const deps = {
    now: ist(7, 30), store,
    capabilityManager: {
      requestCapability: async ({ capabilityName, params }) => { asked.push([capabilityName, params]); return { ok: true, query: { query_id: capabilityName } }; },
      getResult: (id) => {
        const p = asked.find((a) => a[0] === id)[1];
        const hours = { A: [], B: [], C: [] };
        for (const k of ["A", "B", "C"]) p.hourWindows[k].forEach((w, i) => { hours[k][i] = w.skip ? null : id === "GET_GRAFANA_CC_METRICS" ? { discRows: [{ container: `T${k}${i}` }], stockRows: [] } : 5; });
        return { hours };
      },
    },
    waitForTerminal: async () => ({ status: "COMPLETED" }),
  };
  const cc = await dayCache.ccRows({ id: 1 }, DATE, deps);
  assert.deepEqual(cc.windows.A.discRows.map((r) => r.container), ["TA0", "TA1"]);
  assert.deepEqual(cc.windows.B, { discRows: [], stockRows: [] });
  const prod = await dayCache.hourlyCounts({ id: 1 }, DATE, "GET_GRAFANA_ASRS_PRODUCTION_JIT", deps);
  assert.deepEqual(prod.hours.A, [5, 5, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(prod.hours.C, [0, 0, 0, 0, 0, 0, 0, 0]);
  const skipped = asked[0][1].hourWindows.A.map((w) => w.skip);
  assert.deepEqual(skipped, [false, false, true, true, true, true, true, true]);
});

test("peek: the whole day from the cache without reading Grafana, or null when a slot is missing", async () => {
  const h = harness();
  await h.run(ist(9, 10));
  assert.equal(await dayCache.peek(DATE, "t:v1", false, { store: h.store }), null);
  await h.run(ist(30, 31)); // 06:31 next morning: every shift has had its final read
  const all = await dayCache.peek(DATE, "t:v1", false, { store: h.store });
  assert.equal(all.size, 24);
});
