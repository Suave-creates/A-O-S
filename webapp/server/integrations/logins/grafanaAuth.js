// Direct-login pilot (2026-09-05, operator-approved) - Grafana auth manager.
//
// SHARED single-login (2026-09-22, operator-requested: "single login point
// ... all logged in together" - ONE service account for every user, mirrors
// nexsAuth.js's own identical redesign). config.grafanaDirectUsername/
// grafanaDirectPassword (env-configured) is the one shared account, cached
// process-wide rather than per appUserId - this module no longer reads
// server_credentials at all.
//
// Logs in server-side instead of relaying through the ASO Browser Runtime,
// and caches the resulting grafana_session cookie in-memory (NOT persisted -
// process restart re-logs in, same as before).
//
// UNLIKE concinityAuth.js/nexsAuth.js, this module's request/response shape
// is NOT captured from a live login on this specific instance - the current
// browser session on 192.168.24.230/grafana/ was already authenticated, and
// logging it out to force a fresh capture was deliberately skipped (see the
// operator conversation, 2026-09-05) since this is confirmed-genuine, stock
// Grafana (verified: the real dashboard UI, "Public Slack"/Documentation
// links, all load normally) rather than a custom fork - its HTTP login API
// is Grafana's own stable, documented contract:
//   POST {grafanaOrigin}/grafana/login  {"user","password"}
//   -> 200 {"message":"Logged in",...} + Set-Cookie: grafana_session=<opaque>
//   -> 401 on bad credentials
// The /grafana/login path itself IS confirmed live - navigating there on
// this instance resolved to the real Grafana app (not a 404), matching
// config.js's own grafanaOrigin comment (reverse-proxied under /grafana/).
//
// This still needs a real login verified against THIS deployment before
// config.grafanaAuthMode is ever flipped away from "runtime" - see that
// config field's own comment.
//
// Deliberately NO expiry tracking (unlike concinityAuth's tokenValidity or
// nexsAuth's JWT `exp` claim): a Grafana session cookie's real lifetime is a
// server-side setting (grafana.ini's session config) this module has no way
// to read, so the cached cookie is treated as good until a downstream 401
// says otherwise - withAuth's existing single-retry-on-UNAUTHORIZED pattern
// (identical to concinityAuth.js/nexsAuth.js) already covers that case
// without needing to know the real session length up front.
//
// 192.168.24.230 uses a self-signed certificate (same host as Concinity/
// Quadron - see concinityAuth.js's own comment) - scoped to ONLY this
// module's own requests via a private https.Agent, never applied globally.

const https = require("node:https");
const config = require("../../config");

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function parseSessionCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    const match = /(?:^|,\s*)(grafana_session=[^;]+)/.exec(header);
    if (match) return match[1];
  }
  return null;
}

function defaultPostLogin(url, bodyObj) {
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
          resolve({ status: res.statusCode, body: parsed, sessionCookie: parseSessionCookie(res.headers["set-cookie"]) });
        });
      }
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// The one shared session - "grafana_session=<opaque>" | null. No longer
// keyed by appUserId: there is exactly one Grafana identity behind this
// whole app now.
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
async function login({ postLogin = defaultPostLogin, username = config.grafanaDirectUsername, password = config.grafanaDirectPassword } = {}) {
  if (loginPromise) return loginPromise;

  loginPromise = (async () => {
    if (!username || !password) {
      const err = new Error("GRAFANA_DIRECT_USERNAME/GRAFANA_DIRECT_PASSWORD are not configured - the shared Grafana login has no account to use");
      err.code = "NO_CREDENTIALS";
      throw err;
    }

    const { status, body, sessionCookie } = await postLogin(`${config.grafanaOrigin}/grafana/login`, {
      user: username,
      password,
    });

    if (status !== 200 || !sessionCookie) {
      const reason = (body && body.message) || `HTTP ${status}`;
      const err = new Error(`Grafana login failed: ${reason}`);
      err.code = "LOGIN_FAILED";
      throw err;
    }

    shared = sessionCookie;
    return sessionCookie;
  })();

  try {
    return await loginPromise;
  } finally {
    loginPromise = null;
  }
}

async function getValidToken(deps = {}) {
  if (shared) return shared;
  return login(deps);
}

// Runs fn(sessionCookie) - the actual downstream Grafana API call, which
// should send it as the `Cookie` header verbatim (it's already in
// "grafana_session=<value>" form). If fn throws an error tagged
// err.code === "UNAUTHORIZED" (the caller's own job: inspect the downstream
// response, e.g. a 401, and set this), the cached session is dropped and
// exactly ONE fresh login + retry is attempted - never a loop, mirroring
// concinityAuth.js/nexsAuth.js's withAuth exactly.
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
