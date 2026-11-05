// Unit tests for server/integrations/grafana/grafanaQueryDirect.js - the shared
// direct-login pilot plumbing every Grafana *Direct.js capability builds
// on. doRequest and grafanaAuth are injected fakes - no real HTTPS call, no
// real login.

const test = require("node:test");
const assert = require("node:assert/strict");
const grafanaQueryDirect = require("../../../integrations/grafana/grafanaQueryDirect");

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

function fakeRequest(body, { status = 200 } = {}) {
  const calls = [];
  return { calls, async doRequest(url, opts) { calls.push({ url, opts }); return { status, body }; } };
}

const PAYLOAD = {
  grafanaOrigin: "https://192.168.24.230",
  datasourceUid: "rerQ11pVk",
  datasourceType: "mssql",
  datasourceId: 1,
  rawSql: "SELECT 1",
  fromMs: 1000,
  toMs: 2000,
};

test("runQuery(): calls grafanaAuth.withAuth (the shared login), POSTs to the fixed ds/query endpoint", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const { doRequest, calls } = fakeRequest({ results: {} });
  await grafanaQueryDirect.runQuery(PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.equal(grafanaAuth.calls.length, 1);
  assert.equal(calls[0].url, "https://192.168.24.230/grafana/api/ds/query");
  assert.equal(calls[0].opts.headers.Cookie, "grafana_session=fake");
});

test("runQuery(): request body carries refId A, the given datasource/rawSql, and format:table", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const { doRequest, calls } = fakeRequest({ results: {} });
  await grafanaQueryDirect.runQuery(PAYLOAD, undefined, { grafanaAuth, doRequest });
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.queries[0].refId, "A");
  assert.equal(body.queries[0].rawSql, "SELECT 1");
  assert.equal(body.queries[0].format, "table");
  assert.deepEqual(body.queries[0].datasource, { type: "mssql", uid: "rerQ11pVk" });
  assert.equal(body.queries[0].datasourceId, 1);
  assert.equal(body.from, "1000");
  assert.equal(body.to, "2000");
});

test("runQuery(): resolves with the raw response body on success", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const raw = { results: { A: { frames: [{ data: { values: [["TL0000000001"]] } }] } } };
  const { doRequest } = fakeRequest(raw);
  const result = await grafanaQueryDirect.runQuery(PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.deepEqual(result, raw);
});

test("runQuery(): a 401 is tagged UNAUTHORIZED so grafanaAuth.withAuth() can invalidate+retry", async () => {
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
    return { status: 200, body: { results: {}, cookieUsed: opts.headers.Cookie } };
  };
  const result = await grafanaQueryDirect.runQuery(PAYLOAD, undefined, { grafanaAuth, doRequest });
  assert.equal(calls, 2, "the 401 must trigger exactly one retry via withAuth");
  assert.equal(result.cookieUsed, "grafana_session=second");
});

test("runQuery(): a non-auth HTTP error throws without a code, never silently swallowed", async () => {
  const grafanaAuth = fakeGrafanaAuth();
  const doRequest = async () => ({ status: 500, body: null });
  await assert.rejects(
    grafanaQueryDirect.runQuery(PAYLOAD, undefined, { grafanaAuth, doRequest }),
    /Grafana HTTP 500/
  );
});

test("buildGrafanaRequestBody(): matches the runtime's own exact shape (refId/format/intervalMs/maxDataPoints/range)", () => {
  const body = grafanaQueryDirect.buildGrafanaRequestBody("uid1", "mssql", 2, "SELECT 1", 1000, 2000);
  assert.deepEqual(body, {
    queries: [{ refId: "A", datasource: { type: "mssql", uid: "uid1" }, rawSql: "SELECT 1", format: "table", datasourceId: 2, intervalMs: 60000, maxDataPoints: 636 }],
    range: { from: new Date(1000).toISOString(), to: new Date(2000).toISOString(), raw: { from: "now-6h", to: "now" } },
    from: "1000",
    to: "2000",
  });
});
