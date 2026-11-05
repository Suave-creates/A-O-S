// MySQL persistence for user management. A "delete" is a soft delete (deleted_at) so the user's query and
// audit history keeps its owner; a deleted user cannot sign in and has no sessions.

const defaultDb = require("../../platform/db");
const { effectivePanels, parseStored } = require("../../platform/domain/panels");

// panels: null = every panel; array = exactly those. Stored as JSON text (NULL for "all").
const storePanels = (panels) => (panels == null ? null : JSON.stringify(panels));

function createStore({ db = defaultDb, now = () => new Date().toISOString() } = {}) {
  const toUser = (r) => {
    const panels = parseStored(r.panels);
    return { id: Number(r.id), employeeId: r.employee_id, role: r.role, createdAt: r.created_at, signedIn: !!Number(r.signed_in || 0), panels: effectivePanels({ role: r.role, panels }), allPanels: r.role === "ADMIN" || panels == null };
  };

  async function listActive() {
    const rows = await db.query(
      `SELECT u.id, u.employee_id, u.role, u.created_at, u.panels,
              EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS signed_in
         FROM users u WHERE u.deleted_at IS NULL ORDER BY u.role = 'ADMIN' DESC, u.employee_id ASC`,
      [now()]
    );
    return rows.map(toUser);
  }

  // Any row (active or deleted) for an employee id.
  async function findByEmployeeId(employeeId) {
    const rows = await db.query("SELECT id, employee_id, role, created_at, deleted_at FROM users WHERE employee_id = ? LIMIT 1", [employeeId]);
    return rows[0] || null;
  }

  async function findActiveById(id) {
    const rows = await db.query("SELECT id, employee_id, role, created_at, panels FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1", [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async function create({ employeeId, passwordHash, role, panels = null }) {
    const res = await db.execute("INSERT INTO users (employee_id, password_hash, role, panels, created_at) VALUES (?, ?, ?, ?, ?)", [employeeId, passwordHash, role, storePanels(panels), now()]);
    return res.insertId;
  }

  // Re-adding a previously deleted employee id: the row comes back with the new password and role.
  async function reactivate(id, { passwordHash, role, panels = null }) {
    await db.execute("UPDATE users SET password_hash = ?, role = ?, panels = ?, deleted_at = NULL, created_at = ? WHERE id = ?", [passwordHash, role, storePanels(panels), now(), id]);
  }

  async function countActiveAdmins() {
    const rows = await db.query("SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN' AND deleted_at IS NULL");
    return Number(rows[0].n);
  }

  async function setPanels(id, panels) {
    await db.execute("UPDATE users SET panels = ? WHERE id = ? AND deleted_at IS NULL", [storePanels(panels), id]);
  }

  async function setPassword(id, passwordHash) {
    await db.execute("UPDATE users SET password_hash = ? WHERE id = ? AND deleted_at IS NULL", [passwordHash, id]);
  }

  async function endSessions(id) {
    await db.execute("DELETE FROM sessions WHERE user_id = ?", [id]);
  }

  async function softDelete(id) {
    await db.execute("DELETE FROM sessions WHERE user_id = ?", [id]); // signs them out everywhere, immediately
    await db.execute("UPDATE users SET deleted_at = ? WHERE id = ?", [now(), id]);
  }

  return { listActive, findByEmployeeId, findActiveById, create, reactivate, countActiveAdmins, setPanels, setPassword, endSessions, softDelete };
}

module.exports = createStore();
module.exports.createStore = createStore;
