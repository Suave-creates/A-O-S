// Shared Connection Status component - ONE source of truth, mounted once
// in the persistent app header (which never unmounts across tab switches,
// so "the same component on every dashboard page" is automatic) and reused
// by OperationLog.js for its per-entry system/identity line. Never
// independently recomputed per page.
const ConnectionStatus = (() => {
  let state = null;
  const mounted = [];
  const listeners = [];
  let unsubscribe = null;

  const SAFE_FALLBACK = {
    grafana: { connected: false, identity: "Disconnected" },
    concinity: { connected: false, identity: "Disconnected" },
    nexs: { connected: false, identity: "Disconnected" },
  };

  function dot(connected) {
    return connected ? "🟢" : "🔴";
  }

  // identity is no longer always one of two hardcoded safe strings - it now
  // carries a real external identity (a service's own JWT `sub`/API login),
  // relayed here through the backend. Escape it before rendering, exactly
  // like every other piece of externally-sourced text this app renders.
  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function itemHtml(label, info) {
    return `<span class="conn-item"><span class="conn-dot">${dot(info.connected)}</span><span class="conn-label">${label}</span><span class="conn-sep">&middot;</span><span class="conn-identity">${escHtml(info.identity)}</span></span>`;
  }

  function render(containerEl) {
    if (!containerEl) return;
    const s = state || SAFE_FALLBACK;
    containerEl.innerHTML = [itemHtml("Grafana", s.grafana), itemHtml("Concinity", s.concinity), itemHtml("NexS", s.nexs)].join("");
  }

  // Tell the operator when a service connects or drops (not on first load).
  const NAMES = { grafana: "Grafana", concinity: "Concinity", nexs: "NexS" };
  function toastChanges(prev, next) {
    if (!prev || prev === SAFE_FALLBACK || !next || typeof Toast === "undefined") return;
    for (const key of Object.keys(NAMES)) {
      const was = prev[key] && prev[key].connected;
      const now = next[key] && next[key].connected;
      if (was !== now) Toast.show({ title: NAMES[key] + (now ? " connected" : " disconnected"), tone: now ? "ok" : "danger" });
    }
  }

  function apply(next) {
    toastChanges(state, next);
    state = next || SAFE_FALLBACK;
    mounted.forEach(render);
    listeners.forEach((fn) => fn(state));
  }

  // "Refresh now" asks the server hub to re-check (rate-limited there); the
  // result arrives over the live stream like every other update.
  function refresh() {
    return Live.refresh("connections");
  }

  function mount(containerEl) {
    if (!containerEl) return;
    mounted.push(containerEl);
    render(containerEl); // paint the safe fallback immediately, refresh() fills in the real state
  }

  function onUpdate(fn) {
    listeners.push(fn);
  }

  function getState() {
    return state || SAFE_FALLBACK;
  }

  // Pushed by the server (topic "connections", checked every 15 s there) -
  // this tab never polls and never triggers a service login.
  function start() {
    if (unsubscribe) return;
    unsubscribe = Live.subscribe("connections", (evt) => {
      if (evt.type === "data") apply(evt.data);
      else if (evt.type === "feed-error" && !state) apply(SAFE_FALLBACK);
    });
  }

  return { mount, onUpdate, getState, refresh, start };
})();
