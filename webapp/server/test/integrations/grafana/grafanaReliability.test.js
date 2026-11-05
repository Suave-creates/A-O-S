// Reliability layer of grafanaQueryDirect.js: transient retry + SQL-error
// detection. No real network, no real sleeping.

const test = require("node:test");
const assert = require("node:assert/strict");
const { runQuery, withReliability, isTransient } = require("../../../integrations/grafana/grafanaQueryDirect");

const noSleep = { sleep: async () => {} };
const okBody = { results: { A: { status: 200, frames: [] } } };
const auth = { withAuth: async (fn) => fn("cookie") };

test("isTransient: network resets, 429/5xx and SQL-side errors retry; auth/abort/4xx do not", () => {
  assert.equal(isTransient(Object.assign(new Error("x"), { code: "ECONNRESET" })), true);
  assert.equal(isTransient(new Error("Grafana HTTP 503")), true);
  assert.equal(isTransient(new Error("Grafana HTTP 429")), true);
  assert.equal(isTransient(Object.assign(new Error("q"), { grafanaTransient: true })), true);
  assert.equal(isTransient(new Error("Grafana HTTP 404")), false);
  assert.equal(isTransient(Object.assign(new Error("a"), { code: "UNAUTHORIZED" })), false);
  assert.equal(isTransient(Object.assign(new Error("a"), { name: "AbortError" })), false);
});

test("a transient failure is retried and the section recovers instead of going 'unavailable'", async () => {
  let calls = 0;
  const doRequest = async () => (++calls < 3 ? { status: 503, body: null } : { status: 200, body: okBody });
  const body = await runQuery({ grafanaOrigin: "https://g", rawSql: "x", fromMs: 0, toMs: 1 }, undefined, { grafanaAuth: auth, doRequest, ...noSleep });
  assert.deepEqual(body, okBody);
  assert.equal(calls, 3, "two failures + one success");
});

test("gives up after the retry budget and surfaces the real error", async () => {
  let calls = 0;
  const doRequest = async () => { calls++; return { status: 502, body: null }; };
  await assert.rejects(() => runQuery({ grafanaOrigin: "https://g", rawSql: "x", fromMs: 0, toMs: 1 }, undefined, { grafanaAuth: auth, doRequest, ...noSleep }), /Grafana HTTP 502/);
  assert.equal(calls, 3, "1 try + 2 retries");
});

test("a SQL error inside an HTTP-200 response is an error (never silently zero rows) and is retried", async () => {
  let calls = 0;
  const doRequest = async () => (++calls < 2 ? { status: 200, body: { results: { A: { status: 500, error: "deadlock victim" } } } } : { status: 200, body: okBody });
  const body = await runQuery({ grafanaOrigin: "https://g", rawSql: "x", fromMs: 0, toMs: 1 }, undefined, { grafanaAuth: auth, doRequest, ...noSleep });
  assert.deepEqual(body, okBody);
  assert.equal(calls, 2);
});

test("a permanent client error is not retried", async () => {
  let calls = 0;
  const doRequest = async () => { calls++; return { status: 400, body: null }; };
  await assert.rejects(() => runQuery({ grafanaOrigin: "https://g", rawSql: "x", fromMs: 0, toMs: 1 }, undefined, { grafanaAuth: auth, doRequest, ...noSleep }), /Grafana HTTP 400/);
  assert.equal(calls, 1);
});

test("concurrency is bounded: never more than the cap in flight", async () => {
  let inFlight = 0, peak = 0;
  const task = () => withReliability(async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return 1;
  }, undefined, noSleep);
  await Promise.all(Array.from({ length: 30 }, task));
  assert.ok(peak <= 6, `peak in flight ${peak} must not exceed the default cap of 6`);
  assert.ok(peak >= 2, "and it still runs in parallel");
});
