const test = require("node:test");
const assert = require("node:assert/strict");
const pipeline = require("../../../integrations/grafana/grafanaOrderPipeline");
const { executeOrderPipeline } = require("../../../integrations/grafana/grafanaMultiQueryDirect");
const registry = require("../../../integrations/capabilities/registry");
const { ALL_KEYS } = require("../../../features/picking-monitor/orderPipeline");

const WINDOW = { from: 1000, to: 5000 };
const ok = { type: "ALL", priority: "ALL", window: WINDOW };

test("five flow metrics, each with its own SQL, and the screen shows exactly those", () => {
  assert.equal(pipeline.METRICS.length, 5);
  assert.deepEqual(pipeline.KEYS, ["synced", "created", "inProgress", "allocated", "completed"]);
  assert.deepEqual([...pipeline.KEYS].sort(), [...ALL_KEYS].sort());
  const p = pipeline.buildPayload("https://g", ok);
  assert.equal(p.queries.length, 5);
  assert.equal(new Set(p.queries.map((q) => q.sql)).size, 5);
  assert.equal(p.datasourceUid, "rerQ11pVk");
});

test("every statement carries the chosen filters; only window-bound ones use the time range", () => {
  const p = pipeline.buildPayload("https://g", { type: "JIT", priority: "11", window: WINDOW });
  const by = Object.fromEntries(p.queries.map((q) => [q.key, q.sql]));
  for (const key of pipeline.KEYS) {
    assert.match(by[key], /DECLARE @type VARCHAR\(100\) = 'JIT'/, key);
    assert.match(by[key], /DECLARE @priority VARCHAR\(100\) ='11'/, key);
  }
  for (const m of pipeline.METRICS) {
    const usesTime = /\$__timeFrom\(\)/.test(by[m.key]);
    assert.equal(usesTime, m.scope === "window", `${m.key} scope ${m.scope}`);
  }
  assert.match(by.completed, /so\.order_picked_timestamp/);
  assert.match(by.created, /so\.status =0 AND so\.type !='FR2'/);
  assert.match(by.allocated, /sc\.station_id IS not null/);
  assert.match(by.inProgress, /sc\.station_id IS null/);
});

test("only the dashboard's own type and priority values reach the SQL, and a real window is required", () => {
  for (const bad of ["x'; DROP TABLE a;--", "all", "", null]) {
    assert.throws(() => pipeline.buildPayload("o", { ...ok, type: bad }), /unknown type/);
    assert.throws(() => pipeline.buildPayload("o", { ...ok, priority: bad }), /unknown priority/);
  }
  assert.throws(() => pipeline.buildPayload("o", { ...ok, window: { from: 5, to: 5 } }), /window/);
  assert.throws(() => pipeline.buildPayload("o", { ...ok, window: null }), /window/);
});

test("validateResult needs every metric as a count or null", () => {
  const full = Object.fromEntries(pipeline.KEYS.map((k) => [k, 1]));
  assert.equal(pipeline.validateResult({ metrics: full }).ok, true);
  assert.equal(pipeline.validateResult({ metrics: { ...full, inProgress: null } }).ok, true);
  for (const bad of [null, {}, { metrics: { ...full, inProgress: "3" } }, { metrics: { ...full, inProgress: -1 } }, { metrics: { ...full, inProgress: NaN } }, { metrics: { ...full, inProgress: undefined } }]) {
    assert.equal(pipeline.validateResult(bad).ok, false);
  }
});

function depsFor(answer) {
  return {
    grafanaAuth: { withAuth: async (fn) => fn("cookie") },
    doRequest: async (url, { body }) => {
      const sql = JSON.parse(body).queries[0].rawSql;
      const r = answer(sql);
      if (r instanceof Error) return { status: 500, body: null };
      const frame = { schema: { fields: [{ name: r.field }] }, data: { values: [[r.value]] } };
      return { status: 200, body: { results: { A: { status: 200, frames: [frame] } } } };
    },
    sleep: async () => {},
  };
}
const fieldOf = (sql) => pipeline.METRICS.find((m) => sql.includes(" AS " + m.field) || sql.includes(" as " + m.field)).field;

test("the executor reads one scalar per metric", async () => {
  const payload = pipeline.buildPayload("https://g", ok);
  const out = await executeOrderPipeline(1, payload, undefined, depsFor((sql) => ({ field: fieldOf(sql), value: 7 })));
  assert.equal(Object.keys(out.metrics).length, 5);
  assert.ok(Object.values(out.metrics).every((v) => v === 7));
  assert.equal(pipeline.validateResult(out).ok, true);
});

test("one failing query is that metric's null with a reason - the other four still arrive", async () => {
  const payload = pipeline.buildPayload("https://g", ok);
  const out = await executeOrderPipeline(1, payload, undefined, depsFor((sql) => (/AS InProgressOrders/.test(sql) ? new Error("boom") : { field: fieldOf(sql), value: 3 })));
  assert.equal(out.metrics.inProgress, null);
  assert.match(out.errors.inProgress, /Grafana HTTP 500/);
  assert.equal(out.metrics.completed, 3);
  assert.equal(pipeline.validateResult(out).ok, true);
});

test("if every query fails the call fails - a dead source is not a pipeline of nulls", async () => {
  const payload = pipeline.buildPayload("https://g", ok);
  await assert.rejects(() => executeOrderPipeline(1, payload, undefined, depsFor(() => new Error("down"))), /Order pipeline unavailable/);
});

test("GET_GRAFANA_ORDER_PIPELINE is registered read-only and non-mutating", () => {
  const cap = registry.getCapability("GET_GRAFANA_ORDER_PIPELINE");
  assert.ok(cap);
  assert.equal(cap.readOnly, true);
  assert.equal(cap.write, false);
  assert.equal(cap.authService, "grafana");
});
