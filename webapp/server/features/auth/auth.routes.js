const express = require("express");
const db = require("../../platform/db");
const { verifyPassword } = require("../../platform/session/passwords");
const sessions = require("../../platform/session/sessions");
const loginThrottle = require("../../platform/session/loginThrottle");
const auditLog = require("../../platform/audit/auditLog");
const requireAuth = require("../../platform/http/requireAuth");
const asyncHandler = require("../../platform/http/asyncHandler");
const outbox = require("../../platform/audit/outbox");
const syncMeta = require("../../platform/audit/syncMeta");
const { effectivePanels, parseStored } = require("../../platform/domain/panels");

const router = express.Router();

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { employeeId, password } = req.body || {};
    if (typeof employeeId !== "string" || typeof password !== "string" || !employeeId || !password) {
      return res.status(400).json({ error: "employeeId and password are required" });
    }

    // too many wrong passwords for this ID (or from this address): refuse before even checking the password
    const address = req.socket && req.socket.remoteAddress;
    const waitMs = loginThrottle.blockedFor(employeeId, address);
    if (waitMs > 0) {
      const minutes = Math.ceil(waitMs / 60000);
      res.set("Retry-After", String(Math.ceil(waitMs / 1000)));
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` });
    }

    const rows = await db.query("SELECT * FROM users WHERE employee_id = ? AND deleted_at IS NULL", [employeeId.trim()]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      loginThrottle.fail(employeeId, address);
      await auditLog.record(user ? user.id : null, "LOGIN_FAILED", { employeeId });
      return res.status(401).json({ error: "Invalid employee ID or password" });
    }
    loginThrottle.succeed(employeeId);

    const { token, expiresAt } = await sessions.createSession(user);
    sessions.setSessionCookie(res, token, expiresAt);
    await auditLog.record(user.id, "LOGIN", { employeeId });

    res.json({ employeeId: user.employee_id, role: user.role, panels: effectivePanels({ role: user.role, panels: parseStored(user.panels) }) });
  })
);

router.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    // STRICT LOCAL DEVELOPMENT AUTH MODE: req.sessionToken is null and
    // req.user has no real row - there is nothing DB-backed to destroy or
    // audit-log, and doing so would require MySQL, which this mode exists
    // precisely because it may be unreachable. Only this one conditional
    // changes; normal (ASO_LOCAL_DEV=false) logout behavior below is
    // untouched.
    if (req.isLocalDevSession) {
      sessions.clearSessionCookie(res);
      return res.json({ ok: true });
    }
    await sessions.destroySession(req.sessionToken);
    sessions.clearSessionCookie(res);
    await auditLog.record(req.user.id, "LOGOUT", {});
    res.json({ ok: true });
  })
);

router.get("/me", requireAuth, (req, res) => {
  // localDev is purely a REFLECTION of server-side state (req.isLocalDevSession,
  // set only inside requireAuth's STRICT LOCAL DEVELOPMENT AUTH MODE branch) -
  // there is no request input, cookie, or client-controlled value that can
  // set it. The frontend uses this only to render a non-interactive "LOCAL
  // DEV" indicator (see app.js) - never a switch, never something a user
  // can toggle.
  //
  // Local-First Phase 1: pendingSyncCount/lastSyncAt piggyback on this same
  // response (read-only local-store data - never a new route) so the
  // existing LOCAL DEV badge can also show outbox status, per the Phase 1
  // report's UI requirement. Both are omitted entirely outside a local-dev
  // session so the response shape for every other user is unchanged.
  const body = { employeeId: req.user.employeeId, role: req.user.role, panels: effectivePanels(req.user), localDev: !!req.isLocalDevSession };
  if (req.isLocalDevSession) {
    body.pendingSyncCount = outbox.list({ status: "PENDING" }).length;
    body.lastSyncAt = syncMeta.get().lastSyncAt;
  }
  res.json(body);
});

module.exports = router;
