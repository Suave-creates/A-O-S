const test = require("node:test");
const assert = require("node:assert/strict");
const metrics = require("../../features/dashboard/dashboardMetrics");
const feeds = require("../../live/pickingFeeds");
const { TOPIC_PANELS, canSeeTopic } = require("../../platform/domain/panels");

const BASE = Date.UTC(2026, 9, 17, 0, 30); // 06:00 IST

// A capability manager that answers GET_GRAFANA_PICKING_STATIONS with fixed per-station counts and records the
// windows it was asked for (skipped ones come back null, like the real executor).
function fakeDeps(counts) {
  const asked = [];
  return {
    asked,
    capabilityManager: {
      requestCapability: async ({ capabilityName, params }) => {
        asked.push({ capabilityName, params });
        return { ok: true, query: { query_id: `Q-${asked.length}` } };
      },
      getResult: async (queryId) => {
        const { params } = asked[Number(queryId.slice(2)) - 1];
        const windows = {};
        for (const w of params.windows) windows[w.key] = w.skip ? null : counts(w);
        return { windows };
      },
    },
    waitForTerminal: async () => ({ status: "COMPLETED" }),
  };
}
const FILTER = { type: "NORMAL", priority: "ALL", windowMin: 60 };

test("a first read asks for the started hours plus the current and previous windows, and shapes the result", async () => {
  feeds._resetForTests(); metrics._resetForTests();
  const now = BASE + 2 * 3600000 + 20 * 60000; // 08:20 IST: two closed hours, one running
  const deps = fakeDeps((w) => [{ station: "GS001", items: 10 }, { station: "GS002", items: 5 }]);
  const r = await feeds.readPicking({ ...FILTER, now, user: { id: 1 }, deps });
  const params = deps.asked[0].params;
  assert.equal(deps.asked.length, 1, "one capability call carries every window");
  assert.equal(params.type, "NORMAL");
  assert.equal(params.windows.filter((w) => w.key.startsWith("h") && !w.skip).length, 3);
  const cur = params.windows.find((w) => w.key === "cur");
  const prev = params.windows.find((w) => w.key === "prev");
  assert.equal(cur.to - cur.from, 3600000);
  assert.equal(prev.to, cur.from);
  assert.equal(r.hoursReached, 3);
  assert.equal(r.totals.today, 45);
  assert.equal(r.stations.length, 2);
  assert.equal(r.filters.type, "NORMAL");
});

test("closed hours are remembered per filter choice; a second read asks only for the running hour and the windows", async () => {
  feeds._resetForTests(); metrics._resetForTests();
  const first = fakeDeps(() => [{ station: "GS001", items: 10 }]);
  await feeds.readPicking({ ...FILTER, now: BASE + 2 * 3600000 + 20 * 60000, user: { id: 1 }, deps: first });
  const second = fakeDeps(() => [{ station: "GS001", items: 12 }]);
  const r = await feeds.readPicking({ ...FILTER, now: BASE + 2 * 3600000 + 40 * 60000, user: { id: 1 }, deps: second });
  assert.deepEqual(second.asked[0].params.windows.filter((w) => !w.skip).map((w) => w.key).sort(), ["cur", "h2", "prev"]);
  assert.equal(r.hours[0].total, 10, "a closed hour keeps its first value");
  assert.equal(r.hours[2].total, 12, "the running hour is refreshed");

  const other = fakeDeps(() => [{ station: "GS001", items: 1 }]);
  await feeds.readPicking({ ...FILTER, priority: "1", now: BASE + 2 * 3600000 + 40 * 60000, user: { id: 1 }, deps: other });
  assert.equal(other.asked[0].params.windows.filter((w) => !w.skip).length, 5, "another filter choice has no remembered hours");
});

test("a source that drops a needed window is an error, never a quiet zero", async () => {
  feeds._resetForTests(); metrics._resetForTests();
  const deps = fakeDeps((w) => (w.key === "cur" ? null : []));
  await assert.rejects(() => feeds.readPicking({ ...FILTER, now: BASE + 3600000 + 600000, user: { id: 1 }, deps }), /current window/);
});

test("the pipeline read sends the filter choice and the window, and shapes the counts", async () => {
  feeds._resetForTests();
  const asked = [];
  const deps = {
    capabilityManager: {
      requestCapability: async ({ capabilityName, params }) => { asked.push({ capabilityName, params }); return { ok: true, query: { query_id: "Q-1" } }; },
      getResult: async () => ({ metrics: { synced: 1, created: 2, inProgress: null, allocated: 5, completed: 6 }, errors: { inProgress: "Grafana HTTP 500" } }),
    },
    waitForTerminal: async () => ({ status: "COMPLETED" }),
  };
  const now = BASE + 5 * 3600000;
  const r = await feeds.readPipeline({ type: "JIT", priority: "10", windowMin: 30, now, user: { id: 1 }, deps });
  assert.equal(asked[0].capabilityName, "GET_GRAFANA_ORDER_PIPELINE");
  assert.deepEqual(asked[0].params, { type: "JIT", priority: "10", window: { from: now - 30 * 60000, to: now } });
  assert.equal(r.windowMin, 30);
  assert.deepEqual(r.unavailable, ["inProgress"]);
  assert.equal(r.groups[0].tiles.find((t) => t.key === "completed").value, 6);
});

test("the topic key is parsed against fixed lists", () => {
  assert.deepEqual(feeds.parseKey("NORMAL-ALL-60"), { type: "NORMAL", priority: "ALL", windowMin: 60, stationType: "ALL", stationPriority: "ALL" });
  assert.deepEqual(feeds.parseKey("JIT-100-15"), { type: "JIT", priority: "100", windowMin: 15, stationType: "ALL", stationPriority: "ALL" });
  assert.deepEqual(feeds.parseKey("ALL-ALL-30-QC_FAIL-PRIORITY"), { type: "ALL", priority: "ALL", windowMin: 30, stationType: "QC_FAIL", stationPriority: "PRIORITY" });
  for (const bad of ["", "NORMAL", "NORMAL-ALL", "NOPE-ALL-60", "ALL-9-60", "ALL-ALL-7", "ALL-ALL-60-extra", "ALL-ALL-60-bad type-ALL", "ALL-ALL-60-FR01-HIGH", "ALL-ALL-60-FR01-ALL-x", null]) {
    assert.throws(() => feeds.parseKey(bad), /Unknown picking filter/);
  }
});

test("the topic is limited to users who may open the Picking Monitor", () => {
  assert.deepEqual(TOPIC_PANELS["picking.monitor"], ["pickingMonitor"]);
  assert.deepEqual(TOPIC_PANELS["picking.pipeline"], ["pickingMonitor"]);
  assert.equal(canSeeTopic({ role: "OPERATOR", panels: ["dashboard"] }, "picking.pipeline:ALL-ALL-60"), false);
  assert.equal(canSeeTopic({ role: "OPERATOR", panels: ["pickingMonitor"] }, "picking.monitor:ALL-ALL-60"), true);
  assert.equal(canSeeTopic({ role: "OPERATOR", panels: ["dashboard"] }, "picking.monitor:ALL-ALL-60"), false);
  assert.equal(canSeeTopic({ role: "ADMIN", panels: [] }, "picking.monitor:ALL-ALL-60"), true);
});

// A dispatcher that answers every capability the Picking Monitor uses from a table, so a test can switch the
// station config / PTL source off without touching the picks.
function withSources(answers, run) {
  const calls = [];
  const cm = {
    requestCapability: async ({ capabilityName, params }) => {
      calls.push({ capabilityName, params });
      if (!answers[capabilityName]) return { ok: false, reason: "source down" };
      return { ok: true, query: { query_id: "Q-" + calls.length } };
    },
    getResult: async (id) => {
      const c = calls[Number(id.slice(2)) - 1];
      return answers[c.capabilityName](c.params);
    },
  };
  const realNow = Date.now;
  const dispatch = metrics.dispatchAndWait;
  Date.now = () => BASE + 2 * 3600000 + 20 * 60000;
  metrics.dispatchAndWait = (user, name, params) => dispatch(user, name, params, { capabilityManager: cm, waitForTerminal: async () => ({ status: "COMPLETED" }) });
  return run(calls).finally(() => { Date.now = realNow; metrics.dispatchAndWait = dispatch; });
}
const PICKS = (params) => ({ windows: Object.fromEntries(params.windows.map((w) => [w.key, w.skip ? null : [{ station: "GS1", items: 100 }, { station: "GS2", items: 50 }]])) });
const CONFIG = () => ({ stations: [
  { id: "GS1", type: "FR01", operationType: "PICKING", userId: "GS1", loggedIn: true, priorityWeight: 0 },
  { id: "GS2", type: "JIT", operationType: "PICKING", userId: "GS2", loggedIn: true, priorityWeight: 300000000 },
] });
const PTL = () => ({ stations: [{ station: "GS1", queuedItems: 5, queuedLines: 2, queuedSkus: 2, slots: 3 }] });

test("fetchPicking joins the picks with station facts and applies the station filter without another Grafana read", async () => {
  feeds._resetForTests(); metrics._resetForTests();
  await withSources({ GET_GRAFANA_PICKING_STATIONS: PICKS, GET_GTP_STATION_CONFIG: CONFIG, GET_GRAFANA_PTL_QUEUE: PTL }, async (calls) => {
    const all = await feeds.fetchPicking({ key: "NORMAL-ALL-60" });
    assert.equal(all.configAvailable, true);
    assert.equal(all.stations.find((s) => s.id === "GS1").queuedItems, 5);
    assert.equal(all.stations.find((s) => s.id === "GS2").priorityClass, "PRIORITY");
    const reads = () => calls.filter((c) => c.capabilityName === "GET_GRAFANA_PICKING_STATIONS").length;
    const before = reads();
    const jit = await feeds.fetchPicking({ key: "NORMAL-ALL-60-JIT-ALL" });
    assert.deepEqual(jit.stations.map((s) => s.id), ["GS2"]);
    assert.equal(reads(), before, "the station filter is applied to the cached read");
  });
});

test("if the station config is down the picks still arrive, flagged as not judged", async () => {
  feeds._resetForTests(); metrics._resetForTests();
  await withSources({ GET_GRAFANA_PICKING_STATIONS: PICKS }, async () => {
    const r = await feeds.fetchPicking({ key: "NORMAL-ALL-60" });
    assert.equal(r.configAvailable, false);
    assert.equal(r.queueAvailable, false);
    assert.equal(r.stations[0].health, null);
    assert.equal(r.stations[0].picks, 100);
  });
});

test("an order filter triggers one extra all-orders window read for the capacity colours; ALL/ALL needs none", async () => {
  feeds._resetForTests(); metrics._resetForTests();
  await withSources({ GET_GRAFANA_PICKING_STATIONS: PICKS, GET_GTP_STATION_CONFIG: CONFIG, GET_GRAFANA_PTL_QUEUE: PTL }, async (calls) => {
    const reads = () => calls.filter((c) => c.capabilityName === "GET_GRAFANA_PICKING_STATIONS");
    await feeds.fetchPicking({ key: "ALL-ALL-60" });
    assert.equal(reads().length, 1);
    const r = await feeds.fetchPicking({ key: "JIT-ALL-60" });
    const extra = reads().filter((c) => c.params.type === "ALL" && c.params.windows.length === 1);
    assert.equal(extra.length, 1, "one unfiltered window for the capacity");
    assert.equal(r.stations.find((s) => s.id === "GS1").health !== undefined, true);
  });
});
