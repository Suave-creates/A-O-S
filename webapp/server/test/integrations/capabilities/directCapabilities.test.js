// Tests for the server-side (direct) executors that replaced the ASO Browser
// Runtime's capability handlers: grafanaMultiQueryDirect, nexsBlockedInventory
// Direct, nexsDiscrepancyReportBatchDirect, pullQuadronToteDirect. No network:
// auth modules and the HTTP layer are injected fakes.

const test = require("node:test");
const assert = require("node:assert/strict");

const grafana = require("../../../integrations/grafana/grafanaMultiQueryDirect");
const nexsSingle = require("../../../integrations/nexs/nexsBlockedInventoryDirect");
const nexsDiscrepancy = require("../../../integrations/nexs/nexsDiscrepancyReportBatchDirect");
const pullDirect = require("../../../integrations/quadron/pullQuadronToteDirect");

// ── Grafana ──────────────────────────────────────────────────────────────

// A Grafana ds/query response whose single frame has the given columns/rows.
function frame(cols) {
  const names = Object.keys(cols);
  return {
    results: { A: { frames: [{ schema: { fields: names.map((name) => ({ name })) }, data: { values: names.map((n) => cols[n]) } }] } },
  };
}

// grafanaAuth fake that just runs fn; doRequest answers by the SQL it receives.
function grafanaDeps(answer) {
  const requests = [];
  return {
    requests,
    grafanaAuth: { withAuth: (fn) => fn("grafana_session=abc") },
    doRequest: async (url, { headers, body }) => {
      const parsed = JSON.parse(body);
      requests.push({ url, headers, query: parsed.queries[0], from: parsed.from, to: parsed.to });
      return { status: 200, body: answer(parsed.queries[0].rawSql, parsed) };
    },
  };
}

const ORIGIN = "https://grafana.test";
const base = { grafanaOrigin: ORIGIN, datasourceUid: "uid", datasourceType: "mssql", datasourceId: 1 };
const shiftWindows = { A: { from: 1, to: 2 }, B: { from: 3, to: 4 }, C: { from: 5, to: 6 } };

test("grafana: per-shift scalar capabilities read the right column from each shift's own window", async () => {
  const deps = grafanaDeps((sql, parsed) => frame({ total_compactions: [Number(parsed.from) * 10] }));
  const out = await grafana.executeCompactionCount(1, { ...base, sql: "SELECT 1", windows: shiftWindows }, undefined, deps);
  assert.deepEqual(out.windows, { A: 10, B: 30, C: 50 });
  assert.ok(out.fetchedAt);
  assert.ok(deps.requests.every((r) => r.url === `${ORIGIN}/grafana/api/ds/query`), "the path is fixed, never taken from the payload");

  const freed = await grafana.executeTotesFreedCount(1, { ...base, sql: "SELECT 1", windows: shiftWindows }, undefined, grafanaDeps(() => frame({ Totes_freed_updated_value: [7] })));
  assert.deepEqual(freed.windows, { A: 7, B: 7, C: 7 });
});

test("grafana: a missing/empty result row is 0, a missing window is rejected", async () => {
  const empty = await grafana.executeCompactionCount(1, { ...base, sql: "x", windows: shiftWindows }, undefined, grafanaDeps(() => frame({ total_compactions: [] })));
  assert.deepEqual(empty.windows, { A: 0, B: 0, C: 0 });
  await assert.rejects(grafana.executeCompactionCount(1, { ...base, sql: "x", windows: { A: shiftWindows.A } }, undefined, grafanaDeps(() => frame({}))), /Missing\/invalid windows\.B/);
});

test("grafana: per-hour production runs 24 queries and uses the NJIT vs JIT column names", async () => {
  const hourWindows = { A: [], B: [], C: [] };
  for (const k of ["A", "B", "C"]) for (let h = 0; h < 8; h++) hourWindows[k].push({ from: (k.charCodeAt(0) - 65) * 100 + h, to: 1e9 });
  const njitDeps = grafanaDeps((sql, parsed) => frame({ completedOrders: [Number(parsed.from)] }));
  const njit = await grafana.executeAsrsProductionNjit(1, { ...base, sql: "x", hourWindows }, undefined, njitDeps);
  assert.equal(njitDeps.requests.length, 24);
  assert.deepEqual(njit.hours.A, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(njit.hours.C, [200, 201, 202, 203, 204, 205, 206, 207]);

  const jit = await grafana.executeAsrsProductionJit(1, { ...base, sql: "x", hourWindows }, undefined, grafanaDeps(() => frame({ CompletedOrders: [4] })));
  assert.deepEqual(jit.hours.B, [4, 4, 4, 4, 4, 4, 4, 4]);

  await assert.rejects(grafana.executeAsrsProductionNjit(1, { ...base, sql: "x", hourWindows: { A: [], B: [], C: [] } }, undefined, njitDeps), /Missing\/invalid hourWindows\.A/);
});

test("grafana: per-hour queries never exceed the worker-pool concurrency of 8", async () => {
  let inFlight = 0;
  let peak = 0;
  const hourWindows = { A: [], B: [], C: [] };
  for (const k of ["A", "B", "C"]) for (let h = 0; h < 8; h++) hourWindows[k].push({ from: h, to: h + 1 });
  const deps = {
    grafanaAuth: { withAuth: (fn) => fn("s") },
    doRequest: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return { status: 200, body: frame({ completedOrders: [1] }) };
    },
  };
  await grafana.executeAsrsProductionNjit(1, { ...base, sql: "x", hourWindows }, undefined, deps);
  assert.ok(peak <= 8 && peak > 1, `peak concurrency was ${peak}`);
});

test("grafana: CC metrics maps discrepancy and stock-check rows to the approved fields only", async () => {
  const deps = grafanaDeps((sql) =>
    sql === "DISC"
      ? frame({ station: ["S1"], operation_type: ["PICK"], user: ["u"], container: ["TS1"], type: ["T"], discrepancy_type: ["D"], create_time: [1], secret: ["leak"] })
      : frame({ sku: ["K"], storer: ["st"], quantity: [2], type: ["OK"], station: ["S2"], user: ["u2"], container: ["TS2"], create_time: [9], secret: ["leak"] })
  );
  const out = await grafana.executeCcMetrics(1, { ...base, discrepancySql: "DISC", stockCheckSql: "STOCK", windows: shiftWindows }, undefined, deps);
  assert.deepEqual(out.windows.A.discRows, [{ station: "S1", operationType: "PICK", user: "u", container: "TS1", eventType: "T", discrepancyType: "D", createTime: 1 }]);
  assert.deepEqual(out.windows.B.stockRows, [{ sku: "K", storer: "st", quantity: 2, resultType: "OK", station: "S2", user: "u2", container: "TS2", createTime: 9 }]);
  assert.ok(!JSON.stringify(out).includes("leak"));
});

test("grafana: aisle occupancy normalizes values/categories; partition counts drop rows without a container and coerce qty", async () => {
  const occ = await grafana.executeAisleOccupancy(
    1,
    { ...base, occupancySql: "OCC", longShortSql: "LS" },
    undefined,
    grafanaDeps((sql) => (sql === "OCC" ? frame({ aisle: [1, 2], value: [50, null] }) : frame({ aisle: [1], category: ["long"], occupancy: [3] })))
  );
  assert.deepEqual(occ.occupancy, [{ aisle: "1", value: 50 }, { aisle: "2", value: null }]);
  assert.deepEqual(occ.longShort, [{ aisle: "1", category: "LONG", occupancy: 3 }]);

  const parts = await grafana.executeTotePartitionCounts(
    1,
    { ...base, queries: [{ sql: "a", fromMs: 1, toMs: 2 }, { sql: "b", fromMs: 1, toMs: 2 }] },
    undefined,
    grafanaDeps(() => frame({ container: ["TS1", "", null], qty: ["4", 1, 1] }))
  );
  assert.deepEqual(parts.rows, [{ container: "TS1", qty: 4 }, { container: "TS1", qty: 4 }]);
  await assert.rejects(grafana.executeTotePartitionCounts(1, { ...base, queries: [] }, undefined, grafanaDeps(() => frame({}))), /non-empty array/);
});

test("grafana: an HTTP 401 is tagged UNAUTHORIZED so the shared login can refresh and retry", async () => {
  let attempts = 0;
  const deps = {
    grafanaAuth: {
      withAuth: async (fn) => {
        try { return await fn("old"); } catch (e) { if (e.code !== "UNAUTHORIZED") throw e; return fn("fresh"); }
      },
    },
    doRequest: async (url, { headers }) => {
      attempts++;
      return headers.Cookie === "old" ? { status: 401, body: null } : { status: 200, body: frame({ total_compactions: [3] }) };
    },
  };
  const out = await grafana.executeCompactionCount(1, { ...base, sql: "x", windows: shiftWindows }, undefined, deps);
  assert.equal(out.windows.A, 3);
  assert.ok(attempts >= 2);
});

// ── NexS ─────────────────────────────────────────────────────────────────

const NEXS = "https://nexs.test";
const nexsAuthFake = { withAuth: async (fn) => fn("T") };

test("nexs single PID: trims the pid, defaults the facility to NXS1, sends the cookie, returns the raw data object", async () => {
  const seen = [];
  const doRequest = async (url, { headers }) => {
    seen.push({ url, headers });
    return { status: 200, body: { data: { totalInventory: 5, blockedInventory: 2, availableInventory: 3 } } };
  };
  const out = await nexsSingle.execute(1, { nexsOrigin: NEXS, pid: " P1 " }, undefined, { nexsAuth: nexsAuthFake, doRequest });
  assert.equal(out.pid, "P1");
  assert.deepEqual(out.data, { totalInventory: 5, blockedInventory: 2, availableInventory: 3 });
  assert.equal(seen[0].url, `${NEXS}/nexs/cid/api/v1/warehouseInventory/getConsolidatedInvInfo/P1`);
  assert.equal(seen[0].headers["facility-code"], "NXS1");
  assert.equal(seen[0].headers.Cookie, "jwt-token=T");
  await assert.rejects(nexsSingle.execute(1, { nexsOrigin: NEXS, pid: "  " }, undefined, { nexsAuth: nexsAuthFake, doRequest }), /pid is required/);
});

test("nexs single PID: a 401 is tagged UNAUTHORIZED; other non-2xx is a plain error", async () => {
  const run = (status) => nexsSingle.execute(1, { nexsOrigin: NEXS, pid: "P" }, undefined, { nexsAuth: nexsAuthFake, doRequest: async () => ({ status, body: null }) });
  await assert.rejects(run(401), (e) => e.code === "UNAUTHORIZED");
  await assert.rejects(run(500), (e) => /NexS HTTP 500/.test(e.message) && e.code !== "UNAUTHORIZED");
});

test("nexs discrepancy batch: builds the exact location URL, reads imsCount, isolates per-item failures, rethrows aborts", async () => {
  const urls = [];
  const doRequest = async (url, { headers }) => {
    urls.push(url);
    assert.equal(headers["source-domain"], NEXS);
    assert.equal(headers["facility-code"], "NXS1");
    if (url.includes("_PR2")) return { status: 500, body: null };
    return { status: 200, body: { data: { imsCount: "3" } } };
  };
  const items = [{ base: "TS0000000001", part: 1 }, { base: "TS0000000001", part: 2 }];
  const out = await nexsDiscrepancy.execute(1, { nexsOrigin: NEXS, items }, undefined, { nexsAuth: nexsAuthFake, doRequest });
  assert.deepEqual(out.results[0], { base: "TS0000000001", part: 1, status: "ok", imsCount: 3, error: null });
  assert.equal(out.results[1].status, "failed");
  assert.match(out.results[1].error, /NexS HTTP 500/);
  assert.ok(urls[0].includes("location=NXS1-ASRS-TS0000000001_PR1"));

  const abort = async () => { throw Object.assign(new Error("Aborted"), { name: "AbortError" }); };
  await assert.rejects(nexsDiscrepancy.execute(1, { nexsOrigin: NEXS, items }, undefined, { nexsAuth: nexsAuthFake, doRequest: abort }), (e) => e.name === "AbortError");
  await assert.rejects(nexsDiscrepancy.execute(1, { nexsOrigin: NEXS, items: [] }, undefined, { nexsAuth: nexsAuthFake, doRequest }), /non-empty array/);
});

// ── Quadron pull (the one write) ─────────────────────────────────────────

const QUADRON = "https://quadron.test";
const fakeJwt = "h." + Buffer.from(JSON.stringify({ sub: "FR1" })).toString("base64url") + ".s";
const concinityFake = { withAuth: async (fn) => fn(fakeJwt) };
const pullPayload = { quadronOrigin: QUADRON, toteId: "TS0000000001", zone: 5, instanceCode: "LK-069" };

test("classifyQuadronPullResult: the four real outcomes, and null for anything unrecognized", () => {
  const c = pullDirect.classifyQuadronPullResult;
  assert.equal(c(200, true, { success: true, message: "ok" }).verdict, "INSERTED");
  assert.equal(c(400, false, { message: "Tote is already in the queue" }).verdict, "ALREADY_QUEUED");
  assert.equal(c(400, false, { message: "tote is in movement" }).verdict, "ALREADY_QUEUED");
  assert.equal(c(400, false, { message: "Released from Quadron" }).verdict, "RELEASED");
  assert.equal(c(404, false, { message: "boom" }).verdict, "NOT_AVAILABLE");
  assert.equal(c(200, true, null).verdict, "NOT_AVAILABLE");
  assert.equal(c(500, false, { message: "something else entirely" }), null);
});

test("pull: POSTs the fixed path with container+station and Bearer/X-User-Info-Name, and returns a result the capability validator accepts", async () => {
  const seen = [];
  const doRequest = async (url, opts) => {
    seen.push({ url, ...opts });
    return { status: 200, body: { success: true, message: "inserted" } };
  };
  const out = await pullDirect.execute(1, pullPayload, undefined, { concinityAuth: concinityFake, doRequest });
  assert.equal(out.verdict, "INSERTED");
  assert.equal(seen[0].url, `${QUADRON}/quadron/dashboard/pull-crate`);
  assert.deepEqual(JSON.parse(seen[0].body), { container: "TS0000000001", station: "5" });
  assert.equal(seen[0].headers.Authorization, `Bearer ${fakeJwt}`);
  assert.equal(seen[0].headers["X-User-Info-Name"], "FR1");
  assert.equal(seen[0].headers.instanceCode, "LK-069");

  const { validateResult } = require("../../../integrations/quadron/pullQuadronTote");
  assert.deepEqual(validateResult(out), { ok: true });
});

test("pull: a classifiable non-2xx (404 not available) is a real outcome, an unrecognized one fails, and a 401 is tagged UNAUTHORIZED for one re-login", async () => {
  const run = (status, body) => pullDirect.execute(1, pullPayload, undefined, { concinityAuth: concinityFake, doRequest: async () => ({ status, body }) });
  assert.equal((await run(404, { message: "Tote not found" })).verdict, "NOT_AVAILABLE");
  await assert.rejects(run(500, { message: "kaboom" }), /Unrecognized Quadron response/);
  await assert.rejects(run(401, null), (e) => e.code === "UNAUTHORIZED");
});

test("pull: rejects an invalid tote id or missing zone before any request is made", async () => {
  let called = false;
  const doRequest = async () => { called = true; return { status: 200, body: { success: true } }; };
  await assert.rejects(pullDirect.execute(1, { ...pullPayload, toteId: "bogus" }, undefined, { concinityAuth: concinityFake, doRequest }), /not a valid tote id/);
  await assert.rejects(pullDirect.execute(1, { ...pullPayload, zone: "" }, undefined, { concinityAuth: concinityFake, doRequest }), /zone is required/);
  assert.equal(called, false);
});
