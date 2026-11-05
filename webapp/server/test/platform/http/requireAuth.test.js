// Unit tests for server/platform/http/requireAuth.js - the single insertion
// point STRICT LOCAL DEVELOPMENT AUTH MODE uses. No real database, no
// network, no Quadron/capability code anywhere in this file - config and
// sessions are fully injected fakes via createRequireAuth().

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRequireAuth, LOCAL_DEV_USER_ID } = require("../../../platform/http/requireAuth");

function fakeReq(cookieHeader) {
  return { headers: { cookie: cookieHeader } };
}
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

function makeFakeSessions({ getUserForTokenImpl } = {}) {
  const calls = [];
  return {
    calls,
    COOKIE_NAME: "aso_session",
    parseCookies: (header) => {
      const out = {};
      if (!header) return out;
      header.split(";").forEach((part) => {
        const idx = part.indexOf("=");
        if (idx === -1) return;
        out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
      });
      return out;
    },
    getUserForToken: async (token) => {
      calls.push(token);
      if (getUserForTokenImpl) return getUserForTokenImpl(token);
      return null;
    },
  };
}

// ── 1. Normal production authentication remains unchanged ───────────────

test("normal auth (localDevAuthEnabled=false): a valid session token resolves req.user from sessions.getUserForToken", async () => {
  const realUser = { id: 42, employeeId: "EMP001", role: "USER" };
  const sessions = makeFakeSessions({ getUserForTokenImpl: async (token) => (token === "good-token" ? realUser : null) });
  const requireAuth = createRequireAuth({ config: { localDevAuthEnabled: false }, sessions });

  const req = fakeReq("aso_session=good-token");
  const res = fakeRes();
  let nextCalledWith = "not-called";
  await requireAuth(req, res, (err) => { nextCalledWith = err; });

  assert.equal(nextCalledWith, undefined, "next() must be called with no error");
  assert.deepEqual(req.user, realUser);
  assert.equal(req.sessionToken, "good-token");
  assert.equal(req.isLocalDevSession, undefined, "must not be marked as a local-dev session");
  assert.deepEqual(sessions.calls, ["good-token"], "the real DB-backed lookup must actually run");
});

// ── 2. ASO_LOCAL_DEV=false behaves exactly as before ─────────────────────

test("ASO_LOCAL_DEV=false: a missing/invalid session is rejected with 401, exactly as before", async () => {
  const sessions = makeFakeSessions({ getUserForTokenImpl: async () => null });
  const requireAuth = createRequireAuth({ config: { localDevAuthEnabled: false }, sessions });

  const req = fakeReq(undefined);
  const res = fakeRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Not authenticated" });
  assert.equal(req.user, undefined);
});

// ── 3. ASO_LOCAL_DEV=true + NODE_ENV=development creates the dev session ─

test("ASO_LOCAL_DEV=true + NODE_ENV=development (config.localDevAuthEnabled=true): grants a fixed ADMIN identity without ever touching sessions/DB", async () => {
  const sessions = makeFakeSessions();
  const requireAuth = createRequireAuth({ config: { localDevAuthEnabled: true, seedAdminId: "Ashutosh" }, sessions });

  const req = fakeReq(undefined); // no cookie at all - must not matter
  const res = fakeRes();
  let nextCalledWith = "not-called";
  await requireAuth(req, res, (err) => { nextCalledWith = err; });

  assert.equal(nextCalledWith, undefined, "next() must be called with no error");
  assert.deepEqual(req.user, { id: LOCAL_DEV_USER_ID, employeeId: "Ashutosh", role: "ADMIN" });
  assert.equal(req.sessionToken, null);
  assert.equal(req.isLocalDevSession, true);
  assert.equal(sessions.calls.length, 0, "the DB-backed session lookup must NEVER run in this mode");
});

test("the dev identity reuses config.seedAdminId (the existing ADMIN identity/model), not a hardcoded name", async () => {
  const sessions = makeFakeSessions();
  const requireAuth = createRequireAuth({ config: { localDevAuthEnabled: true, seedAdminId: "SomeOtherAdminId" }, sessions });
  const req = fakeReq(undefined);
  const res = fakeRes();
  await requireAuth(req, res, () => {});
  assert.equal(req.user.employeeId, "SomeOtherAdminId");
  assert.equal(req.user.role, "ADMIN");
});

test("LOCAL_DEV_USER_ID is a negative sentinel - can never collide with a real MySQL AUTO_INCREMENT user id", () => {
  assert.ok(LOCAL_DEV_USER_ID < 0);
});

// ── 4. ASO_LOCAL_DEV=true + NODE_ENV=production refuses startup ─────────
// Covered in server/test/localDevGuard.test.js (assertLocalDevModeSafe) -
// that guard runs at config.js load time, before requireAuth is ever
// reached, which is exactly why config.localDevAuthEnabled can be trusted
// as already-safe by the time this middleware reads it.

// ── 5. No automatic bypass when MySQL merely times out ───────────────────

test("a MySQL timeout during the real (non-dev) session lookup propagates as an error - it is NEVER treated as authenticated", async () => {
  const timeoutError = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
  const sessions = makeFakeSessions({
    getUserForTokenImpl: async () => { throw timeoutError; },
  });
  const requireAuth = createRequireAuth({ config: { localDevAuthEnabled: false }, sessions });

  const req = fakeReq("aso_session=some-token");
  const res = fakeRes();
  let nextCalledWith = "not-called";
  await requireAuth(req, res, (err) => { nextCalledWith = err; });

  assert.equal(nextCalledWith, timeoutError, "the DB error must reach next(), not be swallowed into a bypass");
  assert.equal(req.user, undefined, "req.user must never be set when the DB call fails");
  assert.equal(res.statusCode, null, "no success response must be sent - the error handler owns this, not a fabricated 200");
});

test("a MySQL timeout NEVER activates the bypass even if it superficially resembles one - config.localDevAuthEnabled=false is authoritative regardless of WHY the DB call failed", async () => {
  // Distinct from the local-dev branch entirely - this proves the code
  // path structurally cannot reach the dev-identity assignment unless the
  // flag itself is true. Failing DB in ANY way, with the flag off, must
  // never result in req.isLocalDevSession or req.user being set.
  const sessions = makeFakeSessions({
    getUserForTokenImpl: async () => { throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }); },
  });
  const requireAuth = createRequireAuth({ config: { localDevAuthEnabled: false }, sessions });
  const req = fakeReq("aso_session=x");
  const res = fakeRes();
  let errSeen = null;
  await requireAuth(req, res, (err) => { errSeen = err; });
  assert.ok(errSeen);
  assert.equal(req.isLocalDevSession, undefined);
});

// ── 6. Protected routes recognize the development session ───────────────

test("the granted dev session has the exact shape every route already expects from req.user ({id, employeeId, role})", async () => {
  const requireAuth = createRequireAuth({ config: { localDevAuthEnabled: true, seedAdminId: "Ashutosh" }, sessions: makeFakeSessions() });
  const req = fakeReq(undefined);
  const res = fakeRes();
  await requireAuth(req, res, () => {});
  assert.deepEqual(Object.keys(req.user).sort(), ["employeeId", "id", "role"]);
  assert.equal(typeof req.user.id, "number");
  assert.equal(typeof req.user.employeeId, "string");
  assert.equal(req.user.role, "ADMIN");
});

// ── 7. No real Quadron mutation is possible via this file ────────────────
// requireAuth.js is pure identity/session middleware - it must have zero
// code path anywhere near capability dispatch, the pull engines, or the
// Quadron lock, so enabling local-dev auth cannot make PULL_QUADRON_TOTE
// any easier to reach.
const REQUIRES_PULL_OR_CAPABILITY_MODULE = /require\(\s*["'][^"']*(totePullEngine|autoEngine|quadronPull|capabilityManager|pullQuadronTote)["']\s*\)/;

test("requireAuth.js has no code path touching pull/capability-dispatch modules", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../../../platform/http/requireAuth.js"), "utf8");
  assert.doesNotMatch(src, REQUIRES_PULL_OR_CAPABILITY_MODULE);
});
