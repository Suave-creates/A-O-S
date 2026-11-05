// HTTP-level tests for the SSE route (real express + real http, fake hub/auth).

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { createHub } = require("../../live/liveHub");
const createLiveRouter = require("../../live/live.routes");

async function boot({ role = "OPERATOR", uid = 1 } = {}) {
  const hub = createHub();
  let calls = 0;
  hub.registerFeed({ topic: "t", intervalMs: 50, fetch: async () => ({ n: ++calls > 0 ? 1 : 0 }) });
  const router = createLiveRouter({ hub, requireAuth: (req, res, next) => { req.user = { id: uid, role }; next(); }, heartbeatMs: 40 });
  const app = express();
  app.use("/live", router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  return { hub, router, server, port, close: () => new Promise((r) => { router.closeAll(); server.close(r); }) };
}

function openStream(port, query) {
  return new Promise((resolve, reject) => {
    const req = http.get({ port, path: `/live/stream?topics=${query}` }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { buf += c; });
      resolve({ res, req, text: () => buf });
    });
    req.on("error", reject);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("stream delivers an SSE data event for a subscribed topic and sends heartbeats", async () => {
  const b = await boot();
  const s = await openStream(b.port, "t");
  assert.equal(s.res.statusCode, 200);
  assert.match(s.res.headers["content-type"], /text\/event-stream/);
  await wait(150);
  assert.match(s.text(), /event: data\ndata: \{.*"topic":"t".*"data":\{"n":1\}/);
  assert.match(s.text(), /: ping/);
  s.req.destroy();
  await b.close();
});

test("unknown topics are a 400 and never open a stream", async () => {
  const b = await boot();
  const s = await openStream(b.port, "nope");
  assert.equal(s.res.statusCode, 400);
  await b.close();
});

test("closing the browser connection unsubscribes it from the hub", async () => {
  const b = await boot();
  const s = await openStream(b.port, "t");
  await wait(80);
  assert.equal(b.hub.stats()[0].subscribers, 1);
  s.req.destroy();
  await wait(80);
  assert.equal(b.hub.stats()[0].subscribers, 0);
  await b.close();
});

test("a user is capped at 6 concurrent streams", async () => {
  const b = await boot();
  const streams = [];
  for (let i = 0; i < 6; i++) streams.push(await openStream(b.port, "t"));
  const seventh = await openStream(b.port, "t");
  assert.equal(seventh.res.statusCode, 429);
  streams.forEach((s) => s.req.destroy());
  await b.close();
});

test("closeAll ends open streams so the server can shut down", async () => {
  const b = await boot();
  const s = await openStream(b.port, "t");
  await wait(60);
  const ended = new Promise((r) => s.res.on("end", r));
  b.router.closeAll();
  await ended;
  await new Promise((r) => b.server.close(r));
});

test("stats is ADMIN-only", async () => {
  const b = await boot({ role: "OPERATOR" });
  const status = await new Promise((r) => http.get({ port: b.port, path: "/live/stats" }, (res) => { res.resume(); r(res.statusCode); }));
  assert.equal(status, 403);
  await b.close();
});
