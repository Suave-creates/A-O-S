const test = require("node:test");
const assert = require("node:assert/strict");
const picking = require("../../../integrations/grafana/grafanaPickingStations");
const { executePickingStations } = require("../../../integrations/grafana/grafanaMultiQueryDirect");
const registry = require("../../../integrations/capabilities/registry");

const W = (key, from = 1000, to = 2000, extra = {}) => ({ key, from, to, ...extra });

test("the SQL is the dashboard's station panel with the chosen filters written in", () => {
  const sql = picking.buildSql("NORMAL", "10");
  assert.match(sql, /DECLARE @type VARCHAR\(100\) = 'NORMAL'/);
  assert.match(sql, /DECLARE @priority VARCHAR\(100\) ='10'/);
  assert.match(sql, /sol\.item_picked_timestamp/);
  assert.match(sql, /group by sc\.station_id/);
  assert.match(sql, /\(sol\.status=7 or sol\.status=4\)/);
});

test("only the dashboard's own type and priority values can reach the SQL", () => {
  assert.deepEqual(picking.TYPES, ["ALL", "FR0", "FR1", "FR2", "JIT", "ADHOC", "BULK", "NORMAL"]);
  assert.deepEqual(picking.PRIORITIES, ["ALL", "0", "1", "2", "10", "11", "100"]);
  for (const bad of ["x'; DROP TABLE a;--", "all", "", null, undefined]) {
    assert.throws(() => picking.buildPayload("https://g", { type: bad, priority: "ALL", windows: [W("a")] }), /unknown type/);
    assert.throws(() => picking.buildPayload("https://g", { type: "ALL", priority: bad, windows: [W("a")] }), /unknown priority/);
  }
});

test("windows are validated: present, bounded, unique simple keys, a real time range", () => {
  const ok = { type: "ALL", priority: "ALL" };
  assert.throws(() => picking.buildPayload("o", { ...ok, windows: [] }), /requires 1-/);
  assert.throws(() => picking.buildPayload("o", { ...ok, windows: Array.from({ length: 41 }, (_, i) => W("k" + i)) }), /requires 1-/);
  assert.throws(() => picking.buildPayload("o", { ...ok, windows: [W("a b")] }), /simple key/);
  assert.throws(() => picking.buildPayload("o", { ...ok, windows: [W("a"), W("a")] }), /unique/);
  assert.throws(() => picking.buildPayload("o", { ...ok, windows: [W("a", 5, 5)] }), /bad window/);
  const p = picking.buildPayload("https://g", { ...ok, windows: [W("a"), W("b", 1, 2, { skip: true })] });
  assert.equal(p.datasourceUid, "rerQ11pVk");
  assert.equal(p.windows[1].skip, true);
});

test("validateResult accepts null (skipped) and station lists, and rejects anything else", () => {
  assert.equal(picking.validateResult({ windows: { a: null, b: [{ station: "GS1", items: 4 }] } }).ok, true);
  assert.equal(picking.validateResult({ windows: { a: [] } }).ok, true);
  for (const bad of [null, {}, { windows: { a: [{ station: "GS1", items: "4" }] } }, { windows: { a: [{ station: "GS1", items: NaN }] } }, { windows: { a: [{ station: "GS1", items: -1 }] } }, { windows: { a: "x" } }]) {
    assert.equal(picking.validateResult(bad).ok, false);
  }
});

test("the executor queries only windows that are not skipped and maps station rows (a null station is UNASSIGNED)", async () => {
  const asked = [];
  const deps = {
    grafanaAuth: { withAuth: async (fn) => fn("cookie") },
    doRequest: async (url, { body }) => {
      const q = JSON.parse(body);
      asked.push(q.from);
      const frame = { schema: { fields: [{ name: "station_id" }, { name: "Items_Picked" }] }, data: { values: [["GS002", null], [146, 3]] } };
      return { status: 200, body: { results: { A: { status: 200, frames: [frame] } } } };
    },
  };
  const payload = picking.buildPayload("https://g", { type: "ALL", priority: "ALL", windows: [W("h0", 1000, 2000), W("h1", 2000, 3000, { skip: true }), W("cur", 5000, 6000)] });
  const out = await executePickingStations(1, payload, undefined, deps);
  assert.deepEqual(asked.sort(), ["1000", "5000"]);
  assert.equal(out.windows.h1, null);
  assert.deepEqual(out.windows.cur, [{ station: "GS002", items: 146 }, { station: "UNASSIGNED", items: 3 }]);
  assert.equal(picking.validateResult(out).ok, true);
});

test("GET_GRAFANA_PICKING_STATIONS is registered read-only and non-mutating", () => {
  assert.ok(registry.listCapabilityNames().includes("GET_GRAFANA_PICKING_STATIONS"), "listed");
  const cap = registry.getCapability("GET_GRAFANA_PICKING_STATIONS");
  assert.ok(cap, "registered");
  assert.equal(cap.readOnly, true);
  assert.equal(cap.write, false);
  assert.equal(cap.authService, "grafana");
  assert.equal(typeof cap.directExecute, "function");
});
