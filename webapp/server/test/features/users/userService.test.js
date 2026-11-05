const test = require("node:test");
const assert = require("node:assert/strict");
const { createService } = require("../../../features/users/userService");
const { verifyPassword } = require("../../../platform/session/passwords");

function fakeStore(users = []) {
  const rows = users.map((u, i) => ({ id: i + 1, employee_id: u.employeeId, role: u.role, deleted_at: u.deleted ? "x" : null, hash: null }));
  let next = rows.length + 1;
  return {
    rows,
    async findByEmployeeId(e) { return rows.find((r) => r.employee_id === e) || null; },
    async findActiveById(id) { const r = rows.find((x) => x.id === id && !x.deleted_at); return r ? { id: r.id, employeeId: r.employee_id, role: r.role } : null; },
    async create({ employeeId, passwordHash, role }) { rows.push({ id: next, employee_id: employeeId, role, deleted_at: null, hash: passwordHash }); return next++; },
    async reactivate(id, { passwordHash, role }) { const r = rows.find((x) => x.id === id); Object.assign(r, { hash: passwordHash, role, deleted_at: null }); },
    async countActiveAdmins() { return rows.filter((r) => r.role === "ADMIN" && !r.deleted_at).length; },
    async softDelete(id) { rows.find((r) => r.id === id).deleted_at = "now"; },
  };
}

test("create: validates id, password length and role", async () => {
  const s = createService({ store: fakeStore() });
  assert.equal((await s.createUser({ employeeId: "ab", password: "longenough", role: "USER" })).code, 400);
  assert.equal((await s.createUser({ employeeId: "bad id!", password: "longenough", role: "USER" })).code, 400);
  assert.equal((await s.createUser({ employeeId: "emp001", password: "short", role: "USER" })).code, 400);
  assert.equal((await s.createUser({ employeeId: "emp001", password: "longenough", role: "ROOT" })).code, 400);
});

test("create: stores a hash (never the password) and refuses a duplicate id", async () => {
  const store = fakeStore();
  const s = createService({ store });
  const r = await s.createUser({ employeeId: " emp001 ", password: "longenough", role: "USER" });
  assert.equal(r.ok, true);
  assert.equal(r.employeeId, "emp001");
  assert.notEqual(store.rows[0].hash, "longenough");
  assert.equal(verifyPassword("longenough", store.rows[0].hash), true);
  assert.equal((await s.createUser({ employeeId: "emp001", password: "longenough", role: "USER" })).code, 409);
});

test("create: a deleted employee id is re-added (reactivated) with the new password and role", async () => {
  const store = fakeStore([{ employeeId: "emp001", role: "USER", deleted: true }]);
  const s = createService({ store });
  const r = await s.createUser({ employeeId: "emp001", password: "newpassword", role: "ADMIN" });
  assert.deepEqual([r.ok, r.reactivated], [true, true]);
  assert.equal(store.rows[0].deleted_at, null);
  assert.equal(store.rows[0].role, "ADMIN");
});

test("delete: removes a user, but never yourself, an unknown id, or the last admin", async () => {
  const store = fakeStore([{ employeeId: "boss", role: "ADMIN" }, { employeeId: "emp001", role: "USER" }]);
  const s = createService({ store });
  assert.equal((await s.deleteUser({ targetId: 1, actor: { id: 1 } })).code, 400, "not yourself");
  assert.equal((await s.deleteUser({ targetId: 99, actor: { id: 1 } })).code, 404);
  assert.equal((await s.deleteUser({ targetId: 1, actor: { id: 2 } })).error, "You can't delete the last admin");
  assert.equal((await s.deleteUser({ targetId: 2, actor: { id: 1 } })).ok, true);
  assert.equal(store.rows[1].deleted_at, "now");
});

test("delete: an admin can be deleted when another admin remains", async () => {
  const store = fakeStore([{ employeeId: "a", role: "ADMIN" }, { employeeId: "b", role: "ADMIN" }]);
  assert.equal((await createService({ store }).deleteUser({ targetId: 2, actor: { id: 1 } })).ok, true);
});

test("reset password: stores a new hash, signs the person out, validates length, 404 for unknown", async () => {
  const store = fakeStore([{ employeeId: "boss", role: "ADMIN" }, { employeeId: "emp001", role: "USER" }]);
  const calls = [];
  store.setPassword = async (id, hash) => calls.push(["set", id, hash]);
  store.endSessions = async (id) => calls.push(["end", id]);
  const s = createService({ store });
  assert.equal((await s.resetPassword({ targetId: 2, password: "short", actor: { id: 1 } })).code, 400);
  assert.equal((await s.resetPassword({ targetId: 99, password: "longenough", actor: { id: 1 } })).code, 404);
  const r = await s.resetPassword({ targetId: 2, password: "longenough", actor: { id: 1 } });
  assert.deepEqual([r.ok, r.signedOut], [true, true]);
  assert.equal(calls[0][0], "set");
  assert.equal(verifyPassword("longenough", calls[0][2]), true);
  assert.deepEqual(calls[1], ["end", 2]);
});

test("reset password: an admin resetting their OWN password keeps their current session", async () => {
  const store = fakeStore([{ employeeId: "boss", role: "ADMIN" }]);
  const calls = [];
  store.setPassword = async () => calls.push("set");
  store.endSessions = async () => calls.push("end");
  const r = await createService({ store }).resetPassword({ targetId: 1, password: "longenough", actor: { id: 1 } });
  assert.deepEqual([r.ok, r.signedOut, calls], [true, false, ["set"]]);
});

test("panels: a restricted list is stored, a full list means 'all', empty / unknown are refused, admins ignore it", async () => {
  const stored = [];
  const store = fakeStore();
  store.create = async (a) => { stored.push(a); return stored.length; };
  const s = createService({ store });
  const base = { employeeId: "emp001", password: "longenough" };
  assert.equal((await s.createUser({ ...base, role: "USER", panels: ["alerts", "dashboard"] })).ok, true);
  assert.deepEqual(stored[0].panels, ["dashboard", "alerts"]);
  assert.equal((await s.createUser({ ...base, employeeId: "emp002", role: "USER", panels: [] })).code, 400);
  assert.equal((await s.createUser({ ...base, employeeId: "emp003", role: "USER", panels: ["nope"] })).code, 400);
  const { ALL_KEYS } = require("../../../platform/domain/panels");
  await s.createUser({ ...base, employeeId: "emp004", role: "USER", panels: ALL_KEYS });
  assert.equal(stored[1].panels, null, "everything ticked = unrestricted");
  await s.createUser({ ...base, employeeId: "emp005", role: "ADMIN", panels: ["alerts"] });
  assert.equal(stored[2].panels, null);
});

test("setPanels: changes a user's panels; refuses admins, unknown users, empty lists", async () => {
  const store = fakeStore([{ employeeId: "boss", role: "ADMIN" }, { employeeId: "emp001", role: "USER" }]);
  const set = [];
  store.setPanels = async (id, p) => set.push([id, p]);
  const s = createService({ store });
  assert.equal((await s.setPanels({ targetId: 1, panels: ["alerts"] })).code, 400);
  assert.equal((await s.setPanels({ targetId: 99, panels: ["alerts"] })).code, 404);
  assert.equal((await s.setPanels({ targetId: 2, panels: [] })).code, 400);
  assert.equal((await s.setPanels({ targetId: 2, panels: ["alerts"] })).ok, true);
  assert.deepEqual(set, [[2, ["alerts"]]]);
});
