const defaultSessions = require("../session/sessions");
const defaultConfig = require("../../config");

// The single, fixed identity STRICT LOCAL DEVELOPMENT AUTH MODE grants -
// never read from a request, a cookie, or anything client-controlled.
// id is a negative sentinel (MySQL AUTO_INCREMENT PKs never go below 1) so
// it can never collide with, or be mistaken for, a real user row. Because
// this identity has no real row in `users`, any endpoint that persists
// using req.user.id as a foreign key will still fail if MySQL happens to
// be reachable while this mode is on - that is intentional: this mode
// exists for when MySQL is UNREACHABLE, not to fabricate a working
// database-backed identity.
const LOCAL_DEV_USER_ID = -1;

// createRequireAuth() is the injection point for tests (see
// server/test/requireAuth.test.js) - production code uses the default
// export below, which is the real middleware wired to the real config/
// sessions modules. Every existing `router.use(requireAuth)` /
// `router.get(path, requireAuth, ...)` call site is unaffected: the
// default export is still directly callable as Express middleware.
function createRequireAuth({ config = defaultConfig, sessions = defaultSessions } = {}) {
  // Enforces authentication server-side. Every /api/v1 route except
  // /auth/login must pass through this - the frontend hiding a button is
  // not treated as access control.
  return async function requireAuth(req, res, next) {
    try {
      // STRICT LOCAL DEVELOPMENT AUTH MODE - see server/platform/session/localDevGuard.js
      // for the ASO_LOCAL_DEV+NODE_ENV=development gate this flag is
      // already the resolved output of. This branch NEVER queries MySQL,
      // NEVER reads a cookie, and NEVER activates for any reason other
      // than this one config flag being true - in particular, a MySQL
      // timeout/failure below does not fall through to here; that whole
      // branch simply does not exist unless the flag is already true
      // before this request even arrived.
      if (config.localDevAuthEnabled) {
        req.user = { id: LOCAL_DEV_USER_ID, employeeId: config.seedAdminId, role: "ADMIN" };
        req.sessionToken = null;
        req.isLocalDevSession = true;
        return next();
      }

      if (req.user && req.sessionToken) return next(); // already authenticated earlier in this request (a panel guard mounted ahead of the router)

      const cookies = sessions.parseCookies(req.headers.cookie);
      const token = cookies[sessions.COOKIE_NAME];
      const user = await sessions.getUserForToken(token);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }
      req.user = user;
      req.sessionToken = token;
      next();
    } catch (e) {
      // A MySQL failure here (e.g. the office DB is unreachable) propagates
      // as an error - it is never silently treated as "authenticated".
      next(e);
    }
  };
}

module.exports = createRequireAuth();
module.exports.createRequireAuth = createRequireAuth;
module.exports.LOCAL_DEV_USER_ID = LOCAL_DEV_USER_ID;
