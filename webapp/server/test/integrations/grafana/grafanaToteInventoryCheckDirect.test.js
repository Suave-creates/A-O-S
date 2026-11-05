// Unit tests for server/integrations/grafana/grafanaToteInventoryCheckDirect.js -
// mirrors grafanaContainerTrackingDirect.test.js/grafanaTrackerHistoryDirect.test.js
// exactly (same sql->rawSql remap, same NAME-based row shaping). doRequest
// and grafanaAuth are injected fakes - no real HTTPS call, no real login.

const test = require("node:test");
const assert = require("node:assert/strict");
const direct = require("../../../integrations/grafana/grafanaToteInventoryCheckDirect");
const grafanaToteInventoryCheck = require("../../../integrations/grafana/grafanaToteInventoryCheck");

function fakeGrafanaAuth() {
  const calls = [];
  return { calls, async withAuth(fn) { calls.push(true); return fn("grafana_session=fake"); } };
}

function frameResponse(fieldNames, columns) {
  return { results: { A: { frames: [{ schema: { fields: fieldNames.map((name) => ({ name })) }, data: { values: columns } }] } } };
}

const PAYLOAD = { grafanaOrigin: "https://192.168.24.230", datasourceUid: "rerQ11pVk", datasourceType: "mssql", datasourceId: 1, sql: "SELECT bulk_inventory", fromMs: 1000, toMs: 2000 };

test("execute(): remaps payload.sql to rawSql before dispatching", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const calls = [];
  const doRequest = async (url, opts) => { calls.push(opts); return { status: 200, body: frameResponse(["container"], [["TL0000025362-1"]]) }; };
  await direct.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.equal(JSON.parse(calls[0].body).queries[0].rawSql, "SELECT bulk_inventory");
});

test("execute(): shapes rows by the frame's own schema field NAMES, matching the real captured response shape", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async () => ({
    status: 200,
    body: frameResponse(
      ["id", "container", "partition", "sku", "serialId", "create_time"],
      [[155104181], ["TL0000025362-1"], ["1"], ["220529"], ["JJJ020093840"], [1789998696160]]
    ),
  });
  const result = await direct.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(result.rows, [{ id: 155104181, container: "TL0000025362-1", partition: "1", sku: "220529", serialId: "JJJ020093840", create_time: 1789998696160 }]);
});

test("execute(): output satisfies the real grafanaToteInventoryCheck.validateResult() used by the registry", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async () => ({
    status: 200,
    body: frameResponse(["container", "partition", "sku", "serialId"], [["TL0000025362-1"], ["1"], ["220529"], ["JJJ020093840"]]),
  });
  const result = await direct.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(grafanaToteInventoryCheck.validateResult(result), { ok: true });
});

test("execute(): a malformed/missing frame degrades to an empty rows array, never throws", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async () => ({ status: 200, body: { results: {} } });
  const result = await direct.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(result.rows, []);
});

test("execute(): a 401 is tagged UNAUTHORIZED so grafanaAuth.withAuth() can invalidate+retry", async () => {
  const grafanaAuth = {
    async withAuth(fn) {
      try { return await fn("grafana_session=first"); }
      catch (e) { if (e.code !== "UNAUTHORIZED") throw e; return fn("grafana_session=second"); }
    },
  };
  let calls = 0;
  const doRequest = async () => {
    calls++;
    if (calls === 1) return { status: 401, body: null };
    return { status: 200, body: frameResponse(["container"], [["TL0000025362-1"]]) };
  };
  const result = await direct.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.equal(calls, 2);
  assert.equal(result.rows[0].container, "TL0000025362-1");
});
