// Unit tests for server/integrations/nexs/nexsBlockedInventoryBatchDirect.js -
// the direct-login pilot's server-side port of the runtime's own
// executeGetNexsBlockedInventoryBatch(). doRequest and nexsAuth are injected
// fakes - no real HTTPS call, no real login.

const test = require("node:test");
const assert = require("node:assert/strict");
const nexsBlockedInventoryBatchDirect = require("../../../integrations/nexs/nexsBlockedInventoryBatchDirect");

function fakeNexsAuth({ token = "fake" } = {}) {
  const calls = [];
  return {
    calls,
    async withAuth(fn) {
      calls.push(true);
      return fn(token);
    },
  };
}

const PAYLOAD = { nexsOrigin: "https://app.nexs.lenskart.com", pids: ["PID1", "PID2"], facilityCode: "NXS1" };

test("execute(): calls nexsAuth.withAuth (the shared login) once per unique PID, fetches the fixed per-PID URL", async () => {
  const nexsAuth = fakeNexsAuth();
  const calls = [];
  const doRequest = async (url, opts) => {
    calls.push({ url, opts });
    return { status: 200, body: { data: { totalInventory: 5, blockedInventory: 1, availableInventory: 4 } } };
  };
  const result = await nexsBlockedInventoryBatchDirect.execute(1, PAYLOAD, undefined, { nexsAuth, doRequest });
  assert.equal(nexsAuth.calls.length, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith("/nexs/cid/api/v1/warehouseInventory/getConsolidatedInvInfo/PID1"));
  assert.equal(calls[0].opts.headers["facility-code"], "NXS1");
  assert.equal(calls[0].opts.headers.Cookie, "jwt-token=fake");
  assert.deepEqual(result.results.map((r) => r.pid).sort(), ["PID1", "PID2"]);
});

test("execute(): a successful per-PID fetch reports status:ok with the parsed totals", async () => {
  const nexsAuth = fakeNexsAuth();
  const doRequest = async () => ({ status: 200, body: { data: { totalInventory: 10, blockedInventory: 3, availableInventory: 7 } } });
  const result = await nexsBlockedInventoryBatchDirect.execute(1, { ...PAYLOAD, pids: ["PID1"] }, undefined, { nexsAuth, doRequest });
  assert.deepEqual(result.results, [{ pid: "PID1", status: "ok", totalInventory: 10, blockedInventory: 3, availableInventory: 7, error: null }]);
});

test("execute(): a per-PID HTTP failure is isolated to that PID's own result entry, never fails the whole batch", async () => {
  const nexsAuth = fakeNexsAuth();
  const doRequest = async (url) => {
    if (url.endsWith("PID1")) return { status: 500, body: null };
    return { status: 200, body: { data: { totalInventory: 1, blockedInventory: 0, availableInventory: 1 } } };
  };
  const result = await nexsBlockedInventoryBatchDirect.execute(1, { ...PAYLOAD, pids: ["PID1", "PID2"] }, undefined, { nexsAuth, doRequest });
  const byPid = Object.fromEntries(result.results.map((r) => [r.pid, r]));
  assert.equal(byPid.PID1.status, "failed");
  assert.match(byPid.PID1.error, /NexS HTTP 500/);
  assert.equal(byPid.PID2.status, "ok");
});

test("execute(): a 401 is tagged UNAUTHORIZED so nexsAuth.withAuth() can invalidate+retry", async () => {
  const nexsAuth = {
    async withAuth(fn) {
      try {
        return await fn("first");
      } catch (e) {
        if (e.code !== "UNAUTHORIZED") throw e;
        return fn("second");
      }
    },
  };
  let calls = 0;
  const doRequest = async (url, opts) => {
    calls++;
    if (calls === 1) return { status: 401, body: null };
    return { status: 200, body: { data: {}, cookieUsed: opts.headers.Cookie } };
  };
  const result = await nexsBlockedInventoryBatchDirect.execute(1, { ...PAYLOAD, pids: ["PID1"] }, undefined, { nexsAuth, doRequest });
  assert.equal(calls, 2, "the 401 must trigger exactly one retry via withAuth");
  assert.equal(result.results[0].status, "ok");
});

test("execute(): dedups and trims pids before fetching, reports requestedCount vs uniqueCount", async () => {
  const nexsAuth = fakeNexsAuth();
  let fetchCount = 0;
  const doRequest = async () => {
    fetchCount++;
    return { status: 200, body: { data: {} } };
  };
  const result = await nexsBlockedInventoryBatchDirect.execute(1, { ...PAYLOAD, pids: ["PID1", " PID1 ", "PID2", "", "  "] }, undefined, { nexsAuth, doRequest });
  assert.equal(fetchCount, 2, "duplicate/blank pids must not be fetched twice");
  assert.equal(result.requestedCount, 5);
  assert.equal(result.uniqueCount, 2);
});

test("execute(): defaults facilityCode to NXS1 when not supplied", async () => {
  const nexsAuth = fakeNexsAuth();
  const calls = [];
  const doRequest = async (url, opts) => {
    calls.push(opts);
    return { status: 200, body: { data: {} } };
  };
  await nexsBlockedInventoryBatchDirect.execute(1, { nexsOrigin: PAYLOAD.nexsOrigin, pids: ["PID1"] }, undefined, { nexsAuth, doRequest });
  assert.equal(calls[0].headers["facility-code"], "NXS1");
});
