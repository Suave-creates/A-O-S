// Alerts in the app shell: the alert popup for GLOBAL (high escalation) alerts (Acknowledge there closes it at once,
// no remark needed - a remark is optional, and saving one there also acknowledges and closes it),
// the open-count badge on the Alerts nav item, a sound when a new one arrives, and the shared alert state the Alerts
// page reads.
//
// One live subscription ("alerts") for the whole session - the server evaluates the rules while anyone
// has the app open, so this is what keeps alerting running. A GLOBAL alert stays in the popup until
// someone acknowledges it (shared: the first acknowledgement closes it for everyone). NORMAL alerts never
// appear here - they live on the Alerts page only.
const AlertsTray = (() => {
  const SOUND_KEY = "aso_alert_sound";
  const MIN_KEY = "aso_alert_min";
  const trayEl = () => document.getElementById("alertTray");
  const navBadge = () => document.getElementById("alertsNavBadge");

  let state = { alerts: [], rules: [], engine: { ok: true } };
  let started = false;
  let firstLoad = true;
  const seen = new Set();
  const listeners = new Set();
  const remarkOpen = new Set(); // alert ids whose remark box is open in the popup
  const drafts = new Map(); // alert id -> unsaved remark text (survives the popup's live re-renders)
  const baseTitle = document.title;

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function soundOn() {
    try { return localStorage.getItem(SOUND_KEY) !== "off"; } catch (e) { return true; }
  }
  // Minimised = just the bell and the count, so the panel never covers the screen. A NEW alert expands it again.
  function isMin() {
    try { return localStorage.getItem(MIN_KEY) === "1"; } catch (e) { return false; }
  }
  function setMin(on) {
    try { localStorage.setItem(MIN_KEY, on ? "1" : "0"); } catch (e) { /* not remembered - fine */ }
    render();
  }

  function setSound(on) {
    try { localStorage.setItem(SOUND_KEY, on ? "on" : "off"); } catch (e) { /* ignore */ }
    render();
    if (on) beep(true); // a sample, so the operator knows it works
  }

  // Alert sound: a three-tone siren. Browsers only allow audio after the user has interacted with the
  // page, so one shared AudioContext is created/resumed on the first click or key press.
  let audioCtx = null;
  function ctx() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  ["pointerdown", "keydown"].forEach((ev) => window.addEventListener(ev, () => ctx(), { once: true, passive: true }));

  function beep(force) {
    if (!force && !soundOn()) return;
    try {
      const c = ctx();
      if (!c) return;
      [880, 660, 880, 660, 990].forEach((freq, i) => {
        const t0 = c.currentTime + i * 0.24;
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = "square";
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        o.connect(g).connect(c.destination);
        o.start(t0);
        o.stop(t0 + 0.24);
      });
    } catch (e) { /* no sound is fine */ }
  }

  function ago(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return "";
    const m = Math.round(ms / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    const h = Math.floor(m / 60);
    return h < 24 ? h + " h " + (m % 60) + " min ago" : Math.floor(h / 24) + " d ago";
  }

  // When it HAPPENED (not when we noticed): "marked 17:53 IST - 25 min ago".
  function markedAt(a) {
    const t = new Date(a.eventAt || a.raisedAt).getTime();
    if (!Number.isFinite(t)) return "";
    const hhmm = new Date(t + 5.5 * 3600000).toISOString().slice(11, 16);
    return "Marked " + hhmm + " IST - " + ago(a.eventAt || a.raisedAt);
  }

  // The station behind the alert (the tote's count station); a station alert already has it in its title.
  function stationOf(a) {
    const st = a.detail && a.detail.station;
    return st && !String(a.title || "").includes(String(st)) ? "Station " + st + " - " : "";
  }

  const openGlobal = () => state.alerts.filter((a) => a.level === "GLOBAL" && a.status === "OPEN");
  const openAll = () => state.alerts.filter((a) => a.status === "OPEN");

  // A saved remark is shown as text; otherwise "Add remark" opens a box right in the popup.
  function remarkHtml(a) {
    if (a.remark) return `<div class="at-remark">Remark: ${esc(a.remark)} <i>- ${esc(a.remarkBy)}</i></div>`;
    if (!remarkOpen.has(a.id)) return "";
    return `<div class="at-remark-edit"><label class="sr-only" for="at-rm-${a.id}">Remark</label>
      <textarea id="at-rm-${a.id}" data-at-text="${a.id}" rows="2" maxlength="1000" placeholder="What happened / what was done...">${esc(drafts.get(a.id) || "")}</textarea></div>`;
  }

  function actionsHtml(a) {
    const ack = `<button type="button" class="primary" data-at-ack="${a.id}">Acknowledge</button>`;
    if (a.remark) return ack;
    return remarkOpen.has(a.id)
      ? `<button type="button" class="primary" data-at-save="${a.id}">Save &amp; acknowledge</button><button type="button" class="link" data-at-cancel="${a.id}">Cancel</button>`
      : `${ack}<button type="button" class="link" data-at-remark="${a.id}">Add remark</button>`;
  }

  function render() {
    const open = openGlobal();
    const el = trayEl();
    if (el) {
      // keep what is being typed: capture drafts and focus before the list is rebuilt
      el.querySelectorAll("[data-at-text]").forEach((t) => drafts.set(Number(t.dataset.atText), t.value));
      const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.atText : null;
      const caret = focused ? document.activeElement.selectionStart : 0;
      el.hidden = open.length === 0;
      el.classList.toggle("min", isMin());
      if (open.length) {
        el.innerHTML = `
          <div class="at-head">
            <span class="at-bell"><i class="ico" data-i="alert"></i></span>
            <b>${open.length} high-priority alert${open.length === 1 ? "" : "s"}</b>
            <button type="button" class="at-min" data-at-min title="${isMin() ? "Show alerts" : "Minimise"}" aria-label="${isMin() ? "Show alerts" : "Minimise alerts"}">${isMin() ? "▢" : "–"}</button>
            <button type="button" class="at-sound" data-at-sound title="${soundOn() ? "Mute alert sound" : "Unmute alert sound"}">${soundOn() ? "🔔" : "🔕"}</button>
          </div>
          <div class="at-list">${open.slice(0, 6).map((a) => `
            <div class="at-item" data-id="${a.id}">
              <div class="at-title">${esc(a.title)}</div>
              <div class="at-meta">${esc(stationOf(a) + markedAt(a))}</div>
              ${remarkHtml(a)}
              <div class="at-actions">${actionsHtml(a)}</div>
            </div>`).join("")}${open.length > 6 ? `<button type="button" class="link at-more" data-at-open="">+${open.length - 6} more on the Alerts page</button>` : ""}</div>`;
      } else {
        el.innerHTML = "";
      }
      if (focused) {
        const t = el.querySelector(`[data-at-text="${focused}"]`);
        if (t) { t.focus(); t.setSelectionRange(caret, caret); }
      }
    }
    const badge = navBadge();
    if (badge) {
      const n = openAll().length;
      badge.hidden = n === 0;
      badge.textContent = n > 99 ? "99+" : String(n);
      badge.classList.toggle("global", open.length > 0);
    }
    document.title = open.length ? `(${open.length}) ALERT - ${baseTitle}` : baseTitle;
    listeners.forEach((fn) => { try { fn(state); } catch (e) { /* a listener bug must not break the others */ } });
  }

  function announceNew(alerts) {
    const fresh = alerts.filter((a) => a.level === "GLOBAL" && a.status === "OPEN" && !seen.has(a.id));
    alerts.forEach((a) => seen.add(a.id));
    if (firstLoad) { firstLoad = false; return; } // existing open alerts are already in the popup; only NEW ones interrupt
    // No separate toast: the popup itself is the notice and the acknowledgement, so nothing is asked twice.
    if (fresh.length) { if (isMin()) setMin(false); beep(); }
  }

  async function acknowledge(id, button) {
    if (button) button.disabled = true;
    try {
      await Api.post("/alerts/" + id + "/acknowledge");
      await Live.refresh("alerts");
    } catch (e) {
      Toast.show({ title: "Couldn't acknowledge", message: e.message, tone: "warn" });
      if (button) button.disabled = false;
    }
  }

  // A remark written in the popup also acknowledges the alert: the IC has clearly seen and handled it, so they
  // shouldn't have to open the Alerts page to acknowledge separately.
  async function saveRemark(id, button) {
    const box = trayEl().querySelector(`[data-at-text="${id}"]`);
    const text = box ? box.value.trim() : "";
    if (!text) { if (box) box.focus(); return Toast.show({ title: "Write a remark first", tone: "warn", ms: 2000 }); }
    button.disabled = true;
    try {
      await Api.post("/alerts/" + id + "/remark", { text });
    } catch (e) {
      Toast.show({ title: "Couldn't save the remark", message: e.message, tone: "danger" });
      button.disabled = false;
      return;
    }
    remarkOpen.delete(id);
    drafts.delete(id);
    try {
      await Api.post("/alerts/" + id + "/acknowledge");
      Toast.show({ title: "Remark saved and alert acknowledged", tone: "ok", ms: 1800 });
    } catch (e) {
      // the remark is saved; the alert stays in the popup with its Acknowledge button so it can be retried
      Toast.show({ title: "Remark saved, but couldn't acknowledge", message: e.message, tone: "warn" });
    }
    await Live.refresh("alerts").catch(() => {});
  }

  function wire() {
    const el = trayEl();
    if (!el) return;
    el.addEventListener("click", (e) => {
      // Acknowledge closes the alert straight away - with or without a remark.
      const ack = e.target.closest("[data-at-ack]");
      if (ack) {
        const id = Number(ack.dataset.atAck);
        remarkOpen.delete(id);
        drafts.delete(id);
        return acknowledge(id, ack);
      }
      if (e.target.closest("[data-at-sound]")) return setSound(!soundOn());
      if (e.target.closest("[data-at-min]")) return setMin(!isMin());
      if (isMin() && e.target.closest(".at-head")) return setMin(false);
      const add = e.target.closest("[data-at-remark]");
      if (add) {
        const id = Number(add.dataset.atRemark);
        remarkOpen.add(id);
        render();
        const t = trayEl().querySelector(`[data-at-text="${id}"]`);
        if (t) t.focus();
        return;
      }
      const cancel = e.target.closest("[data-at-cancel]");
      if (cancel) { const id = Number(cancel.dataset.atCancel); remarkOpen.delete(id); drafts.delete(id); return render(); }
      const save = e.target.closest("[data-at-save]");
      if (save) return saveRemark(Number(save.dataset.atSave), save);
      const open = e.target.closest("[data-at-open]");
      if (open) { location.hash = "#alerts"; }
    });
    document.getElementById("alertsNavBtn")?.addEventListener("click", () => { /* the tab switch is handled by the shell */ });
  }

  function start() {
    if (started) return;
    started = true;
    wire();
    Live.subscribe("alerts", (evt) => {
      if (evt.type !== "data") return;
      state = evt.data;
      announceNew(state.alerts);
      render();
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); }); // background timers are throttled
    // Repaints "x min ago" and repeats the sound once a minute while a global alert is still unacknowledged.
    let ticks = 0;
    setInterval(() => {
      if (!openGlobal().length) return;
      render();
      if (++ticks % 2 === 0) beep();
    }, 30000);
  }

  return { start, acknowledge, subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); }, get state() { return state; }, ago, esc };
})();
