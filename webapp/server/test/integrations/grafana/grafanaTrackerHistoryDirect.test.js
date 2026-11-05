// Unit tests for server/integrations/grafana/grafanaTrackerHistoryDirect.js - the
// direct-login pilot's server-side port of the runtime's own
// executeGetGrafanaTrackerHistory()/frameRowsByName(). doRequest and
// grafanaAuth are injected fakes - no real HTTPS call, no real login.

const test = require("node:test");
const assert = require("node:assert/strict");
const grafanaTrackerHistoryDirect = require("../../../integrations/grafana/grafanaTrackerHistoryDirect");
const grafanaTrackerHistory = require("../../../integrations/grafana/grafanaTrackerHistory");

function fakeGrafanaAuth() {
  const calls = [];
  return {
    calls,
    async withAuth(fn) {
      calls.push(true);
      return fn("grafana_session=fake");
    },
  };
}

function frameResponse(fieldNames, columns) {
  return {
    results: { A: { frames: [{ schema: { fields: fieldNames.map((name) => ({ name })) }, data: { values: columns } }] } },
  };
}

const PAYLOAD = { grafanaOrigin: "https://192.168.24.230", datasourceUid: "rerQ11pVk", datasourceType: "mssql", datasourceId: 1, sql: "SELECT tracker_history", fromMs: 1000, toMs: 2000 };

test("execute(): remaps payload.sql to rawSql before dispatching (grafanaTrackerHistory.js's own buildPayload uses 'sql', not 'rawSql')", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const calls = [];
  const doRequest = async (url, opts) => {
    calls.push(opts);
    return { status: 200, body: frameResponse(["tracker"], [[123]]) };
  };
  await grafanaTrackerHistoryDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.equal(JSON.parse(calls[0].body).queries[0].rawSql, "SELECT tracker_history");
});

test("execute(): shapes rows by the frame's own schema field NAMES", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async () => ({ status: 200, body: frameResponse(["tracker", "destination", "rn"], [[123], ["007-01"], [1]]) });
  const result = await grafanaTrackerHistoryDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(result.rows, [{ tracker: 123, destination: "007-01", rn: 1 }]);
});

test("execute(): output satisfies the real grafanaTrackerHistory.validateResult() used by the registry", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async () => ({ status: 200, body: frameResponse(["tracker", "destination", "rn"], [[123], ["007-01"], [1]]) });
  const result = await grafanaTrackerHistoryDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(grafanaTrackerHistory.validateResult(result), { ok: true });
});

test("execute(): a 401 is tagged UNAUTHORIZED so grafanaAuth.withAuth() can invalidate+retry", async () => {
  const grafanaAuth = {
    async withAuth(fn) {
      try {
        return await fn("grafana_session=first");
      } catch (e) {
        if (e.code !== "UNAUTHORIZED") throw e;
        return fn("grafana_session=second");
      }
    },
  };
  let calls = 0;
  const doRequest = async () => {
    calls++;
    if (calls === 1) return { status: 401, body: null };
    return { status: 200, body: frameResponse(["tracker"], [[123]]) };
  };
  const result = await grafanaTrackerHistoryDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.equal(calls, 2);
  assert.equal(result.rows[0].tracker, 123);
});

test("execute(): a malformed/missing frame degrades to an empty rows array, never throws", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async () => ({ status: 200, body: { results: {} } });
  const result = await grafanaTrackerHistoryDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(result.rows, []);
});
