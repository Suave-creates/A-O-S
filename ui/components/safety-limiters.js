// ui/components/safety-limiters.js
// UI logic for the two operational safety limiters:
//   1. Auto Mode Heartbeat        — operator confirmation modal (driven by AUTO_STATE_UPDATE)
//   2. Manual Pull Safety Limiter — live rolling-window counter + warning modal (driven by STATE_UPDATE)

const SafetyLimiters = (() => {
  const $ = id => document.getElementById(id);
  function setText(id, val) { const el = $(id); if (el) el.textContent = val; }

  // ── Auto Mode Heartbeat ──────────────────────────────────────────────────────
  let _hbCountdownTimer = null;

  function renderHeartbeat(state) {
    const overlay = $("heartbeatModalOverlay");
    if (!overlay || !state) return;

    if (state.awaitingHeartbeat && state.heartbeatDeadline) {
      overlay.style.display = "flex";
      const mins = state.heartbeatMinutes || 10;
      setText("heartbeatModalInterval", mins === 1 ? "1 minute" : `${mins} minutes`);
      startHeartbeatCountdown(state.heartbeatDeadline);
    } else {
      overlay.style.display = "none";
      stopHeartbeatCountdown();
    }
  }

  function startHeartbeatCountdown(deadline) {
    stopHeartbeatCountdown();
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setText("heartbeatCountdown", remaining);
      if (remaining <= 0) stopHeartbeatCountdown();
    };
    tick();
    _hbCountdownTimer = setInterval(tick, 500);
  }
  function stopHeartbeatCountdown() {
    if (_hbCountdownTimer) { clearInterval(_hbCountdownTimer); _hbCountdownTimer = null; }
  }

  async function confirmHeartbeat() {
    const btn = $("heartbeatContinueBtn");
    if (btn) btn.disabled = true;
    try { await chrome.runtime.sendMessage({ type: "AUTO_HEARTBEAT_CONFIRM" }); }
    finally { if (btn) btn.disabled = false; }
  }
  async function stopFromHeartbeat() {
    const btn = $("heartbeatStopBtn");
    if (btn) btn.disabled = true;
    try { await chrome.runtime.sendMessage({ type: "AUTO_HEARTBEAT_STOP" }); }
    finally { if (btn) btn.disabled = false; }
  }

  // ── Manual Pull Safety Limiter ────────────────────────────────────────────────
  // The background sends a small array of raw pull timestamps (<=100 numbers).
  // We recompute count/remaining client-side every second so the counter visibly
  // decays in real time as entries age out of the 6-minute window, without
  // needing a fresh broadcast from the background for every tick.
  let _pullTimestamps = [];
  let _pullMax         = 100;
  let _pullWindowMs     = 6 * 60000;
  let _pullTickTimer    = null;
  let _pullModalOpen    = false;

  function renderPullLimit(pullLimit) {
    if (!pullLimit) return;
    _pullTimestamps = Array.isArray(pullLimit.timestamps) ? pullLimit.timestamps : [];
    _pullMax        = pullLimit.max || 100;
    _pullWindowMs   = pullLimit.windowMs || 6 * 60000;
    tickPullLimit();
    if (!_pullTickTimer) _pullTickTimer = setInterval(tickPullLimit, 1000);
  }

  function tickPullLimit() {
    const cut  = Date.now() - _pullWindowMs;
    const live = _pullTimestamps.filter(t => t > cut);
    const count        = live.length;
    const remaining    = Math.max(0, _pullMax - count);
    const limitReached = count >= _pullMax;

    setText("pullLimitCount", count);
    setText("pullLimitMax", _pullMax);
    setText("pullLimitRemaining", remaining);

    const fill = $("pullLimitFill");
    if (fill) fill.style.width = Math.min(100, (count / _pullMax) * 100) + "%";

    const card = $("pullLimitCard");
    if (card) {
      card.classList.toggle("limit-warn", count >= _pullMax * 0.8 && !limitReached);
      card.classList.toggle("limit-reached", limitReached);
    }

    // Warning modal — appears the instant the limit is hit, auto-dismisses the
    // instant the rolling window frees a slot. No manual reset required.
    const overlay = $("pullLimitModalOverlay");
    if (limitReached && !_pullModalOpen) {
      _pullModalOpen = true;
      if (overlay) overlay.style.display = "flex";
    } else if (!limitReached && _pullModalOpen) {
      _pullModalOpen = false;
      if (overlay) overlay.style.display = "none";
    }
    if (limitReached && live.length) {
      const waitSec = Math.max(0, Math.ceil((live[0] + _pullWindowMs - Date.now()) / 1000));
      setText("pullLimitWaitSec", waitSec);
    }
  }

  function dismissPullLimitModal() {
    _pullModalOpen = false;
    const overlay = $("pullLimitModalOverlay");
    if (overlay) overlay.style.display = "none";
  }

  // ── Start Mode confirmation (Manual + Auto) ───────────────────────────────────
  // Promise-based replacement for the native confirm() dialog, styled to match
  // the rest of the safety-modal system. resolve(true) = Start, resolve(false) = Cancel.
  let _startConfirmResolve = null;

  function confirmStart({ title, message, note }) {
    return new Promise(resolve => {
      _startConfirmResolve = resolve;
      setText("startConfirmTitle", title || "Start?");
      const msgEl = $("startConfirmMsg");
      if (msgEl) msgEl.textContent = message || "";
      const noteEl = $("startConfirmNote");
      if (noteEl) {
        if (note) { noteEl.textContent = note; noteEl.style.display = ""; }
        else { noteEl.style.display = "none"; }
      }
      const overlay = $("startConfirmOverlay");
      if (overlay) overlay.style.display = "flex";
    });
  }
  function resolveStartConfirm(val) {
    const overlay = $("startConfirmOverlay");
    if (overlay) overlay.style.display = "none";
    const r = _startConfirmResolve;
    _startConfirmResolve = null;
    if (r) r(val);
  }

  // ── Init ──────────────────────────────────────────────────────────────────────
  function init() {
    $("heartbeatContinueBtn")?.addEventListener("click", confirmHeartbeat);
    $("heartbeatStopBtn")?.addEventListener("click", stopFromHeartbeat);
    $("pullLimitDismissBtn")?.addEventListener("click", dismissPullLimitModal);

    $("startConfirmOkBtn")?.addEventListener("click", () => resolveStartConfirm(true));
    $("startConfirmCancelBtn")?.addEventListener("click", () => resolveStartConfirm(false));
    // Click on the dimmed backdrop (not the modal box itself) — same as Cancel.
    $("startConfirmOverlay")?.addEventListener("click", e => {
      if (e.target.id === "startConfirmOverlay") resolveStartConfirm(false);
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && $("startConfirmOverlay")?.style.display !== "none") resolveStartConfirm(false);
    });

    chrome.runtime.onMessage.addListener(msg => {
      if (msg && msg.type === "AUTO_STATE_UPDATE" && msg.state) renderHeartbeat(msg.state);
      if (msg && msg.type === "STATE_UPDATE" && msg.state) renderPullLimit(msg.state.pullLimit);
    });

    // Initial paint on tab load — pull whatever state each background session already has.
    chrome.runtime.sendMessage({ type: "AUTO_GET_STATE" }).then(r => { if (r && r.state) renderHeartbeat(r.state); }).catch(() => {});
    chrome.runtime.sendMessage({ type: "GET_STATE" }).then(r => { if (r) renderPullLimit(r.pullLimit); }).catch(() => {});
  }

  return { init, confirmStart };
})();
