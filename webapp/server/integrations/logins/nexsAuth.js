// Direct-login pilot (2026-09-05, operator-approved) - NexS auth manager.
//
// SHARED single-login (2026-09-22, operator-requested: "single login point
// ... all logged in together" - copies the Monitor Panel Revamped project's
// own NexS login exactly, same account, same idea: ONE service login for
// every ASO Web App user, not a credential each person saves individually).
// This is now the ONE direct-login family in server/integrations/logins/ that
// does NOT read server_credentials at all - config.nexsDirectUsername/
// nexsDirectPassword (env-configured, see config.js's own comment) is the
// single shared account, cached process-wide rather than per appUserId.
// grafanaAuth.js/concinityAuth.js are UNCHANGED (still per-user) - the
// operator's own instruction was Grafana/Concinity already share one login
// via the existing runtime-relay tab and don't need this; only NexS (which
// has no such working runtime session today) gets this treatment.
//
// Logs in server-side instead of relaying through the ASO Browser Runtime,
// and caches the resulting jwt-token in-memory (NOT persisted - process
// restart re-logs in, same as before) until it's within REFRESH_BUFFER_MS
// of its own JWT-encoded expiry.
//
// Confirmed live response shape (captured directly from the real NexS login,
// 2026-09-05):
//   POST {nexsOrigin}/v1/user/login  {"userName","password"}
//   -> 200 {"success":true,"message":"User logged in successfully","content":"<jwt>"}
// The same JWT is also set via Set-Cookie: jwt-token=...; HttpOnly (24h
// Max-Age in the captured response) - this module uses the body's own
// "content" field directly rather than parsing Set-Cookie, since it carries
// the identical token. Downstream NexS requests authenticate via a
// `Cookie: jwt-token=<token>` header (cookie-based, NOT a bearer token -
// see the existing runtime's own capabilities.js comment on this).
//
// app.nexs.lenskart.com is NexS's public, properly-certified endpoint (per
// the existing extension's own precedent) - no self-signed-cert handling
// needed here, unlike concinityAuth.js's insecure Agent for 192.168.24.230.
//
// The login response carries no explicit "tokenValidity" field (unlike
// Concinity) - real expiry is only known via the returned JWT's own `exp`
// claim (seconds since epoch), so this module decodes that claim directly
// rather than assuming a fixed lifetime.

const config = require("../../config");

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // re-login 5 min before real expiry, never cut it exactly at the edge

function decodeJwtExpiryMs(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch (e) {
    return null;
  }
}

async function defaultPostJson(url, bodyObj) {
  const resp = await fetch(url, {
    method: "POST",
    // The NexS web portal sends these two headers on its own login call
    // (read from its production bundle, 2026-10-12); without them NexS
    // rejects the login with 400 "Invalid app".
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Lenskart-App-Id": "nexs_search", "source-domain": new URL(url).origin },
    body: JSON.stringify(bodyObj),
  });
  let parsed = null;
  try {
    parsed = await resp.json();
  } catch (e) {
    /* non-JSON response - parsed stays null, callers check for it */
  }
  return { status: resp.status, body: parsed };
}

// The one shared session - { token, expiresAt } | null. No longer keyed by
// appUserId: there is exactly one NexS identity behind this whole app now.
let shared = null;
let loginPromise = null;

// ── Connect on demand ──────────────────────────────────────────────────────
// NexS allows ONE session per account, so this app holds a session only while a
// person actually needs it (nexsLease.js grants leases; the session is dropped
// when the last lease is released and the work is idle). Policy: a login is
// allowed only (a) explicitly via connect(), or (b) while at least one lease is
// active (e.g. re-login after a 401 mid-job). Anything else - a background feed,
// a page load - fails with NEXS_NOT_CONNECTED instead of silently logging in.
let policy = { requireLease: true };
let leaseProbe = () => false;
let activityHook = null;

function configure(next) {
  policy = { ...policy, ...next };
}
function setLeaseProbe(fn) {
  leaseProbe = typeof fn === "function" ? fn : () => false;
}
function setActivityHook(fn) {
  activityHook = typeof fn === "function" ? fn : null;
}

function notConnectedError() {
  const err = new Error("NexS is not connected. Connect to NexS first (you'll be asked when you start a NexS action).");
  err.code = "NEXS_NOT_CONNECTED";
  return err;
} // single-flight guard - concurrent callers await the SAME in-progress login rather than each starting their own

function reset() {
  shared = null;
  loginPromise = null;
  policy = { requireLease: true };
  leaseProbe = () => false;
  activityHook = null;
}

function invalidate() {
  shared = null;
}

// username/password are injectable purely for deterministic testing (no
// real config/env needed to unit-test this module) - production callers
// always rely on the defaults, which read the real shared account.
async function login({ postJson = defaultPostJson, now = Date.now, username = config.nexsDirectUsername, password = config.nexsDirectPassword } = {}) {
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    if (!username || !password) {
      const err = new Error("NEXS_DIRECT_USERNAME/NEXS_DIRECT_PASSWORD are not configured - the shared NexS login has no account to use");
      err.code = "NO_CREDENTIALS";
      throw err;
    }

    const { status, body } = await postJson(`${config.nexsOrigin}/v1/user/login`, {
      userName: username,
      password,
    });

    if (status !== 200 || !body || body.success !== true || !body.content) {
      const reason = (body && body.message) || `HTTP ${status}`;
      // NexS allows ONE active session per account. When something else
      // (a browser, Monitor Panel Revamped, or this app's own session from
      // before a restart - the cached token is in-memory only) holds it,
      // login is refused with "Multiple log in...". Say so plainly instead
      // of a generic failure.
      if (/multiple log ?in/i.test(String(reason))) {
        const err = new Error(
          "NexS login refused: the shared NexS account already has another active session (a browser, Monitor Panel Revamped, or this app's own session from before a restart). Log that session out in NexS, or give this app its own dedicated NexS account."
        );
        err.code = "MULTIPLE_SESSIONS";
        throw err;
      }
      const err = new Error(`NexS login failed: ${reason}`);
      err.code = "LOGIN_FAILED";
      throw err;
    }

    const token = body.content;
    const expiresAt = decodeJwtExpiryMs(token) || now() + 24 * 60 * 60 * 1000; // fall back to the captured 24h Max-Age if the JWT is ever unreadable
    shared = { token, expiresAt };
    return token;
  })();

  try {
    return await loginPromise;
  } finally {
    loginPromise = null;
  }
}

async function getValidToken(deps = {}) {
  const { now = Date.now } = deps;
  if (shared && shared.expiresAt - REFRESH_BUFFER_MS > now()) {
    return shared.token;
  }
  if (policy.requireLease && !deps.allowLogin && !leaseProbe()) throw notConnectedError();
  return login(deps);
}

// Explicit "connect now" (the Connect popup): logs in if there is no valid session.
async function connect(deps = {}) {
  return getValidToken({ ...deps, allowLogin: true });
}

// A valid session is cached right now (passive - never logs in).
function isConnected(now = Date.now) {
  return hasCachedSession(now);
}

// Passive read - true only if a still-valid session is ALREADY cached from
// a genuine prior use (Tote Purge/Outside Tote Analysis dispatching
// GET_NEXS_BLOCKED_INVENTORY_BATCH - see nexsBlockedInventoryBatchDirect.js).
// NEVER attempts a login itself. Exists specifically for the
// connection-status badge (2026-09-22, operator-requested: "nexs will stay
// stale, will be connected only when required") - NexS allows only one
// active session per account (unlike Grafana/Concinity's shared account,
// which tolerates many concurrent devices), so a badge that polls every
// 30s must not itself be a source of login attempts; it only ever reports
// whatever the last real, on-demand use left behind.
function hasCachedSession(now = Date.now) {
  return !!(shared && shared.expiresAt - REFRESH_BUFFER_MS > now());
}

// Runs fn(token) - the actual downstream NexS API call, which should send it
// as `Cookie: jwt-token=${token}` (see this file's own header comment). If fn
// throws an error tagged err.code === "UNAUTHORIZED" (the caller's own job:
// inspect the downstream response, e.g. a 401, and set this), the cached
// token is dropped and exactly ONE fresh login + retry is attempted - never a
// loop, mirroring concinityAuth.js's withAuth exactly.
async function withAuth(fn, deps = {}) {
  const token = await getValidToken(deps);
  if (activityHook) activityHook("start");
  try {
    return await fn(token);
  } catch (e) {
    if (e.code !== "UNAUTHORIZED") throw e;
    invalidate();
    // Re-login only while someone holds a lease (the session was valid a moment ago).
    if (policy.requireLease && !deps.allowLogin && !leaseProbe()) throw notConnectedError();
    const freshToken = await login(deps);
    return await fn(freshToken);
  } finally {
    if (activityHook) activityHook("end");
  }
}

// Ends this app's own NexS session (POST /v1/user/logout, the same call the
// NexS web portal makes) so a restart doesn't leave the account's single
// session orphaned and the next login refused. Best-effort: never throws,
// and does nothing if no session is cached.
async function logout({ postLogout = defaultPostLogout } = {}) {
  const session = shared;
  shared = null;
  if (!session) return false;
  try {
    await postLogout(`${config.nexsOrigin}/v1/user/logout`, session.token);
    return true;
  } catch (e) {
    return false;
  }
}

async function defaultPostLogout(url, token) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "X-Lenskart-App-Id": "nexs_search", "source-domain": new URL(url).origin, Cookie: `jwt-token=${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`NexS logout HTTP ${resp.status}`);
}

module.exports = { login, logout, connect, isConnected, getValidToken, invalidate, withAuth, reset, hasCachedSession, configure, setLeaseProbe, setActivityHook };
