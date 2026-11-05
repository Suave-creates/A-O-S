// Unit tests for server/integrations/grafana/grafanaContainerTrackingDirect.js -
// the direct-login pilot's server-side port of the runtime's own
// executeGetGrafanaContainerTracking()/frameRowsByName(). doRequest and
// grafanaAuth are injected fakes - no real HTTPS call, no real login.

const test = require("node:test");
const assert = require("node:assert/strict");
const grafanaContainerTrackingDirect = require("../../../integrations/grafana/grafanaContainerTrackingDirect");
const grafanaContainerTracking = require("../../../integrations/grafana/grafanaContainerTracking");

function fakeGrafanaAuth({ sessionCookie = "grafana_session=fake" } = {}) {
  const calls = [];
  return {
    calls,
    async withAuth(fn) {
      calls.push(true);
      return fn(sessionCookie);
    },
  };
}

function frameResponse(fieldNames, columns) {
  return {
    results: {
      A: {
        frames: [
          {
            schema: { fields: fieldNames.map((name) => ({ name })) },
            data: { values: columns },
          },
        ],
      },
    },
  };
}

const PAYLOAD = { grafanaOrigin: "https://192.168.24.230", datasourceUid: "rerQ11pVk", datasourceType: "mssql", datasourceId: 1, sql: "SELECT 1", fromMs: 1000, toMs: 2000 };

test("execute(): remaps payload.sql to rawSql before dispatching (grafanaContainerTracking.js's own buildPayload uses 'sql', not 'rawSql')", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const calls = [];
  const doRequest = async (url, opts) => {
    calls.push(opts);
    return { status: 200, body: frameResponse(["container"], [["TL0000000001"]]) };
  };
  await grafanaContainerTrackingDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  const body = JSON.parse(calls[0].body);
  assert.equal(body.queries[0].rawSql, "SELECT 1");
});

test("execute(): shapes rows by the frame's own schema field NAMES, not column index order", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  // Deliberately out-of-alphabetical/declared order, to prove this isn't positional.
  const doRequest = async () => ({
    status: 200,
    body: frameResponse(
      ["badTracker", "container", "location"],
      [["NO"], ["TL0000000001"], ["OUT"]]
    ),
  });
  const result = await grafanaContainerTrackingDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(result.rows, [{ badTracker: "NO", container: "TL0000000001", location: "OUT" }]);
});

test("execute(): multiple rows are zipped correctly, one row per index across all columns", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async () => ({
    status: 200,
    body: frameResponse(["container", "location"], [["TL01", "TL02"], ["OUT", "004-01"]]),
  });
  const result = await grafanaContainerTrackingDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(result.rows, [
    { container: "TL01", location: "OUT" },
    { container: "TL02", location: "004-01" },
  ]);
});

test("execute(): a malformed/missing frame degrades to an empty rows array, never throws", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async () => ({ status: 200, body: { results: {} } });
  const result = await grafanaContainerTrackingDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(result.rows, []);
});

test("execute(): output satisfies the real grafanaContainerTracking.validateResult() used by the registry", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async () => ({
    status: 200,
    body: frameResponse(
      ["container", "tracker", "location", "zone", "shuttle", "shuttleHealthStatus", "stockCheckBlocked", "binBlocked", "badTracker"],
      [["TL0000000001"], ["TRK1"], ["OUT"], ["Z1"], ["S1"], ["HEALTHY"], ["NO"], ["NO"], ["NO"]]
    ),
  });
  const result = await grafanaContainerTrackingDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(grafanaContainerTracking.validateResult(result), { ok: true });
});

test("execute(): calls grafanaAuth.withAuth (the shared login), never a per-user credential", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async () => ({ status: 200, body: frameResponse(["container"], [["TL0000000001"]]) });
  await grafanaContainerTrackingDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.equal(grafanaAuth.calls.length, 1);
});

test("execute(): a 401 is tagged UNAUTHORIZED so grafanaAuth.withAuth() can invalidate+retry (via the shared grafanaQueryDirect plumbing)", async () => {
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
  const doRequest = async (url, opts) => {
    calls++;
    if (calls === 1) return { status: 401, body: null };
    return { status: 200, body: frameResponse(["container"], [["TL0000000001"]]) };
  };
  const result = await grafanaContainerTrackingDirect.execute(1, PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.equal(calls, 2, "the 401 must trigger exactly one retry via withAuth");
  assert.equal(result.rows[0].container, "TL0000000001");
});
