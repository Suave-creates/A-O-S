// Location Audit marks - what an auditor found at an empty (red) slot today: "Confirmed empty" or "Tote found".
// Companion to asrsLocations.js (which draws the grid and calls in here); this file owns the marks: the live
// topic "asrs-locations.marks" (this site day only, so everything resets at 06:00 IST), the click menu on a
// slot, and saving / clearing through POST /asrs-locations/audit-marks[/clear]. Marks are shared site data.
const AsrsAuditMarks = (() => {
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  let marks = new Map(); // slotKey -> { outcome, toteId, markedBy, markedAt }
  let off = null;
  let onChange = () => {};
  let menu = null;

  function apply(list) {
    marks = new Map((list || []).map((m) => [m.slotKey, m]));
    onChange();
  }

  function start(cb) {
    onChange = cb || onChange;
    if (off) return;
    off = Live.subscribe("asrs-locations.marks", (evt) => {
      if (evt.type === "data") apply(evt.data && evt.data.marks);
    });
  }
  function stop() {
    if (off) off();
    off = null;
    closeMenu();
  }

  const get = (slotKey) => marks.get(slotKey) || null;

  // Saves, then shows the result at once (the live topic confirms it a moment later, for everyone).
  async function save(slotKeys, outcome, toteId) {
    try {
      await Api.post("/asrs-locations/audit-marks", { slotKeys, outcome, toteId });
      // "you" until the live topic brings back the stored row (with the employee ID) a moment later
      slotKeys.forEach((k) => marks.set(k, { slotKey: k, outcome, toteId: outcome === "TOTE_FOUND" ? toteId || null : null, markedBy: "you", markedAt: new Date().toISOString() }));
      onChange();
      Live.refresh("asrs-locations.marks");
      return true;
    } catch (e) {
      Toast.show({ title: "Couldn't save the audit", message: e.message, tone: "warn" });
      return false;
    }
  }
  async function clear(slotKeys) {
    try {
      await Api.post("/asrs-locations/audit-marks/clear", { slotKeys });
      slotKeys.forEach((k) => marks.delete(k));
      onChange();
      Live.refresh("asrs-locations.marks");
      return true;
    } catch (e) {
      Toast.show({ title: "Couldn't clear the audit", message: e.message, tone: "warn" });
      return false;
    }
  }

  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
  }

  // The small menu shown where a red slot was clicked.
  function openMenu({ slotKey, location, x, y }) {
    closeMenu();
    const m = get(slotKey);
    menu = document.createElement("div");
    menu.className = "al-mark-menu";
    menu.innerHTML = `
      <div class="al-mark-loc">${esc(location)}</div>
      ${m ? `<div class="al-mark-now">${m.outcome === "TOTE_FOUND" ? "Tote found" : "Confirmed empty"}${m.toteId ? " · " + esc(m.toteId) : ""} · ${esc(m.markedBy || "")}</div>` : ""}
      <button type="button" data-act="EMPTY"><i class="al-swatch al-sw-audited"></i>Confirmed empty</button>
      <div class="al-mark-found">
        <input type="text" placeholder="Tote ID (optional)" maxlength="40" value="${esc(m && m.toteId)}" />
        <button type="button" data-act="TOTE_FOUND"><i class="al-swatch al-sw-found"></i>Tote found</button>
      </div>
      ${m ? '<button type="button" class="al-mark-clear" data-act="CLEAR">Clear mark</button>' : ""}`;
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x + 8, window.innerWidth - r.width - 8) + "px";
    menu.style.top = Math.min(y + 8, window.innerHeight - r.height - 8) + "px";
    const input = menu.querySelector("input");
    menu.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      const act = b.dataset.act;
      menu.querySelectorAll("button").forEach((x) => { x.disabled = true; });
      const ok = act === "CLEAR" ? await clear([slotKey]) : await save([slotKey], act, act === "TOTE_FOUND" ? input.value.trim() : null);
      if (ok) closeMenu();
      else if (menu) menu.querySelectorAll("button").forEach((x) => { x.disabled = false; });
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") menu.querySelector('[data-act="TOTE_FOUND"]').click(); });
  }

  // close on outside click / Escape / scroll
  document.addEventListener("mousedown", (e) => { if (menu && !menu.contains(e.target) && e.target.id !== "alCanvas") closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  return { start, stop, get, save, clear, openMenu, closeMenu };
})();
