// Lease manager: connect-on-demand bookkeeping with a fake auth and clock.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLeaseManager } = require("../../../integrations/logins/nexsLease");

function harness() {
  let t = 1_000_000;
  const auth = {
    connected: false, logouts: 0, connects: 0, refuse: null, probe: null, hook: null,
    setLeaseProbe(f) { this.probe = f; }, setActivityHook(f) { this.hook = f; },
    async connect() { this.connects++; if (this.refuse) throw this.refuse; this.connected = true; },
    isConnected() { return this.connected; },
    async logout() { if (!this.connected) return false; this.connected = false; this.logouts++; return true; },
  };
  const mgr = createLeaseManager({ auth, now: () => t, ttlMs: 90000, idleGraceMs: 20000, schedule: () => null });
  return { auth, mgr, advance: (ms) => { t += ms; } };
}

test("acquire connects, hands back a lease, and marks the lease active for nexsAuth's gate", async () => {
  const { auth, mgr } = harness();
  assert.equal(auth.probe(), false);
  const { leaseId } = await mgr.acquire({ userId: 1, label: "Tote Purge" });
  assert.ok(leaseId);
  assert.equal(auth.connected, true);
  assert.equal(auth.probe(), true);
});

test("a refused connect (e.g. another session holds the account) throws and creates no lease", async () => {
  const { auth, mgr } = harness();
  auth.refuse = Object.assign(new Error("another active session"), { code: "MULTIPLE_SESSIONS" });
  await assert.rejects(() => mgr.acquire({ userId: 1 }), { code: "MULTIPLE_SESSIONS" });
  assert.equal(mgr.state().leases, 0);
  assert.equal(auth.probe(), false);
});

test("heartbeat renews the lease; without it the lease expires and the session is dropped when idle", async () => {
  const { auth, mgr, advance } = harness();
  const { leaseId } = await mgr.acquire({ userId: 1 });
  advance(60000);
  assert.equal(mgr.heartbeat(leaseId, 1), true);
  advance(60000);
  assert.equal(mgr.active(), true, "renewed at +60s so still alive at +120s");
  advance(100000); // browser vanished: no more heartbeats
  assert.equal(mgr.active(), false);
  await mgr.sweep();
  assert.equal(auth.logouts, 1, "tab closed -> session dropped");
});

test("release drops NexS shortly after the last lease, but never while a request is in flight", async () => {
  const { auth, mgr, advance } = harness();
  const { leaseId } = await mgr.acquire({ userId: 1 });
  auth.hook("start"); // a NexS request is running
  mgr.release(leaseId, 1);
  advance(60000);
  await mgr.sweep();
  assert.equal(auth.logouts, 0, "in-flight work keeps the session");
  auth.hook("end");
  advance(30000);
  await mgr.sweep();
  assert.equal(auth.logouts, 1);
});

test("two users share one session: it stays until BOTH have released", async () => {
  const { auth, mgr, advance } = harness();
  const a = await mgr.acquire({ userId: 1 });
  const b = await mgr.acquire({ userId: 2 });
  assert.equal(auth.connects, 2);
  mgr.release(a.leaseId, 1);
  advance(60000);
  await mgr.sweep();
  assert.equal(auth.logouts, 0);
  mgr.release(b.leaseId, 2);
  advance(60000);
  await mgr.sweep();
  assert.equal(auth.logouts, 1);
});

test("only the owner can renew or release a lease", async () => {
  const { mgr } = harness();
  const { leaseId } = await mgr.acquire({ userId: 1 });
  assert.equal(mgr.heartbeat(leaseId, 2), false);
  assert.equal(mgr.release(leaseId, 2), false);
  assert.equal(mgr.state().leases, 1);
  assert.equal(mgr.release(leaseId, 1), true);
});

test("a job lease keeps NexS alive after the page's lease is gone, and never expires on its own", async () => {
  const { auth, mgr, advance } = harness();
  const { leaseId } = await mgr.acquire({ userId: 1 });
  const end = mgr.beginJob("Tote Purge");
  mgr.release(leaseId, 1); // user left the page mid-calculation
  advance(10 * 60 * 1000);
  await mgr.sweep();
  assert.equal(auth.logouts, 0, "the job still needs NexS");
  end();
  advance(30000);
  await mgr.sweep();
  assert.equal(auth.logouts, 1, "dropped once the calculation is done");
});

test("beginJob refuses (NEXS_NOT_CONNECTED) when NexS is not connected, so a job never starts without it", () => {
  const { mgr } = harness();
  assert.throws(() => mgr.beginJob("x"), { code: "NEXS_NOT_CONNECTED" });
});

test("withJob releases its lease even when the work throws", async () => {
  const { auth, mgr } = harness();
  await mgr.acquire({ userId: 1 });
  await assert.rejects(() => mgr.withJob("x", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(mgr.state().leases, 1, "only the page lease is left");
  void auth;
});

test("heartbeat on an unknown/expired lease says so (the browser reconnects)", () => {
  const { mgr } = harness();
  assert.equal(mgr.heartbeat("nope", 1), false);
});

test("guardJob answers 409 NEXS_NOT_CONNECTED (so the browser shows the connect popup) instead of starting", () => {
  const { mgr } = harness();
  let status, body;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  assert.equal(mgr.guardJob(res, "Tote Purge"), null);
  assert.equal(status, 409);
  assert.equal(body.code, "NEXS_NOT_CONNECTED");
});

test("guardJob hands back an end function when NexS is connected", async () => {
  const { mgr } = harness();
  await mgr.acquire({ userId: 1 });
  const res = { status() { throw new Error("must not respond"); }, json() {} };
  const end = mgr.guardJob(res, "Tote Purge");
  assert.equal(typeof end, "function");
  assert.equal(mgr.state().leases, 2);
  end();
  assert.equal(mgr.state().leases, 1);
});
