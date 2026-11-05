// Unit tests for server/integrations/logins/nexsAuth.js. postJson/username/
// password are injected fakes - no real HTTPS call, no config/env needed.
// Response shape mirrors the real, live-captured NexS login response
// (2026-09-05) exactly. All credential/token VALUES below are fabricated
// test fixtures, not real ones.
//
// SHARED single-login (2026-09-22) - this module no longer keys anything by
// appUserId (there is exactly one NexS identity behind the whole app now,
// mirroring the Monitor Panel Revamped project's own NexS login), so these
// tests dropped every "different users are cached independently"-style case
// from the old per-user design and instead cover the single shared cache.

const test = require("node:test");
const assert = require("node:assert/strict");
const nexsAuth = require("../../../integrations/logins/nexsAuth");

// The login mechanics below are tested with the on-demand gate OFF; the gate itself
// ("connect on demand") has its own tests at the bottom of this file.
test.beforeEach(() => {
  nexsAuth.reset();
  nexsAuth.configure({ requireLease: false });
});

const CRED = { username: "000000", password: "test-pass" };

// Builds a syntactically-real (unsigned) JWT with the given exp (seconds
// since epoch) in its payload, matching how the real NexS token is shaped.
function fakeJwt(exp) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, user: "{}" })).toString("base64url");
  return `${header}.${payload}.fakesignature`;
}

function fakeLoginSuccess({ token = fakeJwt(Math.floor(Date.now() / 1000) + 86400) } = {}) {
  return async (url, body) => ({
    status: 200,
    body: { success: true, message: "User logged in successfully", content: token },
  });
}

test("login(): on success, caches and returns the token from body.content", async () => {
  const token = fakeJwt(Math.floor(Date.now() / 1000) + 86400);
  const result = await nexsAuth.login({ postJson: fakeLoginSuccess({ token }), ...CRED });
  assert.equal(result, token);
});

test("login(): sends the shared username/password as {userName, password} to v1/user/login", async () => {
  let captured;
  const postJson = async (url, body) => {
    captured = { url, body };
    return fakeLoginSuccess()(url, body);
  };
  await nexsAuth.login({ postJson, username: "000000", password: "real-pass" });
  assert.ok(captured.url.endsWith("/v1/user/login"));
  assert.deepEqual(captured.body, { userName: "000000", password: "real-pass" });
});

test("login(): throws NO_CREDENTIALS when no shared account is configured, never attempts a login", async () => {
  let called = false;
  const postJson = async () => { called = true; return { status: 200, body: {} }; };
  await assert.rejects(
    nexsAuth.login({ postJson, username: null, password: null }),
    (e) => e.code === "NO_CREDENTIALS"
  );
  assert.equal(called, false);
});

test("login(): a success:false response (e.g. wrong password) throws LOGIN_FAILED with the server's own message", async () => {
  const postJson = async () => ({
    status: 401,
    body: { success: false, message: "Invalid credentials" },
  });
  await assert.rejects(
    nexsAuth.login({ postJson, ...CRED }),
    (e) => e.code === "LOGIN_FAILED" && /Invalid credentials/.test(e.message)
  );
});

test("getValidToken(): reuses the cached token when well within its JWT-encoded expiry", async () => {
  let loginCalls = 0;
  const postJson = async (...args) => { loginCalls++; return fakeLoginSuccess({ token: fakeJwt(2000000) })(...args); };
  const deps = { postJson, ...CRED, now: () => 1000 };
  await nexsAuth.getValidToken(deps);
  await nexsAuth.getValidToken(deps);
  await nexsAuth.getValidToken(deps);
  assert.equal(loginCalls, 1, "only the first call should have actually logged in");
});

test("getValidToken(): re-logs in once the cached token is within the refresh buffer of expiring", async () => {
  let loginCalls = 0;
  const expSeconds = 3600; // exp is in seconds since epoch, so expiresAt = 3600 * 1000 = 3600000ms
  const postJson = async (...args) => { loginCalls++; return fakeLoginSuccess({ token: fakeJwt(expSeconds) })(...args); };
  let now = 0;
  const deps = { postJson, ...CRED, now: () => now };

  await nexsAuth.getValidToken(deps); // logs in, expires at 3600000ms
  assert.equal(loginCalls, 1);

  now = 3600 * 1000 - (5 * 60 * 1000) + 1; // 1ms inside the 5-minute refresh buffer
  await nexsAuth.getValidToken(deps);
  assert.equal(loginCalls, 2, "must re-login once within the refresh buffer, not wait until actual expiry");
});

test("getValidToken(): concurrent callers share ONE in-flight login, not one each", async () => {
  let loginCalls = 0;
  const postJson = async (...args) => { loginCalls++; return fakeLoginSuccess()(...args); };
  const deps = { postJson, ...CRED, now: () => 1000 };
  const [a, b, c] = await Promise.all([nexsAuth.getValidToken(deps), nexsAuth.getValidToken(deps), nexsAuth.getValidToken(deps)]);
  assert.equal(loginCalls, 1, "three simultaneous callers must coalesce into a single real login");
  assert.equal(a, b);
  assert.equal(b, c);
});

test("withAuth(): passes the valid token through to fn and returns its result on success", async () => {
  const token = fakeJwt(Math.floor(Date.now() / 1000) + 86400);
  const result = await nexsAuth.withAuth(
    async (t) => `used:${t}`,
    { postJson: fakeLoginSuccess({ token }), ...CRED }
  );
  assert.equal(result, `used:${token}`);
});

test("withAuth(): on a downstream UNAUTHORIZED, invalidates the cache and retries exactly once with a fresh login", async () => {
  let loginCalls = 0;
  const postJson = async (...args) => {
    loginCalls++;
    return fakeLoginSuccess({ token: fakeJwt(Math.floor(Date.now() / 1000) + 86400 + loginCalls) })(...args);
  };
  const deps = { postJson, ...CRED };

  let fnCalls = 0;
  let firstToken;
  const result = await nexsAuth.withAuth(
    async (token) => {
      fnCalls++;
      if (fnCalls === 1) {
        firstToken = token;
        const err = new Error("downstream 401");
        err.code = "UNAUTHORIZED";
        throw err;
      }
      return token;
    },
    deps
  );

  assert.equal(loginCalls, 2, "initial login + exactly one re-login after the 401");
  assert.equal(fnCalls, 2);
  assert.notEqual(result, firstToken, "the retry must use the freshly re-logged-in token, not the stale cached one");
});

test("withAuth(): a downstream failure that is NOT tagged UNAUTHORIZED is never retried - propagates immediately", async () => {
  let fnCalls = 0;
  await assert.rejects(
    nexsAuth.withAuth(
      async () => {
        fnCalls++;
        throw new Error("some unrelated network error");
      },
      { postJson: fakeLoginSuccess(), ...CRED }
    ),
    /unrelated network error/
  );
  assert.equal(fnCalls, 1, "must never retry a non-auth failure");
});

test("withAuth(): a second consecutive UNAUTHORIZED fails loudly instead of looping", async () => {
  const postJson = fakeLoginSuccess();
  await assert.rejects(
    nexsAuth.withAuth(
      async () => {
        const err = new Error("still unauthorized");
        err.code = "UNAUTHORIZED";
        throw err;
      },
      { postJson, ...CRED }
    ),
    (e) => e.code === "UNAUTHORIZED"
  );
});

test("invalidate() forces the next getValidToken() call to log in again even if not yet expired", async () => {
  let loginCalls = 0;
  const postJson = async (...args) => { loginCalls++; return fakeLoginSuccess()(...args); };
  const deps = { postJson, ...CRED, now: () => 1000 };
  await nexsAuth.getValidToken(deps);
  nexsAuth.invalidate();
  await nexsAuth.getValidToken(deps);
  assert.equal(loginCalls, 2);
});

test("login(): falls back to a 24h expiry if the returned token is not a decodable JWT", async () => {
  const postJson = async () => ({ status: 200, body: { success: true, content: "not-a-jwt" } });
  const now = () => 5000;
  await nexsAuth.login({ postJson, ...CRED, now });
  // Cached and reused (well within the fallback 24h window), proving no crash and a sane expiry was set.
  let loginCalls = 0;
  const countingPostJson = async (...args) => { loginCalls++; return postJson(...args); };
  await nexsAuth.getValidToken({ postJson: countingPostJson, ...CRED, now });
  assert.equal(loginCalls, 0, "the fallback-expiry token should still be served from cache");
});

// hasCachedSession() - the connection-status badge's passive read (2026-09-22,
// operator-requested: NexS must never be logged into just to render a
// badge - it only reports whatever a genuine prior on-demand use left
// cached, via nexsAuth.js's own hasCachedSession()).
test("hasCachedSession(): false before any login has ever happened - never triggers one itself", async () => {
  assert.equal(nexsAuth.hasCachedSession(), false);
});

test("hasCachedSession(): true once a real login has cached a still-valid session", async () => {
  await nexsAuth.login({ postJson: fakeLoginSuccess({ token: fakeJwt(Math.floor(Date.now() / 1000) + 86400) }), ...CRED });
  assert.equal(nexsAuth.hasCachedSession(), true);
});

test("hasCachedSession(): false again once the cached session is within the refresh buffer of expiring", async () => {
  const expSeconds = 3600;
  await nexsAuth.login({ postJson: fakeLoginSuccess({ token: fakeJwt(expSeconds) }), ...CRED, now: () => 0 });
  const now = 3600 * 1000 - (5 * 60 * 1000) + 1; // 1ms inside the 5-minute refresh buffer
  assert.equal(nexsAuth.hasCachedSession(() => now), false);
});

test("hasCachedSession(): false again after invalidate()", async () => {
  await nexsAuth.login({ postJson: fakeLoginSuccess(), ...CRED });
  assert.equal(nexsAuth.hasCachedSession(), true);
  nexsAuth.invalidate();
  assert.equal(nexsAuth.hasCachedSession(), false);
});

test("login sends the NexS portal's app headers (without them NexS answers 400 Invalid app)", async () => {
  const nexsAuth = require("../../../integrations/logins/nexsAuth");
  nexsAuth.reset();
  const realFetch = global.fetch;
  let seen;
  global.fetch = async (url, opts) => {
    seen = opts.headers;
    return { status: 200, json: async () => ({ success: true, content: "a.b.c" }) };
  };
  try {
    await nexsAuth.login({ username: "u", password: "p" });
  } finally {
    global.fetch = realFetch;
    nexsAuth.reset();
  }
  assert.equal(seen["X-Lenskart-App-Id"], "nexs_search");
  assert.ok(seen["source-domain"].startsWith("https://"));
});

test("a 'Multiple log in' refusal throws MULTIPLE_SESSIONS with an actionable message", async () => {
  const nexsAuth = require("../../../integrations/logins/nexsAuth");
  nexsAuth.reset();
  const postJson = async () => ({ status: 200, body: { success: false, message: "Multiple log in, Please, log out from previous sessions or reset password" } });
  await assert.rejects(() => nexsAuth.login({ postJson, username: "u", password: "p" }), { code: "MULTIPLE_SESSIONS" });
  nexsAuth.reset();
});

test("logout posts the cached token once, clears the session, and never throws", async () => {
  const nexsAuth = require("../../../integrations/logins/nexsAuth");
  nexsAuth.reset();
  assert.equal(await nexsAuth.logout({ postLogout: async () => { throw new Error("must not be called"); } }), false, "no session -> no call");
  await nexsAuth.login({ postJson: async () => ({ status: 200, body: { success: true, content: "tok" } }), username: "u", password: "p" });
  assert.equal(nexsAuth.hasCachedSession(), true);
  let sent;
  assert.equal(await nexsAuth.logout({ postLogout: async (url, token) => { sent = { url, token }; } }), true);
  assert.equal(sent.token, "tok");
  assert.match(sent.url, /\/v1\/user\/logout$/);
  assert.equal(nexsAuth.hasCachedSession(), false);
  await nexsAuth.login({ postJson: async () => ({ status: 200, body: { success: true, content: "tok2" } }), username: "u", password: "p" });
  assert.equal(await nexsAuth.logout({ postLogout: async () => { throw new Error("network down"); } }), false);
  nexsAuth.reset();
});

// ── Connect on demand ────────────────────────────────────────────────────
const okLogin = (token = "tok") => async () => ({ status: 200, body: { success: true, content: token } });

test("on demand: with no lease, a NexS request fails NEXS_NOT_CONNECTED and never logs in", async () => {
  nexsAuth.reset(); // default policy: login only when asked or leased
  let logins = 0;
  const postJson = async () => { logins++; return { status: 200, body: { success: true, content: "t" } }; };
  await assert.rejects(() => nexsAuth.getValidToken({ postJson, username: "u", password: "p" }), { code: "NEXS_NOT_CONNECTED" });
  await assert.rejects(() => nexsAuth.withAuth(async () => 1, { postJson, username: "u", password: "p" }), { code: "NEXS_NOT_CONNECTED" });
  assert.equal(logins, 0);
});

test("on demand: connect() logs in explicitly; afterwards requests reuse the session without a lease", async () => {
  nexsAuth.reset();
  let logins = 0;
  const postJson = async () => { logins++; return okLogin()(); };
  await nexsAuth.connect({ postJson, username: "u", password: "p" });
  assert.equal(nexsAuth.isConnected(), true);
  assert.equal(await nexsAuth.getValidToken({ postJson, username: "u", password: "p" }), "tok");
  assert.equal(logins, 1);
});

test("on demand: an active lease allows a re-login (e.g. after a 401 mid-job); no lease means it does not", async () => {
  nexsAuth.reset();
  const postJson = okLogin();
  await nexsAuth.connect({ postJson, username: "u", password: "p" });
  let calls = 0;
  const fn = async () => { if (++calls === 1) { const e = new Error("401"); e.code = "UNAUTHORIZED"; throw e; } return "ok"; };
  // no lease: the session expiry mid-request must not silently re-login
  await assert.rejects(() => nexsAuth.withAuth(fn, { postJson, username: "u", password: "p" }), { code: "NEXS_NOT_CONNECTED" });
  // with a lease: it re-logs in once and retries
  await nexsAuth.connect({ postJson, username: "u", password: "p" });
  nexsAuth.setLeaseProbe(() => true);
  calls = 0;
  assert.equal(await nexsAuth.withAuth(fn, { postJson, username: "u", password: "p" }), "ok");
});

test("activity hook sees every authenticated request start and end (used to drop the session when idle)", async () => {
  nexsAuth.reset();
  const events = [];
  nexsAuth.setActivityHook((e) => events.push(e));
  await nexsAuth.connect({ postJson: okLogin(), username: "u", password: "p" });
  await nexsAuth.withAuth(async () => 1, {});
  await assert.rejects(() => nexsAuth.withAuth(async () => { throw new Error("x"); }, {}));
  assert.deepEqual(events, ["start", "end", "start", "end"]);
});
