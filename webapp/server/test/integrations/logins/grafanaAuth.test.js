// Unit tests for server/integrations/logins/grafanaAuth.js. postLogin/username/
// password are injected fakes - no real HTTPS call, no config/env needed.
// Response shape follows Grafana's own documented login API (see
// grafanaAuth.js's own header comment on why this one isn't a live capture).
//
// SHARED single-login (2026-09-22) - this module no longer keys anything by
// appUserId (there is exactly one Grafana identity behind the whole app
// now), so these tests dropped every "different users are cached
// independently"-style case from the old per-user design and instead cover
// the single shared cache.

const test = require("node:test");
const assert = require("node:assert/strict");
const grafanaAuth = require("../../../integrations/logins/grafanaAuth");

test.beforeEach(() => grafanaAuth.reset());

const CRED = { username: "viewer", password: "test-pass" };

function fakeLoginSuccess({ sessionCookie = "grafana_session=fake-session-value" } = {}) {
  return async (url, body) => ({ status: 200, body: { message: "Logged in" }, sessionCookie });
}

test("login(): on success, caches and returns the grafana_session cookie", async () => {
  const token = await grafanaAuth.login({ postLogin: fakeLoginSuccess(), ...CRED });
  assert.equal(token, "grafana_session=fake-session-value");
});

test("login(): sends the shared username/password as {user, password} to grafana/login", async () => {
  let captured;
  const postLogin = async (url, body) => {
    captured = { url, body };
    return fakeLoginSuccess()(url, body);
  };
  await grafanaAuth.login({ postLogin, username: "viewer", password: "real-pass" });
  assert.ok(captured.url.endsWith("/grafana/login"));
  assert.deepEqual(captured.body, { user: "viewer", password: "real-pass" });
});

test("login(): throws NO_CREDENTIALS when no shared account is configured, never attempts a login", async () => {
  let called = false;
  const postLogin = async () => { called = true; return { status: 200, body: {}, sessionCookie: "grafana_session=x" }; };
  await assert.rejects(
    grafanaAuth.login({ postLogin, username: null, password: null }),
    (e) => e.code === "NO_CREDENTIALS"
  );
  assert.equal(called, false);
});

test("login(): a non-200/no-cookie response (e.g. wrong password) throws LOGIN_FAILED with the server's own message", async () => {
  const postLogin = async () => ({
    status: 401,
    body: { message: "Invalid username or password" },
    sessionCookie: null,
  });
  await assert.rejects(
    grafanaAuth.login({ postLogin, ...CRED }),
    (e) => e.code === "LOGIN_FAILED" && /Invalid username or password/.test(e.message)
  );
});

test("getValidToken(): reuses the cached session cookie across calls without re-logging in", async () => {
  let loginCalls = 0;
  const postLogin = async (...args) => { loginCalls++; return fakeLoginSuccess()(...args); };
  const deps = { postLogin, ...CRED };
  await grafanaAuth.getValidToken(deps);
  await grafanaAuth.getValidToken(deps);
  await grafanaAuth.getValidToken(deps);
  assert.equal(loginCalls, 1, "only the first call should have actually logged in - no expiry tracking to force a re-login");
});

test("getValidToken(): concurrent callers share ONE in-flight login, not one each", async () => {
  let loginCalls = 0;
  const postLogin = async (...args) => { loginCalls++; return fakeLoginSuccess()(...args); };
  const deps = { postLogin, ...CRED };
  const [a, b] = await Promise.all([grafanaAuth.getValidToken(deps), grafanaAuth.getValidToken(deps)]);
  assert.equal(loginCalls, 1, "two simultaneous callers must coalesce into a single real login");
  assert.equal(a, b);
});

test("withAuth(): passes the valid session cookie through to fn and returns its result on success", async () => {
  const result = await grafanaAuth.withAuth(
    async (token) => `used:${token}`,
    { postLogin: fakeLoginSuccess(), ...CRED }
  );
  assert.equal(result, "used:grafana_session=fake-session-value");
});

test("withAuth(): on a downstream UNAUTHORIZED, invalidates the cache and retries exactly once with a fresh login", async () => {
  let loginCalls = 0;
  const postLogin = async (...args) => {
    loginCalls++;
    return fakeLoginSuccess({ sessionCookie: `grafana_session=session-${loginCalls}` })(...args);
  };
  const deps = { postLogin, ...CRED };

  let fnCalls = 0;
  const result = await grafanaAuth.withAuth(
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
  assert.equal(result, "grafana_session=session-2", "the retry must use the freshly re-logged-in session, not the stale cached one");
});

test("withAuth(): a downstream failure that is NOT tagged UNAUTHORIZED is never retried - propagates immediately", async () => {
  let fnCalls = 0;
  await assert.rejects(
    grafanaAuth.withAuth(
      async () => {
        fnCalls++;
        throw new Error("some unrelated network error");
      },
      { postLogin: fakeLoginSuccess(), ...CRED }
    ),
    /unrelated network error/
  );
  assert.equal(fnCalls, 1, "must never retry a non-auth failure");
});

test("withAuth(): a second consecutive UNAUTHORIZED fails loudly instead of looping", async () => {
  const postLogin = fakeLoginSuccess();
  await assert.rejects(
    grafanaAuth.withAuth(
      async () => {
        const err = new Error("still unauthorized");
        err.code = "UNAUTHORIZED";
        throw err;
      },
      { postLogin, ...CRED }
    ),
    (e) => e.code === "UNAUTHORIZED"
  );
});

test("invalidate() forces the next getValidToken() call to log in again", async () => {
  let loginCalls = 0;
  const postLogin = async (...args) => { loginCalls++; return fakeLoginSuccess()(...args); };
  const deps = { postLogin, ...CRED };
  await grafanaAuth.getValidToken(deps);
  grafanaAuth.invalidate();
  await grafanaAuth.getValidToken(deps);
  assert.equal(loginCalls, 2);
});
