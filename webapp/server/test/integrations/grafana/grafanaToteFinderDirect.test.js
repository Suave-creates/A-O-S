// Unit tests for server/integrations/grafana/grafanaToteFinderDirect.js - the
// direct-login pilot's server-side port of the runtime's own
// executeGetGrafanaToteFinder()/frameRowsByName(). doRequest and
// grafanaAuth are injected fakes - no real HTTPS call, no real login.

const test = require("node:test");
const assert = require("node:assert/strict");
const grafanaToteFinderDirect = require("../../../integrations/grafana/grafanaToteFinderDirect");
const grafanaToteFinder = require("../../../integrations/grafana/grafanaToteFinder");

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

const PAYLOAD = {
  grafanaOrigin: "https://192.168.24.230",
  datasourceUid: "rerQ11pVk",
  datasourceType: "mssql",
  datasourceId: 1,
  finderSql: "SELECT finder",
  scanSql: "SELECT scan",
  fromMs: 1000,
  toMs: 2000,
};

test("execute(): dispatches BOTH finderSql and scanSql, each as its own rawSql", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const bodies = [];
  const doRequest = async (url, opts) => {
    bodies.push(JSON.parse(opts.body).queries[0].rawSql);
    return { status: 200, body: frameResponse(["container"], [["TL0000000001"]]) };
  };
  await grafanaToteFinderDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(bodies.sort(), ["SELECT finder", "SELECT scan"]);
});

test("execute(): shapes finderRows and scanRows independently, each by its own frame's field names", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async (url, opts) => {
    const sql = JSON.parse(opts.body).queries[0].rawSql;
    if (sql === "SELECT finder") {
      return { status: 200, body: frameResponse(["tracker", "container", "location", "lane", "updated_timestamp"], [[123], ["TL0000000001"], ["007-01"], ["A1"], ["2026-09-23"]]) };
    }
    return { status: 200, body: frameResponse(["scanner", "container", "create_time", "decision", "decision_reason"], [["SC1"], ["TL0000000001"], ["2026-09-23"], ["PASS"], [""]]) };
  };
  const result = await grafanaToteFinderDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(result.finderRows, [{ tracker: 123, container: "TL0000000001", location: "007-01", lane: "A1", updated_timestamp: "2026-09-23" }]);
  assert.deepEqual(result.scanRows, [{ scanner: "SC1", container: "TL0000000001", create_time: "2026-09-23", decision: "PASS", decision_reason: "" }]);
});

test("execute(): output satisfies the real grafanaToteFinder.validateResult() used by the registry", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async (url, opts) => {
    const sql = JSON.parse(opts.body).queries[0].rawSql;
    if (sql === "SELECT finder") {
      return { status: 200, body: frameResponse(["tracker", "container", "location", "lane", "updated_timestamp"], [[123], ["TL0000000001"], ["007-01"], ["A1"], ["2026-09-23"]]) };
    }
    return { status: 200, body: frameResponse(["scanner", "container", "create_time", "decision", "decision_reason"], [["SC1"], ["TL0000000001"], ["2026-09-23"], ["PASS"], [""]]) };
  };
  const result = await grafanaToteFinderDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(grafanaToteFinder.validateResult(result), { ok: true });
});

test("execute(): both queries run concurrently against the SAME shared login (one withAuth call each)", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async () => ({ status: 200, body: frameResponse(["container"], [["TL0000000001"]]) });
  await grafanaToteFinderDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.equal(grafanaAuth.calls.length, 2, "one withAuth call per query (finder + scan)");
});

test("execute(): a malformed/missing frame degrades to empty rows for that query, never throws", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async (url, opts) => {
    const sql = JSON.parse(opts.body).queries[0].rawSql;
    if (sql === "SELECT finder") return { status: 200, body: { results: {} } };
    return { status: 200, body: frameResponse(["container"], [["TL0000000001"]]) };
  };
  const result = await grafanaToteFinderDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(result.finderRows, []);
  assert.equal(result.scanRows.length, 1);
});
