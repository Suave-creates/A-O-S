// User management (ADMIN only):
//   GET    /api/v1/users        active users (id, employee id, role, created, signed in now)
//   POST   /api/v1/users        { employeeId, password, role }   create (or re-add a deleted ID)
//   PUT    /api/v1/users/:id/panels    { panels: [keys] }   which screens the user can open (admins: all)
//   PUT    /api/v1/users/:id/password  { password }   reset - signs them out everywhere
//   DELETE /api/v1/users/:id    delete - signs them out; refuses yourself and the last admin
// Passwords are never returned. Every change is audit-logged.

const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const requireRole = require("../../platform/http/requireRole");
const asyncHandler = require("../../platform/http/asyncHandler");
const auditLog = require("../../platform/audit/auditLog");
const store = require("./userStore");
const service = require("./userService");
const { PANELS } = require("../../platform/domain/panels");

const router = express.Router();
router.use(requireAuth, requireRole("ADMIN"));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await store.listActive());
  })
);

// The panels an admin can hand out (the user form builds its checkboxes from this).
router.get("/panels", (req, res) => res.json(PANELS));

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const r = await service.createUser(req.body || {});
    if (!r.ok) return res.status(r.code).json({ error: r.error });
    await auditLog.record(req.user.id, "USER_CREATED", { employeeId: r.employeeId, role: r.role, reactivated: r.reactivated, panels: req.body.panels || "all" });
    res.status(201).json({ id: r.userId, employeeId: r.employeeId, role: r.role, reactivated: r.reactivated });
  })
);

router.put(
  "/:id/panels",
  asyncHandler(async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ error: "Invalid user id" });
    const r = await service.setPanels({ targetId, panels: req.body && req.body.panels });
    if (!r.ok) return res.status(r.code).json({ error: r.error });
    await auditLog.record(req.user.id, "USER_PANELS_CHANGED", { employeeId: r.employeeId, panels: r.panels });
    res.json({ ok: true, panels: r.panels });
  })
);

router.put(
  "/:id/password",
  asyncHandler(async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ error: "Invalid user id" });
    const r = await service.resetPassword({ targetId, password: req.body && req.body.password, actor: req.user });
    if (!r.ok) return res.status(r.code).json({ error: r.error });
    await auditLog.record(req.user.id, "USER_PASSWORD_RESET", { employeeId: r.employeeId }); // never the password
    res.json({ ok: true, signedOut: r.signedOut });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) return res.status(400).json({ error: "Invalid user id" });
    const r = await service.deleteUser({ targetId, actor: req.user });
    if (!r.ok) return res.status(r.code).json({ error: r.error });
    await auditLog.record(req.user.id, "USER_DELETED", { employeeId: r.employeeId });
    res.json({ ok: true });
  })
);

module.exports = router;
