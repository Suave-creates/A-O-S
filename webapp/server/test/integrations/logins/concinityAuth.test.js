// Unit tests for server/integrations/logins/concinityAuth.js. postJson/username/
// password are injected fakes - no real HTTPS call, no config/env needed.
// Response shape mirrors the real, live-captured Concinity login response
// (2026-09-05) exactly.
//
// SHARED single-login (2026-09-22) - this module no longer keys anything by
// appUserId (there is exactly one Concinity identity behind the whole app
// now), so these tests dropped every "different users are cached
// independently"-style case from the old per-user design and instead cover
// the single shared cache.

const test = require("node:test");
const assert = require("node:assert/strict");
const concinityAuth = require("../../../integrations/logins/concinityAuth");

test.beforeEach(() => concinityAuth.reset());

const CRED = { username: "FR1", password: "test-pass" };

function fakeLoginSuccess({ accessToken = "fake.jwt.token", tokenValidity = 2592000 } = {}) {
  return async (url, body) => ({
    status: 200,
    body: {
      meta: { status: "SUCCESS", messageCode: "200", messageDescription: "Successfully Authenticated" },
      data: { accessToken, tokenType: "Bearer", tokenValidity, userId: body.userId },
    },
  });
}

test("login(): on success, caches and returns the accessToken", async () => {
  const token = await concinityAuth.login({ postJson: fakeLoginSuccess(), ...CRED });
  assert.equal(token, "fake.jwt.token");
});

test("login(): sends the shared username/password as {userId, password} to base-sso/auth/login", async () => {
  let captured;
  const postJson = async (url, body) => {
    captured = { url, body };
    return fakeLoginSuccess()(url, body);
  };
  await concinityAuth.login({ postJson, username: "FR1", password: "real-pass" });
  assert.ok(captured.url.endsWith("/base-sso/auth/login"));
  assert.deepEqual(captured.body, { userId: "FR1", password: "real-pass" });
});

test("login(): throws NO_CREDENTIALS when no shared account is configured, never attempts a login", async () => {
  let called = false;
  const postJson = async () => { called = true; return { status: 200, body: {} }; };
  await assert.rejects(
    concinityAuth.login({ postJson, username: null, password: null }),
    (e) => e.code === "NO_CREDENTIALS"
  );
  assert.equal(called, false);
});

test("login(): a non-SUCCESS response (e.g. wrong password) throws LOGIN_FAILED with the server's own message", async () => {
  const postJson = async () => ({
    status: 401,
    body: { meta: { status: "FAILED", messageDescription: "Invalid credentials" } },
  });
  await assert.rejects(
    concinityAuth.login({ postJson, ...CRED }),
    (e) => e.code === "LOGIN_FAILED" && /Invalid credentials/.test(e.message)
  );
});

test("getValidToken(): reuses the cached token when well within its validity window", async () => {
  let loginCalls = 0;
  const postJson = async (...args) => { loginCalls++; return fakeLoginSuccess()(...args); };
  const deps = { postJson, ...CRED, now: () => 1000 };
  await concinityAuth.getValidToken(deps);
  await concinityAuth.getValidToken(deps);
  await concinityAuth.getValidToken(deps);
  assert.equal(loginCalls, 1, "only the first call should have actually logged in");
});

test("getValidToken(): re-logs in once the cached token is within the refresh buffer of expiring", async () => {
  let loginCalls = 0;
  const postJson = async (...args) => { loginCalls++; return fakeLoginSuccess({ tokenValidity: 3600 })(...args); }; // 1 hour validity
  let now = 0;
  const deps = { postJson, ...CRED, now: () => now };

  await concinityAuth.getValidToken(deps); // logs in, expires at now+3600000
  assert.equal(loginCalls, 1);

  now = 3600 * 1000 - (5 * 60 * 1000) + 1; // 1ms inside the 5-minute refresh buffer
  await concinityAuth.getValidToken(deps);
  assert.equal(loginCalls, 2, "must re-login once within the refresh buffer, not wait until actual expiry");
});

test("getValidToken(): concurrent callers share ONE in-flight login, not one each", async () => {
  let loginCalls = 0;
  const postJson = async (...args) => { loginCalls++; return fakeLoginSuccess()(...args); };
  const deps = { postJson, ...CRED, now: () => 1000 };
  const [a, b] = await Promise.all([concinityAuth.getValidToken(deps), concinityAuth.getValidToken(deps)]);
  assert.equal(loginCalls, 1, "two simultaneous callers must coalesce into a single real login");
  assert.equal(a, b);
});

test("withAuth(): passes the valid token through to fn and returns its result on success", async () => {
  const result = await concinityAuth.withAuth(
    async (token) => `used:${token}`,
    { postJson: fakeLoginSuccess(), ...CRED }
  );
  assert.equal(result, "used:fake.jwt.token");
});

test("withAuth(): on a downstream UNAUTHORIZED, invalidates the cache and retries exactly once with a fresh login", async () => {
  let loginCalls = 0;
  const postJson = async (...args) => { loginCalls++; return fakeLoginSuccess({ accessToken: `token-${loginCalls}` })(...args); };
  const deps = { postJson, ...CRED };

  let fnCalls = 0;
  const result = await concinityAuth.withAuth(
    async (token) => {
      fnCalls++;
      if (fnCalls === 1) {
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
  assert.equal(result, "token-2", "the retry must use the freshly re-logged-in token, not the stale cached one");
});

test("withAuth(): a downstream failure that is NOT tagged UNAUTHORIZED is never retried - propagates immediately", async () => {
  let fnCalls = 0;
  await assert.rejects(
    concinityAuth.withAuth(
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

test("withAuth(): a second consecutive UNAUTHORIZED (e.g. account genuinely locked) fails loudly instead of looping", async () => {
  const postJson = fakeLoginSuccess();
  await assert.rejects(
    concinityAuth.withAuth(
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
  await concinityAuth.getValidToken(deps);
  concinityAuth.invalidate();
  await concinityAuth.getValidToken(deps);
  assert.equal(loginCalls, 2);
});
