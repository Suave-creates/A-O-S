// Pure unit tests for server/features/connection-status/connectionStatus.js - the shared Connection
// Status model. No database, no network: the three auth modules are fakes.
//
// "Connected" for Grafana/Concinity means the backend can obtain a valid
// shared-account session right now (getValidToken() resolves). NexS is
// deliberately PASSIVE (single active session per account): it only reports
// a session already cached from genuine prior use and must NEVER trigger a
// login itself.

const test = require("node:test");
const assert = require("node:assert/strict");
const { getConnectionStatus, getServiceReadiness } = require("../../../integrations/logins/connectionStatus");

const okAuth = () => ({ getValidToken: async () => "token" });
const failingAuth = () => ({ getValidToken: async () => { throw new Error("login failed"); } });
const nexs = (cached) => ({ hasCachedSession: () => cached, getValidToken: async () => { throw new Error("must never be called by the badge"); } });

const CONNECTED = { connected: true, identity: "Connected" };
const DISCONNECTED = { connected: false, identity: "Disconnected" };

test("all three have a session: each shows Connected", async () => {
  const status = await getConnectionStatus({ grafanaAuth: okAuth(), concinityAuth: okAuth(), nexsAuth: nexs(true) });
  assert.deepEqual(status, { grafana: CONNECTED, concinity: CONNECTED, nexs: CONNECTED });
});

test("nothing available: all three show Disconnected", async () => {
  const status = await getConnectionStatus({ grafanaAuth: failingAuth(), concinityAuth: failingAuth(), nexsAuth: nexs(false) });
  assert.deepEqual(status, { grafana: DISCONNECTED, concinity: DISCONNECTED, nexs: DISCONNECTED });
});

test("services are independent: a Concinity login failure does not affect Grafana or NexS", async () => {
  const status = await getConnectionStatus({ grafanaAuth: okAuth(), concinityAuth: failingAuth(), nexsAuth: nexs(true) });
  assert.deepEqual(status, { grafana: CONNECTED, concinity: DISCONNECTED, nexs: CONNECTED });
});

test("a Grafana login failure does not affect Concinity or NexS", async () => {
  const status = await getConnectionStatus({ grafanaAuth: failingAuth(), concinityAuth: okAuth(), nexsAuth: nexs(false) });
  assert.deepEqual(status, { grafana: DISCONNECTED, concinity: CONNECTED, nexs: DISCONNECTED });
});

test("NexS is passive: the badge never calls getValidToken() (it would log in and kick out the account's single active session)", async () => {
  // nexs() throws if getValidToken() is called - reaching here proves it wasn't.
  await assert.doesNotReject(getConnectionStatus({ grafanaAuth: okAuth(), concinityAuth: okAuth(), nexsAuth: nexs(false) }));
});

test("each call re-derives from the current auth state - no sticky status", async () => {
  let up = true;
  const grafanaAuth = { getValidToken: async () => { if (!up) throw new Error("down"); return "t"; } };
  const deps = { grafanaAuth, concinityAuth: okAuth(), nexsAuth: nexs(false) };
  assert.equal((await getConnectionStatus(deps)).grafana.connected, true);
  up = false;
  assert.equal((await getConnectionStatus(deps)).grafana.connected, false);
  up = true;
  assert.equal((await getConnectionStatus(deps)).grafana.connected, true);
});

test("status values never carry an identity, workstation, or error text - just Connected/Disconnected", async () => {
  const status = await getConnectionStatus({ grafanaAuth: failingAuth(), concinityAuth: okAuth(), nexsAuth: nexs(true) });
  for (const s of Object.values(status)) {
    assert.deepEqual(Object.keys(s).sort(), ["connected", "identity"]);
    assert.ok(["Connected", "Disconnected"].includes(s.identity));
  }
});

// ── getServiceReadiness (Purge's real prerequisite gate) ────────────────

test("getServiceReadiness: ready only when the shared account for each service is fully configured", () => {
  assert.deepEqual(
    getServiceReadiness({ nexsDirectUsername: "u", nexsDirectPassword: "p", concinityDirectUsername: "u", concinityDirectPassword: "p" }),
    { nexsReady: true, quadronReady: true }
  );
  assert.deepEqual(
    getServiceReadiness({ nexsDirectUsername: "u", nexsDirectPassword: null, concinityDirectUsername: "u", concinityDirectPassword: "p" }),
    { nexsReady: false, quadronReady: true }
  );
  assert.deepEqual(
    getServiceReadiness({ nexsDirectUsername: "u", nexsDirectPassword: "p", concinityDirectUsername: null, concinityDirectPassword: null }),
    { nexsReady: true, quadronReady: false }
  );
});
