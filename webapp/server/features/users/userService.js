// User management rules (pure of HTTP): who may be created / deleted. Routes call these and map
// { error, code } results to responses.

const { hashPassword } = require("../../platform/session/passwords");
const defaultStore = require("./userStore");
const { ALL_KEYS, normalizePanels } = require("../../platform/domain/panels");

const ID_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

const fail = (code, error) => ({ ok: false, code, error });

// What the form sent -> { ok, panels } where panels = null (every panel) or the chosen list.
// Admins always see every panel, so their list is not stored.
function resolvePanels(role, input) {
  if (role === "ADMIN" || input == null) return { ok: true, panels: null };
  if (!Array.isArray(input)) return { ok: false, error: "Panels must be a list" };
  const clean = normalizePanels(input);
  if (clean.length !== new Set(input).size) return { ok: false, error: "Unknown panel in the list" };
  if (clean.length === 0) return { ok: false, error: "Give the user at least one panel" };
  return { ok: true, panels: clean.length === ALL_KEYS.length ? null : clean };
}

function createService({ store = defaultStore } = {}) {
  async function createUser({ employeeId, password, role, panels }) {
    const id = String(employeeId || "").trim();
    if (!ID_PATTERN.test(id)) return fail(400, "Employee ID must be 3-64 characters: letters, numbers, dot, dash or underscore");
    const pw = String(password || "");
    if (pw.length < MIN_PASSWORD) return fail(400, `Password must be at least ${MIN_PASSWORD} characters`);
    if (pw.length > MAX_PASSWORD) return fail(400, `Password must be at most ${MAX_PASSWORD} characters`);
    if (role !== "USER" && role !== "ADMIN") return fail(400, "Role must be USER or ADMIN");

    const p = resolvePanels(role, panels);
    if (!p.ok) return fail(400, p.error);

    const passwordHash = hashPassword(pw);
    const existing = await store.findByEmployeeId(id);
    if (existing) {
      if (!existing.deleted_at) return fail(409, `Employee ID ${id} already exists`);
      await store.reactivate(existing.id, { passwordHash, role, panels: p.panels });
      return { ok: true, userId: existing.id, employeeId: id, role, reactivated: true };
    }
    const userId = await store.create({ employeeId: id, passwordHash, role, panels: p.panels });
    return { ok: true, userId, employeeId: id, role, reactivated: false };
  }

  // Changes which panels a user can open. Takes effect on their next request (no re-login needed).
  async function setPanels({ targetId, panels }) {
    const target = await store.findActiveById(targetId);
    if (!target) return fail(404, "User not found");
    if (target.role === "ADMIN") return fail(400, "Admins can open every panel");
    const p = resolvePanels("USER", panels);
    if (!p.ok) return fail(400, p.error);
    await store.setPanels(target.id, p.panels);
    return { ok: true, employeeId: target.employeeId, panels: p.panels == null ? ALL_KEYS : p.panels };
  }

  // Sets a new password. The person is signed out everywhere (so the old password's sessions die with it) -
  // except when an admin resets their own, which keeps the session they are using.
  async function resetPassword({ targetId, password, actor }) {
    const pw = String(password || "");
    if (pw.length < MIN_PASSWORD) return fail(400, `Password must be at least ${MIN_PASSWORD} characters`);
    if (pw.length > MAX_PASSWORD) return fail(400, `Password must be at most ${MAX_PASSWORD} characters`);
    const target = await store.findActiveById(targetId);
    if (!target) return fail(404, "User not found");
    await store.setPassword(target.id, hashPassword(pw));
    if (target.id !== actor.id) await store.endSessions(target.id);
    return { ok: true, employeeId: target.employeeId, signedOut: target.id !== actor.id };
  }

  async function deleteUser({ targetId, actor }) {
    const target = await store.findActiveById(targetId);
    if (!target) return fail(404, "User not found");
    if (target.id === actor.id) return fail(400, "You can't delete your own account");
    if (target.role === "ADMIN" && (await store.countActiveAdmins()) <= 1) return fail(400, "You can't delete the last admin");
    await store.softDelete(target.id);
    return { ok: true, employeeId: target.employeeId };
  }

  return { createUser, setPanels, resetPassword, deleteUser };
}

module.exports = createService();
module.exports.createService = createService;
module.exports.ID_PATTERN = ID_PATTERN;
