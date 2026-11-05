// Direct-login pilot (2026-09-05, operator-approved) - Concinity/Quadron
// auth manager.
//
// SHARED single-login (2026-09-22, operator-requested: "single login point
// ... all logged in together" - ONE service account for every user, mirrors
// nexsAuth.js's own identical redesign). config.concinityDirectUsername/
// concinityDirectPassword (env-configured) is the one shared account,
// cached process-wide rather than per appUserId - this module no longer
// reads server_credentials at all.
//
// Logs in server-side instead of relaying through the ASO Browser Runtime,
// and caches the resulting accessToken in-memory (NOT persisted - process
// restart re-logs in, same as before) until it's within REFRESH_BUFFER_MS of
// its real 30-day expiry.
//
// Confirmed live response shape (captured directly from the real Concinity
// login, 2026-09-05):
//   POST {quadronOrigin}/base-sso/auth/login  {"userId","password"}
//   -> 200 {"meta":{"status":"SUCCESS",...},
//           "data":{"accessToken":"<jwt>","tokenType":"Bearer",
//                    "tokenValidity":2592000, "userId":"...", ...}}
// tokenValidity is in SECONDS (2592000 = 30 days).
//
// 192.168.24.230 uses a self-signed certificate (every real capture of it
// needed curl's --insecure) - confirmed with the operator before disabling
// verification here. Scoped to ONLY this module's own requests via a
// private https.Agent, never applied globally to other HTTPS traffic (e.g.
// NexS's public, properly-certified endpoint).

const https = require("node:https");
const config = require("../../config");

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // re-login 5 min before real expiry, never cut it exactly at the edge

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function defaultPostJson(url, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj);
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        agent: insecureAgent,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          Accept: "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            /* non-JSON response - parsed stays null, callers check for it */
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// The one shared token - { accessToken, expiresAt } | null. No longer keyed
// by appUserId: there is exactly one Concinity identity behind this whole
// app now.
let shared = null;
let loginPromise = null; // single-flight guard - concurrent callers await the SAME in-progress login rather than each starting their own

function reset() {
  shared = null;
  loginPromise = null;
}

function invalidate() {
  shared = null;
}

// username/password are injectable purely for deterministic testing (no
// real config/env needed to unit-test this module) - production callers
// always rely on the defaults, which read the real shared account.
async function login({ postJson = defaultPostJson, now = Date.now, username = config.concinityDirectUsername, password = config.concinityDirectPassword } = {}) {
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    if (!username || !password) {
      const err = new Error("CONCINITY_DIRECT_USERNAME/CONCINITY_DIRECT_PASSWORD are not configured - the shared Concinity login has no account to use");
      err.code = "NO_CREDENTIALS";
      throw err;
    }

    const { status, body } = await postJson(`${config.quadronOrigin}/base-sso/auth/login`, {
      userId: username,
      password,
    });

    if (status !== 200 || !body || body.meta?.status !== "SUCCESS" || !body.data?.accessToken) {
      const reason = (body && body.meta && body.meta.messageDescription) || `HTTP ${status}`;
      const err = new Error(`Concinity login failed: ${reason}`);
      err.code = "LOGIN_FAILED";
      throw err;
    }

    const accessToken = body.data.accessToken;
    const tokenValidityMs = (Number(body.data.tokenValidity) || 0) * 1000;
    const expiresAt = now() + tokenValidityMs;
    shared = { accessToken, expiresAt };
    return accessToken;
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
    return shared.accessToken;
  }
  return login(deps);
}

// Runs fn(accessToken) - the actual downstream Concinity/Quadron API call.
// If fn throws an error tagged err.code === "UNAUTHORIZED" (the caller's own
// job: inspect the downstream response, e.g. a 401, and set this), the
// cached token is dropped and exactly ONE fresh login + retry is attempted -
// never a loop, so a genuinely revoked/locked account (see the real
// response's own "attemptsLeft" field - this account is rate-limited) fails
// loudly on the second attempt instead of hammering the login endpoint.
async function withAuth(fn, deps = {}) {
  const token = await getValidToken(deps);
  try {
    return await fn(token);
  } catch (e) {
    if (e.code !== "UNAUTHORIZED") throw e;
    invalidate();
    const freshToken = await login(deps);
    return fn(freshToken);
  }
}

module.exports = { login, getValidToken, invalidate, withAuth, reset };
