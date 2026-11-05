// NexS connects only when a person needs it.
//
//   await NexsConnect.run({ owner: "totePurge", reason: "Tote Purge" }, () => Api.post(...));
//
// - If NexS isn't connected for this tab, a small "Connecting to NexS" popup runs
//   (reach NexS -> sign in -> ready), then the action proceeds.
// - While the screen is open the tab renews its lease; when the user leaves the
//   screen (NexsConnect.release(owner)) or closes the tab, the lease ends and the
//   server drops the NexS session once nothing is using it. A calculation that is
//   still running keeps NexS until it finishes (the server holds its own lease).
// - NexS allows one session per account, so a refusal ("another active session")
//   is shown plainly with Try again / Cancel.
const NexsConnect = (() => {
  const HEARTBEAT_MS = 25 * 1000;
  const MIN_STEP_MS = 420; // so the steps are readable even when NexS answers instantly

  const owners = new Set();
  let lease = null; // { leaseId }
  let timer = null;
  let pending = null;

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function startHeartbeat() {
    clearInterval(timer);
    timer = setInterval(async () => {
      if (!lease) return;
      try {
        const r = await Api.post("/nexs/heartbeat", { leaseId: lease.leaseId });
        if (!r.ok) lease = null; // expired or server restarted: reconnect on next use
      } catch (e) {
        /* transient - the next beat retries; the server expires the lease if we stay silent */
      }
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    clearInterval(timer);
    timer = null;
  }

  // ── popup ──────────────────────────────────────────────────────────────
  const STEPS = [
    ["Reaching NexS", "Contacting the NexS service"],
    ["Signing in", "Opening a session for this app"],
    ["Ready", "NexS is connected"],
  ];

  function popupBody(reason, stepIdx, state, message) {
    const rows = STEPS.map(([label, sub], i) => {
      const cls = state === "error" && i === stepIdx ? "err" : i < stepIdx || state === "done" ? "done" : i === stepIdx ? "run" : "wait";
      const icon = cls === "done" ? '<i class="ico" data-i="check"></i>' : cls === "err" ? '<i class="ico" data-i="alert"></i>' : cls === "run" ? '<span class="spinner"></span>' : "";
      return `<li class="nx-step ${cls}"><span class="nx-ic">${icon}</span><div><b>${esc(label)}</b><span>${esc(sub)}</span></div></li>`;
    }).join("");
    const heading = state === "error" ? "Couldn't connect to NexS" : state === "done" ? "Connected to NexS" : "Connecting to NexS";
    return `<div class="nx">
      <div class="nx-orb ${state}"><span></span><span></span><span></span><i class="ico" data-i="link"></i></div>
      <h3>${heading}</h3>
      <p class="nx-sub">${esc(reason ? reason + " needs NexS." : "")} ${state === "error" ? "" : "It disconnects by itself when you're done."}</p>
      <ul class="nx-steps">${rows}</ul>
      ${state === "error" ? `<div class="dd-banner danger">${esc(message)}</div><div class="nx-actions"><button class="primary" data-nx="retry">Try again</button><button class="link" data-nx="cancel">Cancel</button></div>` : ""}
    </div>`;
  }

  function cancelError() {
    const e = new Error("NexS connection cancelled");
    e.code = "CANCELLED";
    return e;
  }

  async function connectFlow(reason, owner) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const modal = Modal.open({ title: "NexS", subtitle: "Connect on demand", icon: "link", size: "sm", onClose: () => { if (!settled) { settled = true; reject(cancelError()); } } });
      const paint = (stepIdx, state, message) => { if (modal.isOpen()) modal.body.innerHTML = popupBody(reason, stepIdx, state, message); };

      async function attempt() {
        paint(0, "run");
        try {
          const started = Date.now();
          await sleep(MIN_STEP_MS);
          paint(1, "run");
          const lock = await Api.post("/nexs/connect", { label: reason || owner || "" });
          const wait = MIN_STEP_MS * 2 - (Date.now() - started);
          if (wait > 0) await sleep(wait);
          lease = { leaseId: lock.leaseId };
          startHeartbeat();
          Live.refresh("connections"); // the header badge shows NexS connected right away
          paint(2, "done");
          await sleep(650);
          if (!settled) { settled = true; modal.close(); resolve(); }
        } catch (e) {
          if (settled) return;
          const msg = e.body && e.body.error ? e.body.error : e.message;
          paint(1, "error", msg);
        }
      }

      modal.body.addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-nx]");
        if (!b) return;
        if (b.dataset.nx === "retry") attempt();
        else modal.close(); // closing rejects via onClose
      });
      attempt();
    });
  }

  // Make sure NexS is connected for this tab (popup only when it isn't).
  function ensure({ owner, reason }) {
    owners.add(owner);
    if (lease) return Promise.resolve();
    if (!pending) pending = connectFlow(reason, owner).finally(() => { pending = null; });
    return pending.catch((e) => {
      owners.delete(owner);
      throw e;
    });
  }

  // Connect if needed, run the action; if the server says NexS isn't connected
  // (lease lost, server restarted) reconnect once and retry.
  async function run({ owner, reason }, action) {
    await ensure({ owner, reason });
    try {
      return await action();
    } catch (e) {
      if (e && e.body && e.body.code === "NEXS_NOT_CONNECTED") {
        lease = null;
        await ensure({ owner, reason });
        return action();
      }
      throw e;
    }
  }

  // The user left the screen that needed NexS.
  function release(owner) {
    if (!owners.delete(owner)) return;
    if (owners.size > 0 || !lease) return;
    const { leaseId } = lease;
    lease = null;
    stopHeartbeat();
    Api.post("/nexs/release", { leaseId }).catch(() => {});
    setTimeout(() => Live.refresh("connections"), 12 * 1000); // the server drops NexS shortly after the last release
  }

  // Tab closed / navigated away: tell the server so NexS is dropped promptly
  // (if this is missed, the lease simply expires without heartbeats).
  window.addEventListener("pagehide", () => {
    if (!lease) return;
    try {
      navigator.sendBeacon("/api/v1/nexs/release", new Blob([JSON.stringify({ leaseId: lease.leaseId })], { type: "text/plain" }));
    } catch (e) {
      /* best effort */
    }
  });

  return { ensure, run, release, get connected() { return !!lease; } };
})();
