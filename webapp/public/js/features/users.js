// User management screen (admins only): create a user, delete a user. The list is read when the tab opens
// and after each change - users change rarely, so there is no live feed and no polling.
const Users = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const form = $("userForm");
  const body = $("usersBody");
  const countEl = $("usersCount");
  const newBoxes = $("newUserPanelBoxes");
  const newPicker = $("newUserPanels");
  let me = null;
  let users = [];
  let started = false;
  let panelList = []; // [{ key, label }] the server can grant

  const when = (iso) => Fmt.day(iso) || Fmt.nil;

  const labelOf = (key) => (panelList.find((p) => p.key === key) || { label: key }).label;
  function panelsSummary(u) {
    if (u.role === "ADMIN" || u.allPanels) return "All panels";
    if (!u.panels.length) return '<span class="dd-note">none</span>';
    return esc(u.panels.length + " of " + panelList.length + ": " + u.panels.map(labelOf).join(", "));
  }

  // Checkbox grid for a set of panel keys; returns { html, read() }.
  function boxesHtml(selected, idPrefix) {
    return panelList.map((p) => `<label><input type="checkbox" value="${esc(p.key)}" ${selected.includes(p.key) ? "checked" : ""}> ${esc(p.label)}</label>`).join("");
  }
  const readBoxes = (root) => [...root.querySelectorAll("input[type=checkbox]:checked")].map((i) => i.value);
  const setAll = (root, on) => root.querySelectorAll("input[type=checkbox]").forEach((i) => { i.checked = on; });

  function render() {
    countEl.textContent = users.length + (users.length === 1 ? " user" : " users");
    body.innerHTML = users.map((u) => `<tr>
      <td><b>${esc(u.employeeId)}</b>${u.employeeId === me ? ' <span class="chip">you</span>' : ""}</td>
      <td><span class="al-level ${u.role === "ADMIN" ? "global" : "normal"}">${esc(u.role)}</span></td>
      <td class="user-panels-summary">${panelsSummary(u)}</td>
      <td>${u.signedIn ? '<span class="status-pill status-COMPLETED">signed in</span>' : '<span class="dd-note">-</span>'}</td>
      <td>${esc(when(u.createdAt))}</td>
      <td class="user-actions">${u.role === "ADMIN" ? "" : `<button type="button" class="link" data-access="${u.id}">Access</button> `}<button type="button" class="link" data-reset="${u.id}" data-name="${esc(u.employeeId)}">Reset password</button>${u.employeeId === me ? "" : ` <button type="button" class="link danger" data-del="${u.id}" data-name="${esc(u.employeeId)}">Delete</button>`}</td>
    </tr>`).join("") || '<tr><td colspan="6" class="dd-empty">No users.</td></tr>';
  }

  async function load() {
    try {
      if (!panelList.length) { panelList = await Api.get("/users/panels"); newBoxes.innerHTML = boxesHtml(panelList.map((p) => p.key)); }
      users = await Api.get("/users");
      render();
    } catch (e) {
      body.innerHTML = `<tr><td colspan="6" class="dd-empty">Couldn't load users: ${esc(e.message)}</td></tr>`;
    }
  }

  // Per-user panel access, edited in a popup.
  function openAccess(id) {
    const u = users.find((x) => String(x.id) === String(id));
    if (!u) return;
    const modal = Modal.open({ title: "Panel access", subtitle: u.employeeId, icon: "lock" });
    modal.body.innerHTML = `<div class="dd"><p class="dd-note">Tick the panels ${esc(u.employeeId)} can open. The change applies on their next click - no need to log in again.</p>
      <fieldset class="panel-picker"><div class="pp-actions"><button type="button" class="link" data-pp="all">All</button><button type="button" class="link" data-pp="none">None</button></div><div class="pp-grid">${boxesHtml(u.panels)}</div></fieldset>
      <div class="al-remark-row"><button type="button" class="primary" data-save>Save access</button><button type="button" class="link" data-no>Cancel</button></div></div>`;
    const grid = modal.body.querySelector(".pp-grid");
    modal.body.querySelectorAll("[data-pp]").forEach((b) => b.addEventListener("click", () => setAll(grid, b.dataset.pp === "all")));
    modal.body.querySelector("[data-no]").addEventListener("click", () => Modal.close());
    modal.body.querySelector("[data-save]").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        await Api.put("/users/" + id + "/panels", { panels: readBoxes(grid) });
        Modal.close();
        Toast.show({ title: "Access saved", message: u.employeeId, tone: "ok", ms: 2200 });
        await load();
      } catch (err) {
        e.target.disabled = false;
        Toast.show({ title: "Couldn't save access", message: err.message, tone: "danger" });
      }
    });
  }

  // Reset password: a small in-app form; the password goes to the server once and is never shown or kept

  function openReset(id, name) {
    const modal = Modal.open({ title: "Reset password", subtitle: name, icon: "lock", size: "sm" });
    modal.body.innerHTML = `<div class="dd"><form class="user-form" autocomplete="off">
      <label>New password<input name="password" type="password" required minlength="8" maxlength="128" autocomplete="new-password" placeholder="min 8 characters"></label>
      <p class="dd-note">${esc(name)} is signed out everywhere and must use the new password.</p>
      <div class="al-remark-row"><button type="submit" class="primary">Set password</button><button type="button" class="link" data-no>Cancel</button></div></form></div>`;
    const f = modal.body.querySelector("form");
    f.password.focus();
    modal.body.querySelector("[data-no]").addEventListener("click", () => Modal.close());
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await Api.put("/users/" + id + "/password", { password: f.password.value });
        Modal.close();
        Toast.show({ title: "Password reset", message: name, tone: "ok", ms: 2400 });
        await load();
      } catch (err) {
        btn.disabled = false;
        Toast.show({ title: "Couldn't reset the password", message: err.message, tone: "danger" });
      }
    });
  }

  // Deleting asks first, in the app's own modal (never a browser dialog).
  function confirmDelete(id, name) {
    const modal = Modal.open({ title: "Delete user", subtitle: name, icon: "alert", size: "sm" });
    modal.body.innerHTML = `<div class="dd">
      <p>Delete <b>${esc(name)}</b>? They are signed out immediately and can no longer log in. Their past activity stays in the logs.</p>
      <div class="al-remark-row"><button type="button" class="primary danger" data-yes>Delete user</button><button type="button" class="link" data-no>Cancel</button></div></div>`;
    modal.body.querySelector("[data-no]").addEventListener("click", () => Modal.close());
    modal.body.querySelector("[data-yes]").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        await Api.del("/users/" + id);
        Modal.close();
        Toast.show({ title: "User deleted", message: name, tone: "ok", ms: 2200 });
        await load();
      } catch (err) {
        e.target.disabled = false;
        Toast.show({ title: "Couldn't delete", message: err.message, tone: "danger" });
      }
    });
  }

  function wire() {
    form.role.addEventListener("change", () => newPicker.classList.toggle("off", form.role.value === "ADMIN"));
    newPicker.querySelectorAll("[data-pp]").forEach((b) => b.addEventListener("click", () => setAll(newBoxes, b.dataset.pp === "all")));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = form.querySelector("button[type=submit]");
      const employeeId = form.employeeId.value.trim();
      btn.disabled = true;
      try {
        const role = form.role.value;
        const r = await Api.post("/users", { employeeId, password: form.password.value, role, panels: role === "ADMIN" ? null : readBoxes(newBoxes) });
        Toast.show({ title: r.reactivated ? "User re-added" : "User created", message: employeeId + " (" + r.role + ")", tone: "ok", ms: 2400 });
        form.reset();
        setAll(newBoxes, true);
        newPicker.classList.remove("off");
        await load();
      } catch (err) {
        Toast.show({ title: "Couldn't create the user", message: err.message, tone: "danger" });
      } finally {
        btn.disabled = false;
      }
    });
    body.addEventListener("click", (e) => {
      const b = e.target.closest("[data-del]");
      if (b) return confirmDelete(b.dataset.del, b.dataset.name);
      const a = e.target.closest("[data-access]");
      if (a) return openAccess(a.dataset.access);
      const r = e.target.closest("[data-reset]");
      if (r) openReset(r.dataset.reset, r.dataset.name);
    });
  }

  function start() {
    if (!started) { started = true; wire(); }
    me = window.currentUserId ? window.currentUserId() : null;
    load();
  }
  function stop() { /* nothing live to release */ }

  return { start, stop };
})();
