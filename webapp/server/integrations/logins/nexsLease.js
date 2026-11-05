// NexS connect-on-demand: who currently needs the (single, shared) NexS session.
//
// NexS allows ONE session per account, so the app logs in only while a person
// actually needs NexS and drops the session afterwards:
//   - A screen that starts a NexS action asks to connect (POST /nexs/connect);
//     the server logs in and hands back a LEASE.
//   - The browser renews the lease (heartbeat) while that screen is open and
//     releases it when the user leaves (or closes the tab). A tab that vanishes
//     simply stops renewing and the lease expires.
//   - A running job holds its own server-side lease (beginJob) so leaving the page
//     mid-calculation never cuts NexS off underneath it.
//   - When no lease is left AND no NexS request is in flight, the session is
//     logged out after a short idle grace.
// Background code (dashboard feeds, page loads) never holds a lease, so it can
// never cause a NexS login - see nexsAuth.js's policy.

const crypto = require("node:crypto");
const defaultAuth = require("./nexsAuth");
const config = require("../../config");

function createLeaseManager({
  auth = defaultAuth,
  now = Date.now,
  ttlMs = config.nexsLeaseTtlMs,
  idleGraceMs = config.nexsIdleGraceMs,
  sweepMs = 10 * 1000,
  schedule = (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); return t; },
  log = () => {},
} = {}) {
  const leases = new Map(); // id -> { owner, label, expiresAt, job }
  let inflight = 0;
  let lastActivityAt = 0;
  let disconnecting = null;

  function prune() {
    const t = now();
    for (const [id, l] of leases) if (!l.job && l.expiresAt <= t) leases.delete(id);
  }
  const active = () => {
    prune();
    return leases.size > 0;
  };

  auth.setLeaseProbe(active);
  auth.setActivityHook((phase) => {
    if (phase === "start") inflight += 1;
    else inflight = Math.max(0, inflight - 1);
    lastActivityAt = now();
  });

  // Drop the session when nobody needs it and nothing is using it.
  async function sweep() {
    prune();
    if (leases.size > 0 || inflight > 0 || !auth.isConnected()) return false;
    if (now() - lastActivityAt < idleGraceMs) return false;
    if (disconnecting) return disconnecting;
    disconnecting = (async () => {
      try {
        const done = await auth.logout();
        if (done) log("[nexs] disconnected (no one needs NexS)");
        return done;
      } finally {
        disconnecting = null;
      }
    })();
    return disconnecting;
  }

  // Connect (login if needed) and take a lease for this user. Throws the login
  // error (MULTIPLE_SESSIONS, LOGIN_FAILED, ...) untouched when NexS refuses.
  async function acquire({ userId, label = "" }) {
    await auth.connect();
    const id = crypto.randomUUID();
    lastActivityAt = now();
    leases.set(id, { owner: userId, label, expiresAt: now() + ttlMs, job: false });
    return { leaseId: id, ttlMs };
  }

  function owned(id, userId) {
    const l = leases.get(id);
    return l && l.owner === userId && !l.job ? l : null;
  }

  function heartbeat(id, userId) {
    const l = owned(id, userId);
    if (!l) return false; // not this user's lease (or unknown) - never touch someone else's
    if (l.expiresAt <= now()) {
      leases.delete(id);
      return false; // expired - the client must reconnect
    }
    l.expiresAt = now() + ttlMs;
    lastActivityAt = now();
    return true;
  }

  function release(id, userId) {
    const l = owned(id, userId);
    if (!l) return false;
    leases.delete(id);
    lastActivityAt = now() - idleGraceMs + 5000; // disconnect shortly after the last release (lets a request in flight finish)
    return true;
  }

  // A server-side job that needs NexS holds its own lease until it settles.
  // Fails fast with NEXS_NOT_CONNECTED when NexS isn't connected - callers
  // (routes) turn that into a "connect first" answer for the browser.
  function beginJob(label = "job") {
    if (!auth.isConnected()) {
      const err = new Error("NexS is not connected. Connect to NexS first.");
      err.code = "NEXS_NOT_CONNECTED";
      throw err;
    }
    const id = crypto.randomUUID();
    leases.set(id, { owner: null, label, expiresAt: Infinity, job: true });
    let ended = false;
    return function endJob() {
      if (ended) return;
      ended = true;
      leases.delete(id);
      lastActivityAt = now();
    };
  }

  // For routes: start a job lease, or answer 409 { code: "NEXS_NOT_CONNECTED" } (the browser
  // then shows the Connect popup) and return null. Call the returned function when the job ends.
  function guardJob(res, label) {
    try {
      return beginJob(label);
    } catch (e) {
      res.status(409).json({ error: e.message, code: e.code || "NEXS_NOT_CONNECTED" });
      return null;
    }
  }

  // Convenience: run fn() holding a job lease for its whole duration.
  async function withJob(label, fn) {
    const end = beginJob(label);
    try {
      return await fn();
    } finally {
      end();
    }
  }

  function state() {
    prune();
    return { connected: auth.isConnected(), leases: leases.size, inflight };
  }

  const timer = schedule(() => { sweep().catch(() => {}); }, sweepMs);
  function stop() {
    if (timer && typeof timer === "object") clearInterval(timer);
  }

  return { acquire, heartbeat, release, beginJob, guardJob, withJob, sweep, state, active, stop };
}

module.exports = createLeaseManager();
module.exports.createLeaseManager = createLeaseManager;
