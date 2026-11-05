// Unit tests for server/integrations/quadron/quadronInventoryDirect.js - the
// direct-login pilot's server-side port of the runtime's own
// executeGetQuadronInventory(). doRequest and concinityAuth are injected
// fakes - no real HTTPS call, no real login. Response fixtures mirror the
// real Quadron dashboard shape (materialDetails[0].quantity/sku) that the
// runtime's own already-verified implementation parses.
//
// doRequest's {status, body} shape (not a fetch-like Response) matches what
// the real module now actually uses (node:https + a private insecure Agent,
// per this file's own header comment on the 2026-09-05 live-test regression
// where the global `fetch` couldn't bypass 192.168.24.230's self-signed
// cert and every request failed with a bare "fetch failed").

const test = require("node:test");
const assert = require("node:assert/strict");
const quadronInventoryDirect = require("../../../integrations/quadron/quadronInventoryDirect");

function fakeConcinityAuth({ token = "fake.jwt.token" } = {}) {
  const calls = [];
  return {
    calls,
    async withAuth(fn) {
      calls.push(true);
      return fn(token);
    },
  };
}

function fakeRequest(body, { status = 200 } = {}) {
  const calls = [];
  return {
    calls,
    async doRequest(url, opts) {
      calls.push({ url, opts });
      return { status, body };
    },
  };
}

test("execute(): calls concinityAuth.withAuth (the shared login), fetches the fixed Quadron dashboard URL", async () => {
  const concinityAuth = fakeConcinityAuth();
  const { doRequest, calls } = fakeRequest({ content: [] });
  await quadronInventoryDirect.execute(7, { quadronOrigin: "https://192.168.24.230", instanceCode: "LK-069" }, undefined, { concinityAuth, doRequest });
  assert.equal(concinityAuth.calls.length, 1);
  assert.equal(calls[0].url, "https://192.168.24.230/wes/inventory/dashboard/data");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer fake.jwt.token");
  assert.equal(calls[0].opts.headers.instanceCode, "LK-069");
});

test("execute(): defaults instanceCode to LK-069 when not supplied", async () => {
  const concinityAuth = fakeConcinityAuth();
  const { doRequest, calls } = fakeRequest({ content: [] });
  await quadronInventoryDirect.execute(1, { quadronOrigin: "https://x" }, undefined, { concinityAuth, doRequest });
  assert.equal(calls[0].opts.headers.instanceCode, "LK-069");
});

test("execute(): aggregates partitioned rows up to their base tote id, summing quantity", async () => {
  const concinityAuth = fakeConcinityAuth();
  const raw = {
    content: [
      { toteId: "TS0000018492-1", materialDetails: [{ quantity: 2, sku: "SKU1" }] },
      { toteId: "TS0000018492-2", materialDetails: [{ quantity: 3, sku: "SKU2" }] },
      { toteId: "TL0000003490", materialDetails: [{ quantity: 5, sku: "SKU3" }] },
    ],
  };
  const { doRequest } = fakeRequest(raw);
  const result = await quadronInventoryDirect.execute(1, { quadronOrigin: "https://x" }, undefined, { concinityAuth, doRequest });

  const byId = Object.fromEntries(result.rows.map((r) => [r.toteId, r]));
  assert.equal(byId["TS0000018492"].quadronQty, 5);
  assert.equal(byId["TS0000018492"].partitions.length, 2);
  assert.equal(byId["TL0000003490"].quadronQty, 5);
  assert.equal(byId["TL0000003490"].partitions.length, 0);
  assert.equal(result.rowCount, 2);
});

test("execute(): rows with a toteId that fails the TL/TS pattern are dropped, not passed through", async () => {
  const concinityAuth = fakeConcinityAuth();
  const raw = { content: [{ toteId: "NOT-A-TOTE", materialDetails: [{ quantity: 1 }] }] };
  const { doRequest } = fakeRequest(raw);
  const result = await quadronInventoryDirect.execute(1, { quadronOrigin: "https://x" }, undefined, { concinityAuth, doRequest });
  assert.deepEqual(result.rows, []);
});

test("execute(): accepts a bare array response body (not just {content:[...]})", async () => {
  const concinityAuth = fakeConcinityAuth();
  const raw = [{ toteId: "TL0000003490", materialDetails: [{ quantity: 4 }] }];
  const { doRequest } = fakeRequest(raw);
  const result = await quadronInventoryDirect.execute(1, { quadronOrigin: "https://x" }, undefined, { concinityAuth, doRequest });
  assert.equal(result.rows[0].toteId, "TL0000003490");
  assert.equal(result.rows[0].quadronQty, 4);
});

test("execute(): a 401/403 response is tagged UNAUTHORIZED so concinityAuth.withAuth() can invalidate+retry", async () => {
  const token = "fake.jwt.token";
  const concinityAuth = {
    async withAuth(fn) {
      try {
        return await fn(token);
      } catch (e) {
        if (e.code !== "UNAUTHORIZED") throw e;
        return fn(token); // simulates the real withAuth's single retry
      }
    },
  };
  let requestCalls = 0;
  const doRequest = async () => {
    requestCalls++;
    if (requestCalls === 1) return { status: 401, body: {} };
    return { status: 200, body: { content: [] } };
  };
  const result = await quadronInventoryDirect.execute(1, { quadronOrigin: "https://x" }, undefined, { concinityAuth, doRequest });
  assert.equal(requestCalls, 2, "the 401 must trigger exactly one retry via withAuth");
  assert.deepEqual(result.rows, []);
});

test("execute(): a non-auth HTTP error throws without a code, never silently swallowed", async () => {
  const concinityAuth = fakeConcinityAuth();
  const doRequest = async () => ({ status: 500, body: {} });
  await assert.rejects(
    quadronInventoryDirect.execute(1, { quadronOrigin: "https://x" }, undefined, { concinityAuth, doRequest }),
    /Quadron HTTP 500/
  );
});

test("decodeJwtSub(): extracts the sub claim from a well-formed JWT", () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "FR1" })).toString("base64url");
  const token = `${header}.${payload}.sig`;
  assert.equal(quadronInventoryDirect.decodeJwtSub(token), "FR1");
});

test("decodeJwtSub(): returns an empty string for an undecodable token rather than throwing", () => {
  assert.equal(quadronInventoryDirect.decodeJwtSub("not-a-jwt"), "");
});

test("splitPartitionedToteId(): splits base and partition number", () => {
  assert.deepEqual(quadronInventoryDirect.splitPartitionedToteId("TS0000018492-6"), { base: "TS0000018492", part: 6 });
  assert.deepEqual(quadronInventoryDirect.splitPartitionedToteId("TL0000003490"), { base: "TL0000003490", part: null });
});
