// Large dialog (about 80% of the screen) for drill-downs.
//   const m = Modal.open({ title: "CC Done", subtitle: "Today since 06:00 IST", onClose() {} });
//   m.body.innerHTML = "...";   m.setLive(true);   m.close();
// ESC, the backdrop and the X all close it; focus returns to whatever opened it.
// Only one modal is open at a time (opening another replaces the first).
const Modal = (() => {
  let current = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function close() {
    if (!current) return;
    const { root, opener, onClose, keyHandler } = current;
    current = null;
    document.removeEventListener("keydown", keyHandler, true);
    root.classList.add("closing");
    document.body.classList.remove("modal-open");
    setTimeout(() => root.remove(), 220);
    try { if (onClose) onClose(); } catch (e) { console.warn("[modal] onClose error:", e.message); }
    if (opener && typeof opener.focus === "function") opener.focus();
  }

  // size: "sm" for a compact dialog (e.g. the NexS connect popup); default is the large drill-down.
  function open({ title = "", subtitle = "", icon = null, size = "", onClose = null } = {}) {
    if (current) close();
    const opener = document.activeElement;
    const root = document.createElement("div");
    root.className = "modal-root";
    root.innerHTML = `
      <div class="modal-backdrop" data-close></div>
      <section class="modal-card${size ? " " + size : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <header class="modal-head">
          ${icon ? `<span class="h-ico"><i class="ico" data-i="${esc(icon)}"></i></span>` : ""}
          <div class="modal-titles">
            <h2 class="modal-title">${esc(title)}</h2>
            <div class="modal-sub">${esc(subtitle)}</div>
          </div>
          <span class="modal-live live-pill live-idle" hidden><span class="live-dot"></span><span class="modal-live-label">LIVE</span></span>
          <button type="button" class="modal-x" data-close aria-label="Close">&times;</button>
        </header>
        <div class="modal-body"><div class="modal-loading"><span class="spinner"></span>Loading&hellip;</div></div>
      </section>`;
    document.body.appendChild(root);
    document.body.classList.add("modal-open");

    const keyHandler = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (e.key !== "Tab") return;
      const items = [...root.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((el) => !el.disabled && el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyHandler, true);
    root.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });

    current = { root, opener, onClose, keyHandler };
    const card = root.querySelector(".modal-card");
    card.querySelector(".modal-x").focus();

    return {
      root,
      body: root.querySelector(".modal-body"),
      close,
      setTitle(t, s) {
        root.querySelector(".modal-title").textContent = t;
        if (s != null) root.querySelector(".modal-sub").textContent = s;
      },
      // state: "live" | "reconnecting" | "paused" | falsy (hidden)
      setLive(state, text) {
        const pill = root.querySelector(".modal-live");
        pill.hidden = !state;
        pill.className = `modal-live live-pill live-${state || "idle"}`;
        pill.querySelector(".modal-live-label").textContent = text || (state === "live" ? "LIVE" : String(state || "").toUpperCase());
      },
      isOpen: () => !!current && current.root === root,
    };
  }

  return { open, close };
})();
