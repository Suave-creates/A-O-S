const test = require("node:test");
const assert = require("node:assert/strict");
const cfg = require("../../../integrations/gtp/gtpStationConfig");
const direct = require("../../../integrations/gtp/gtpStationConfigDirect");
const ptl = require("../../../integrations/grafana/grafanaPtlQueue");
const { executePtlQueue } = require("../../../integrations/grafana/grafanaMultiQueryDirect");
const registry = require("../../../integrations/capabilities/registry");

const SAMPLE = {
  items: [
    { id: "GS001", type: "ADHOC", operationType: "PICKING", userId: "GS001", state: "1", priorityWeight: 0, category: "A", toteLimit: 0 },
    { id: "GS005", type: "FR01", operationType: "NA", state: "0", priorityWeight: 300000000, category: "B" },
    { id: "GS006", type: "FR01", operationType: "PICKING", userId: "GS006", state: "1", priorityWeight: 25000000, category: "B" },
  ],
};

test("the station list is reduced to the fields the monitor uses; state is a string flag", () => {
  const s = direct.normalize(SAMPLE);
  assert.deepEqual(s[0], { id: "GS001", type: "ADHOC", operationType: "PICKING", userId: "GS001", loggedIn: true, priorityWeight: 0, category: "A" });
  assert.equal(s[1].loggedIn, false);
  assert.equal(s[1].userId, null);
  assert.equal(s[2].priorityWeight, 25000000);
  assert.equal("toteLimit" in s[0], false);
  assert.equal(cfg.validateResult({ stations: s }).ok, true);
});

test("a bad config result is rejected", () => {
  const bads = [null, {}, { stations: [{ id: "" }] }, { stations: [{ id: "A", type: "T", operationType: "P", loggedIn: "yes" }] }, { stations: [{ id: "A", type: "T", operationType: "P", loggedIn: true, priorityWeight: "x" }] }];
  for (const bad of bads) assert.equal(cfg.validateResult(bad).ok, false);
});

test("the config call sends the bearer token and instance code, and an empty list is an error", async () => {
  const seen = [];
  const doRequest = async (url, { headers }) => { seen.push({ url, headers }); return { status: 200, body: SAMPLE }; };
  const auth = { withAuth: async (fn) => fn("a.eyJzdWIiOiJGUjEifQ.c") };
  const out = await direct.execute(1, { origin: "https://h", instanceCode: "LK-069" }, undefined, { concinityAuth: auth, doRequest });
  assert.equal(seen[0].url, "https://h/gtp/get-station-config-details");
  assert.match(seen[0].headers.Authorization, /^Bearer /);
  assert.equal(seen[0].headers.instanceCode, "LK-069");
  assert.equal(out.stations.length, 3);
  const empty = async () => ({ status: 200, body: { items: [] } });
  await assert.rejects(() => direct.execute(1, { origin: "https://h" }, undefined, { concinityAuth: auth, doRequest: empty }), /no stations/);
  const denied = async () => ({ status: 401, body: null });
  await assert.rejects(() => direct.execute(1, { origin: "https://h" }, undefined, { concinityAuth: auth, doRequest: denied }), (e) => e.code === "UNAUTHORIZED");
});

test("the PTL query returns queued items and occupied slots per station", async () => {
  const p = ptl.buildPayload("https://g");
  assert.match(p.sql, /AS station/);
  const names = ["station", "remaining_quantity", "remaining_lines", "remaining_skus", "occupied_slots", "Ratio"];
  const frame = {
    schema: { fields: names.map((name) => ({ name })) },
    data: { values: [["GS001", "GS002"], [144, 80], [77, 71], [55, 37], [15, 57], [1.4, 1.9]] },
  };
  const deps = {
    grafanaAuth: { withAuth: async (fn) => fn("cookie") },
    doRequest: async () => ({ status: 200, body: { results: { A: { status: 200, frames: [frame] } } } }),
    sleep: async () => {},
  };
  const out = await executePtlQueue(1, p, undefined, deps);
  assert.deepEqual(out.stations[0], { station: "GS001", queuedItems: 144, queuedLines: 77, queuedSkus: 55, slots: 15 });
  assert.equal(ptl.validateResult(out).ok, true);
  assert.equal(ptl.validateResult({ stations: [{ station: "G", queuedItems: -1, queuedLines: 0, queuedSkus: 0, slots: 0 }] }).ok, false);
});

test("both capabilities are registered read-only", () => {
  for (const n of ["GET_GTP_STATION_CONFIG", "GET_GRAFANA_PTL_QUEUE"]) {
    const c = registry.getCapability(n);
    assert.ok(c, n);
    assert.equal(c.readOnly, true);
    assert.equal(c.write, false);
  }
  assert.equal(registry.getCapability("GET_GTP_STATION_CONFIG").authService, "concinity");
});
