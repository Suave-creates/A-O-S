// ui/components/auto.js
// Auto mode control panel logic — all JS for the Auto tab.

const AutoPanel = (() => {

  const $ = id => document.getElementById(id);
  const PRIORITY = QTP_CONSTANTS.PRIORITY;
  const DEFAULTS  = QTP_CONSTANTS.DEFAULTS;

  // ── State ─────────────────────────────────────────────────────────────────
  let _state     = null; // last known auto state from background
  let _countdown = null; // setInterval handle for the "next batch in Xs" timer

  // ── Status display ────────────────────────────────────────────────────────
  const STATUS_CONFIG = {
    idle:      { label:"Idle",          cls:"status-idle"    },
    running:   { label:"Running",       cls:"status-running" },
    paused:    { label:"Paused",        cls:"status-paused"  },
    completed: { label:"Completed",     cls:"status-ok"      },
    fetching:  { label:"Fetching Data", cls:"status-fetch"   },
    error:     { label:"Error",         cls:"status-err"     },
  };

  // ── Sheet intelligence status ───────────────────────────────────────────
  function renderProcessStatus(status) {
    if (!status) return;
    setText("lastProcessedTime", status.lastProcessed
      ? QTP_UTILS.formatDateTime(new Date(status.lastProcessed).getTime()) : "never");
    setText("lastElapsed",   status.elapsedSec   || "—");
    setText("procAsrsRows",  status.asrsRows      || "—");
    setText("procPidCount",  status.pidsAnalysed  || "—");
    setText("procQueueCount",status.queueTotes    || "—");
  }

  function renderFetchStatus(data) {
    const badge = $("fetchStatusBadge");
    const lastTime = $("lastFetchTime");
    const lastNew  = $("lastFetchNew");
    const errCount = $("fetchErrorCount");
    if (badge) {
      if (data.status === "fetching")      { badge.textContent = "fetching…"; badge.className = "hint fetch-active"; }
      else if (data.fetchErrors > 0)       { badge.textContent = `${data.fetchErrors} error(s)`; badge.className = "hint fetch-err"; }
      else if (data.lastFetchTime)         { badge.textContent = "connected ✓"; badge.className = "hint fetch-ok"; }
      else                                 { const hasUrl=$("autoSheetUrl")&&$("autoSheetUrl").value.trim().startsWith("https://");badge.textContent=hasUrl?"Apps Script ready":"not configured";badge.className=hasUrl?"hint fetch-ok":"hint"; }
    }
    if (lastTime)  lastTime.textContent  = data.lastFetchTime ? QTP_UTILS.formatTime(data.lastFetchTime) : "never";
    if (lastNew)   lastNew.textContent   = data.lastFetchResult ? (data.lastFetchResult.inserted || 0) : "—";
    if (errCount)  errCount.textContent  = data.fetchErrors || 0;
  }

  function renderStatus(state) {
    if (!state) return;
    const cfg    = STATUS_CONFIG[state.status] || STATUS_CONFIG.idle;
    const dot    = $("autoStatusDot");
    const label  = $("autoStatusLabel");
    if (dot)   { dot.className = "status-dot " + cfg.cls; }
    if (label) { label.textContent = cfg.label; }

    // Control button states
    const running = state.running && !state.paused;
    const paused  = state.running && state.paused;
    const idle    = !state.running;
    setDisabled("autoStartBtn",   !idle);
    setDisabled("autoPauseBtn",   !running);
    setDisabled("autoResumeBtn",  !paused);
    setDisabled("autoStopBtn",    idle);
    setDisabled("autoSkipBtn",    idle);

    // Batch countdown timer
    if (running && state.nextBatchIn != null) {
      startCountdown(state.nextBatchIn);
    } else {
      stopCountdown();
      const el = $("nextBatchIn");
      if (el) el.textContent = "—";
    }
  }

  function setDisabled(id, val) {
    const el = $(id);
    if (el) el.disabled = val;
  }

  // ── Countdown timer ───────────────────────────────────────────────────────
  // Shows "Next batch in: 4m 32s" counting down in real time.
  // Updates every second using setInterval.
  let _countdownTarget = null;
  function startCountdown(ms) {
    stopCountdown();
    _countdownTarget = Date.now() + ms;
    _countdown = setInterval(() => {
      const remaining = Math.max(0, _countdownTarget - Date.now());
      const el = $("nextBatchIn");
      if (el) el.textContent = remaining > 0 ? QTP_UTILS.formatDuration(remaining) : "Starting…";
      if (remaining <= 0) stopCountdown();
    }, 1000);
  }
  function stopCountdown() {
    if (_countdown) { clearInterval(_countdown); _countdown = null; }
    _countdownTarget = null;
  }

  // ── Queue display ─────────────────────────────────────────────────────────
  function renderQueue(queue) {
    if (!queue) return;
    // Headline counts reflect the real locked picture (snapshot from the last
    // fetch), not the queue draining per call. Fall back to live queue counts
    // only before the first fetch has produced a snapshot.
    const b = (queue.locked && queue.locked.total) ? queue.locked : null;
    setText("queueSDCount",    (b ? b.sd    : queue.sdCount) || 0);
    setText("queueP0Count",    (b ? b.p0    : queue.p0Count) || 0);
    setText("queueP1Count",    (b ? b.p1    : queue.p1Count) || 0);
    setText("queueP2Count",    (b ? b.p2    : queue.p2Count) || 0);
    setText("queueTotalCount", (b ? b.total : queue.total)   || 0);

    // Render the queue table — shows individual totes with their priority and source
    const tbody = $("autoQueueBody");
    const empty = $("autoQueueEmpty");
    if (!tbody) return;
    const all = [...(queue.p0||[]), ...(queue.p1||[]), ...(queue.p2||[])];
    tbody.innerHTML = "";
    if (empty) empty.style.display = all.length ? "none" : "";
    for (const entry of all) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="td-tote">${escHtml(entry.toteId)}</td>` +
        `<td><span class="priority-badge p${entry.priority.toLowerCase()}">${entry.priority}</span></td>` +
        `<td class="td-src">${escHtml(entry.source||"Manual")}</td>` +
        `<td class="td-time">${new Date(entry.addedAt).toLocaleTimeString()}</td>` +
        `<td><button class="btn-remove-tote ghost-xs" data-tote="${escHtml(entry.toteId)}">✕</button></td>`;
      tbody.appendChild(tr);
    }
    // Wire remove buttons
    tbody.querySelectorAll(".btn-remove-tote").forEach(btn => {
      btn.addEventListener("click", () => removeTote(btn.dataset.tote));
    });
  }

  // ── Stats display ─────────────────────────────────────────────────────────
  function renderStats(stats) {
    if (!stats) return;
    setText("autoStatCalled",   stats.called       || 0);
    setText("autoStatAlready",  stats.alreadyQueued|| 0);
    setText("autoStatUnavail",  stats.notAvailable || 0);
    setText("autoStatSkipped",  (stats.skipped||0) + (stats.ignored||0));
    setText("autoStatBatches",  stats.batchesRun   || 0);
  }

  // ── Activity log ──────────────────────────────────────────────────────────
  const LEVEL_CLASS = {
    op_ok:"op-ok", op_warn:"op-warn", op_err:"op-err",
    skipped:"op-skip", ignored:"op-ignore", net_err:"net-err",
    info:"info", warn:"info",
  };
  function renderLog(entries) {
    const el = $("autoLog");
    if (!el) return;
    el.innerHTML = "";
    for (const e of (entries||[])) {
      const div = document.createElement("div");
      div.className = "log-entry " + (LEVEL_CLASS[e.level]||"info");
      div.innerHTML = `<span class="time">${new Date(e.t).toLocaleTimeString()}</span><span class="msg"></span>`;
      div.querySelector(".msg").textContent = e.msg;
      el.appendChild(div);
    }
    el.scrollTop = el.scrollHeight;
  }

  // ── Full state render ─────────────────────────────────────────────────────
  function render(state) {
    if (!state) return;
    _state = state;
    renderStatus(state);
    renderQueue(state.queue);
    renderStats(state.stats);
    renderLog(state.log);

    // Update session info bar
    if (state.config) {
      setText("autoZoneDisplay",    "Zone " + (state.config.zone || "—"));
      setText("autoBatchDisplay",   `${state.config.batchSize||5} totes / batch`);
      setText("autoIntervalDisplay",`Every ${state.config.batchIntervalMinutes||1}m`);
    }
  }

  // ── Config collection ─────────────────────────────────────────────────────
  function getConfig() {
    return {
      host:                 $("autoHost")?.value.trim().replace(/\/+$/,"") || DEFAULTS.HOST,
      zone:                 $("autoZone")?.value.trim()                    || "",
      instanceCode:         $("autoInstanceCode")?.value.trim()            || DEFAULTS.INSTANCE_CODE,
      batchSize:            Math.max(1, parseInt($("autoBatchSize")?.value, 10)    || 5),
      callInterval:         Math.max(1, parseInt($("autoCallInterval")?.value, 10) || 5),
      batchIntervalMinutes: Math.max(0.1, parseFloat($("autoBatchInterval")?.value) || 1),
      retryDelay:           Math.max(1, parseInt($("autoRetryDelay")?.value, 10)   || 5),
      cooldownHours:        Math.max(0, parseFloat($("autoCooldown")?.value)        || 0),
      sheetUrl:             $("autoSheetUrl")?.value.trim()                           || "",
      fetchInterval:        Math.max(1, parseFloat($("autoFetchInterval")?.value)     || 2),
      heartbeatMinutes:     parseInt($("autoHeartbeatMinutes")?.value, 10) || 10,
    };
  }

  function saveConfig() {
    const cfg = getConfig();
    chrome.runtime.sendMessage({ type:"SAVE_CONFIG", config:cfg });
    return cfg;
  }

  // ── Queue actions ─────────────────────────────────────────────────────────
  async function addTotesToQueue(priority) {
    const textareaId = { P0:"totesP0", P1:"totesP1", P2:"totesP2" }[priority];
    const textarea   = $(textareaId);
    if (!textarea) return;
    const raw   = textarea.value;
    const totes = QTP_UTILS.parseToteList(raw).map(id => ({ toteId:id }));
    if (!totes.length) { showToast(`No valid tote IDs found in ${priority} list.`, "warn"); return; }

    const resp = await chrome.runtime.sendMessage({
      type: "AUTO_ADD_TOTES", totes, priority, source: "Manual",
    });
    if (resp && resp.result) {
      const r = resp.result;
      showToast(`${priority}: ${r.inserted} added, ${r.duplicates} duplicates, ${r.invalid} invalid`, r.inserted > 0 ? "ok" : "warn");
      if (resp.queue) renderQueue(resp.queue);
    }
  }

  async function removeTote(toteId) {
    const resp = await chrome.runtime.sendMessage({ type:"AUTO_REMOVE_TOTE", toteId });
    if (resp && resp.queue) renderQueue(resp.queue);
  }

  async function clearQueue(priority) {
    const label = priority || "all priorities";
    if (!confirm(`Clear queue (${label})? This cannot be undone.`)) return;
    const resp = await chrome.runtime.sendMessage({ type:"AUTO_CLEAR_QUEUE", priority: priority||null });
    if (resp && resp.queue) renderQueue(resp.queue);
    showToast(`Queue cleared (${label}).`, "warn");
  }

  // ── Session controls ──────────────────────────────────────────────────────
  // ── Heartbeat-aware call estimate ─────────────────────────────────────────
  // Mirrors the real scheduler in background/index.js: batchIntervalMinutes >= 1
  // runs at a fixed cadence timed from each batch's START (chrome.alarms
  // ALARM.CALL); under 1 minute it chains from each batch's COMPLETION instead
  // (see callNextInBatch). Used only to give the operator a heads-up in the
  // Start confirmation — actual counts can differ slightly with retries/cooldowns.
  function estimateTotesBeforeHeartbeat(cfg, totalQueued) {
    const B = Math.max(1, Number(cfg.batchSize) || 5);              // totes per batch
    const C = Math.max(1, Number(cfg.callInterval) || 5);           // seconds between calls in a batch
    const I = Math.max(0, Number(cfg.batchIntervalMinutes) || 1);   // minutes between batches
    const H = Math.max(1, Number(cfg.heartbeatMinutes) || 10);      // minutes until heartbeat check
    const heartbeatSec = H * 60;
    const cadenceSec = I >= 1 ? (I * 60) : (B * C + I * 60);
    let batches = 0, t = 0;
    while (t < heartbeatSec) { batches++; t += cadenceSec; }
    return { batches, totes: Math.min(batches * B, totalQueued) };
  }

  async function startAuto() {
    const cfg = saveConfig();
    if (!cfg.host) { alert("Host is required."); return; }

    // Validate zone config — single or multi
    const zoneValidation = MultiZone.validate();
    if (!zoneValidation.ok) { alert(zoneValidation.reason); return; }

    // Merge zone config into cfg — but only override the single-zone fields when
    // multi-zone is actually enabled. In single-zone mode getZoneConfig() returns
    // an empty zone (""), so a blind Object.assign would wipe the zone the user
    // typed into the single-zone field and incorrectly trip "Zone is required".
    const zoneCfg = MultiZone.getZoneConfig();
    if (zoneCfg.multiZone) {
      cfg.zone         = zoneCfg.zone;
      cfg.instanceCode = zoneCfg.instanceCode;
    }
    cfg.multiZone = zoneCfg.multiZone;
    cfg.zones     = zoneCfg.zones || [];

    if (!cfg.zone) { alert("Zone is required."); return; }

    const qResp = await chrome.runtime.sendMessage({ type:"AUTO_GET_QUEUE" });
    if (!qResp || !qResp.queue || qResp.queue.total === 0) {
      alert("Queue is empty. Add totes to P0, P1, or P2 before starting."); return;
    }

    const zoneLabel = zoneCfg.multiZone
      ? "Zones " + zoneCfg.zones.map(z => z.zone).join(", ")
      : "Zone " + cfg.zone;

    const est = estimateTotesBeforeHeartbeat(cfg, qResp.queue.total);
    const heartbeatNote = est.totes < qResp.queue.total
      ? `~${est.totes} totes will be attempted before the first heartbeat check (${cfg.heartbeatMinutes}m interval, ${est.batches} batch${est.batches === 1 ? "" : "es"}).`
      : `All totes should complete before the first heartbeat check (${cfg.heartbeatMinutes}m interval).`;

    const ok = await SafetyLimiters.confirmStart({
      title: "Start Auto Mode?",
      message: `${qResp.queue.total} totes → ${zoneLabel}`,
      note: heartbeatNote,
    });
    if (!ok) return;

    await chrome.runtime.sendMessage({ type:"AUTO_START", config:cfg });
    refreshState();
  }

  async function refreshState() {
    const resp = await chrome.runtime.sendMessage({ type:"AUTO_GET_STATE" });
    if (resp && resp.state) render(resp.state);
    // Also refresh queue
    const qResp = await chrome.runtime.sendMessage({ type:"AUTO_GET_QUEUE" });
    if (qResp && qResp.queue) renderQueue(qResp.queue);
  }

  // ── Toast notifications ───────────────────────────────────────────────────
  // "Toast" = a small temporary notification that slides in and disappears.
  // Named after toast popping out of a toaster.
  function showToast(msg, type="ok") {
    const container = $("toastContainer") || document.body;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add("toast-visible"), 10);
    setTimeout(() => { toast.classList.remove("toast-visible"); setTimeout(() => toast.remove(), 300); }, 3000);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function setText(id, val) { const el = $(id); if (el) el.textContent = val; }
  function escHtml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  // ── Wire up DOM events ────────────────────────────────────────────────────
  function init() {
    // Add-to-queue buttons
    $("addP0Btn")?.addEventListener("click", () => addTotesToQueue("P0"));
    $("addP1Btn")?.addEventListener("click", () => addTotesToQueue("P1"));
    $("addP2Btn")?.addEventListener("click", () => addTotesToQueue("P2"));

    // Clear queue buttons
    $("clearP0Btn")?.addEventListener("click", () => clearQueue("P0"));
    $("clearP1Btn")?.addEventListener("click", () => clearQueue("P1"));
    $("clearP2Btn")?.addEventListener("click", () => clearQueue("P2"));
    $("clearAllQueueBtn")?.addEventListener("click", () => clearQueue(null));

    // Session controls
    $("autoStartBtn")?.addEventListener("click",  startAuto);
    $("autoStopBtn")?.addEventListener("click",   () => chrome.runtime.sendMessage({type:"AUTO_STOP"}).then(refreshState));
    $("autoPauseBtn")?.addEventListener("click",  () => chrome.runtime.sendMessage({type:"AUTO_PAUSE"}).then(refreshState));
    $("autoResumeBtn")?.addEventListener("click", () => chrome.runtime.sendMessage({type:"AUTO_RESUME"}).then(refreshState));
    $("autoSkipBtn")?.addEventListener("click",   () => chrome.runtime.sendMessage({type:"AUTO_SKIP_TOTE"}).then(refreshState));

    // Config save on change
    ["autoHost","autoZone","autoInstanceCode","autoBatchSize","autoCallInterval",
     "autoBatchInterval","autoRetryDelay","autoCooldown","autoFetchInterval","autoHeartbeatMinutes"].forEach(id => {
      $(id)?.addEventListener("change", saveConfig);
    });

    // Sheet URL — save to localStorage immediately on every keystroke
    // so it survives service worker restarts
    $("autoSheetUrl")?.addEventListener("input", () => {
      const url = $("autoSheetUrl")?.value.trim();
      localStorage.setItem("qtp_sheet_url", url);
      saveConfig();
    });
    $("autoSheetUrl")?.addEventListener("change", saveConfig);

    // Auto host check
    $("autoHost")?.addEventListener("change", async () => {
      const host = $("autoHost")?.value.trim();
      if (!host) return;
      const resp = await chrome.runtime.sendMessage({type:"CHECK_AUTH", host});
      const dot  = $("autoAuthDot");
      const lbl  = $("autoAuthLabel");
      if (dot) dot.className = "dot " + (resp?.ok ? "ok" : "bad");
      if (lbl) lbl.textContent = resp?.ok ? "Logged in" : (resp?.reason||"Not logged in");
    });

    // Process Queue button — single step: Locked Dump + ASRS → Priority Queue
    $("processQueueBtn")?.addEventListener("click", async () => {
      saveConfig();
      const btn = $("processQueueBtn");
      if (btn) { btn.disabled = true; btn.textContent = "Processing…"; }
      const r = await chrome.runtime.sendMessage({ type: "PROCESS_QUEUE" });
      if (btn) { btn.disabled = false; btn.textContent = "⚙ Process Queue"; }
      if (r?.result?.ok) {
        const res = r.result;
        setText("lastProcessedTime", new Date().toLocaleString());
        setText("lastElapsed", res.elapsedMs ? Math.round(res.elapsedMs/1000) : (res.elapsedSec || "—"));
        const grafanaEl = document.getElementById("procStatsGrafana");
        const sheetEl   = document.getElementById("procStatsSheet");
        if (res.locked !== undefined) {
          if (grafanaEl) grafanaEl.style.display = "";
          if (sheetEl)   sheetEl.style.display   = "none";
          setText("procLockedCount", res.locked  || 0);
          setText("procSDCount",     res.sdCount || 0);
          setText("procP0Count",     res.p0Count || 0);
          setText("procP1Count",     res.p1Count || 0);
          setText("procP2Count",     res.p2Count || 0);
          showToast(`✓ Fetched ${res.locked||0} locked totes → SD:${res.sdCount||0} P0:${res.p0Count||0} P1:${res.p1Count||0} P2:${res.p2Count||0}`, "ok");
        } else {
          if (grafanaEl) grafanaEl.style.display = "none";
          if (sheetEl)   sheetEl.style.display   = "";
          setText("procAsrsRows",   res.asrsRows  || "—");
          setText("procPidCount",   res.pidCount  || "—");
          setText("procQueueCount", res.queueSize || "—");
          showToast(`✓ Queue built: ${res.queueSize||0} totes (P0:${res.p0Count||0} P1:${res.p1Count||0} P2:${res.p2Count||0})`, "ok");
        }
      } else {
        showToast("Process Queue failed: " + (r?.result?.reason || "unknown"), "error");
      }
      refreshState();
    });;

    // Connect / Disconnect Apps Script
    let _sheetConnected = false;
    function setSheetConnected(connected) {
      _sheetConnected = connected;
      const btn = $("sheetConnectBtn");
      const badge = $("fetchStatusBadge");
      if (btn) {
        btn.textContent = connected ? "Disconnect" : "Connect";
        btn.className = "btn ghost subtle sheet-connect-btn" + (connected ? " sheet-connected" : "");
      }
      if (badge) {
        badge.textContent = connected ? "connected ✓" : ($("autoSheetUrl")?.value?.trim() ? "Apps Script ready" : "not configured");
        badge.className = "hint" + (connected ? " fetch-ok" : "");
      }
    }

    $("sheetConnectBtn")?.addEventListener("click", async () => {
      const btn = $("sheetConnectBtn");
      const url = $("autoSheetUrl")?.value?.trim();

      if (_sheetConnected) {
        // Disconnect is purely a UI state change — no background message needed
        setSheetConnected(false);
        showToast("Apps Script disconnected.", "warn");
        return;
      }

      if (!url) { showToast("Enter an Apps Script URL first.", "warn"); return; }

      if (btn) { btn.textContent = "Connecting…"; btn.disabled = true; }
      try {
        const r = await chrome.runtime.sendMessage({ type: "GET_SHEET_STATUS" });
        if (r?.status || (r?.ok !== false && url.startsWith("https://"))) {
          saveConfig();
          setSheetConnected(true);
          showToast("Apps Script connected ✓ — processes tote priorities via ASRS dump", "ok");
        } else {
          showToast("Connection failed — check your Apps Script URL.", "error");
          setSheetConnected(false);
        }
      } catch(e) {
        showToast("Connection error: " + (e?.message || String(e)), "error");
        setSheetConnected(false);
      } finally {
        if (btn) { btn.disabled = false; if (!_sheetConnected) btn.textContent = "Connect"; }
      }
    });


    // Queue Processing toggle
    document.getElementById("queueProcessingToggle")?.addEventListener("click", () => {
      const body    = document.getElementById("queueProcessingBody");
      const chevron = document.getElementById("queueProcessingChevron");
      if (!body) return;
      const open = body.style.display !== "none";
      body.style.display    = open ? "none" : "";
      if (chevron) chevron.textContent = open ? "▸" : "▾";
    });

    // Manual priority override toggle
    document.getElementById("manualOverrideToggle")?.addEventListener("click", () => {
      const lanes = document.getElementById("manualOverrideLanes");
      const chevron = document.getElementById("manualOverrideChevron");
      if (!lanes) return;
      const open = lanes.style.display !== "none";
      lanes.style.display = open ? "none" : "";
      if (chevron) chevron.textContent = open ? "▸" : "▾";
    });

    // Queue CSV export
    document.getElementById("exportQueueCsvBtn")?.addEventListener("click", async () => {
      const r = await chrome.runtime.sendMessage({ type: "AUTO_GET_QUEUE" });
      if (!r?.queue) return;
      const q = r.queue;
      const allTotes = [...(q.sd||[]),...(q.p0||[]),...(q.p1||[]),...(q.p2||[])];
      if (!allTotes.length) { showToast("Queue is empty.", "warn"); return; }
      const header = "Tote ID,Priority,Source,Added At";
      const rows = allTotes.map(t =>
        [t.toteId, t.priority, t.source||"", t.addedAt ? new Date(t.addedAt).toLocaleString() : ""].join(",")
      );
      const csv = [header, ...rows].join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url  = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), {
        href: url,
        download: "queue-" + new Date().toISOString().slice(0,16).replace(/[T:]/g,"-") + ".csv"
      });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      showToast(`✓ Exported ${allTotes.length} totes to CSV`, "ok");
    });

    // Listen for live updates from background
    chrome.runtime.onMessage.addListener(msg => {
      if (msg && msg.type === "AUTO_STATE_UPDATE" && msg.state) render(msg.state);
      if (msg && msg.type === "FETCH_STATUS_UPDATE") renderFetchStatus(msg);
    });

    // Initial load
    refreshState();
    loadSavedConfig();
    // Load sheet intelligence status
    setTimeout(async () => {
      const resp = await chrome.runtime.sendMessage({type:"GET_SHEET_STATUS"});
      if (resp && resp.status) renderProcessStatus(resp.status);
    }, 800);
  }

  async function loadSavedConfig() {
    const resp = await chrome.runtime.sendMessage({type:"GET_CONFIG"});
    const c = resp?.config;
    if (!c) return;
    if ($("autoHost"))            $("autoHost").value           = c.host            || DEFAULTS.HOST;
    if ($("autoZone"))            $("autoZone").value           = c.zone            || "";
    if ($("autoInstanceCode"))    $("autoInstanceCode").value   = c.instanceCode    || DEFAULTS.INSTANCE_CODE;
    if ($("autoBatchSize"))       $("autoBatchSize").value      = c.batchSize       || 5;
    if ($("autoCallInterval"))    $("autoCallInterval").value   = c.callInterval    || 5;
    if ($("autoBatchInterval"))   $("autoBatchInterval").value  = c.batchIntervalMinutes || 1;
    if ($("autoRetryDelay"))      $("autoRetryDelay").value     = c.retryDelay      || 5;
    if ($("autoCooldown"))        $("autoCooldown").value       = c.cooldownMinutes !== undefined ? c.cooldownMinutes : (c.cooldownHours ? c.cooldownHours * 60 : 0);
    if ($("autoHeartbeatMinutes"))$("autoHeartbeatMinutes").value = c.heartbeatMinutes || 10;

    // Apps Script URL — localStorage is the most reliable store (survives SW restarts)
    const savedSheetUrl = localStorage.getItem("qtp_sheet_url") || c.sheetUrl || "";
    if ($("autoSheetUrl") && savedSheetUrl) {
      $("autoSheetUrl").value = savedSheetUrl;
    }

    if (typeof GrafanaPanel !== "undefined") GrafanaPanel.loadGrafanaConfig(c);
  }

  return { init, render, refreshState };
})();

// ═══════════════════════════════════════════════════════════════════════════
// GRAFANA INTEGRATION — v3
// ═══════════════════════════════════════════════════════════════════════════

const GrafanaPanel = (() => {
  const $ = id => document.getElementById(id);
  let _statusTimer = null;

  // ── Session status ────────────────────────────────────────────────────────
  async function checkSession() {
    const url = $("grafanaUrl")?.value?.trim() || "https://192.168.24.230";
    try {
      const r = await chrome.runtime.sendMessage({ type: "GRAFANA_CHECK", host: url });
      setConnected(r?.connected);
    } catch(e) {
      setConnected(false);
    }
  }

  function setConnected(connected) {
    const dot   = $("grafanaConnDot");
    const label = $("grafanaConnLabel");
    const hDot  = document.getElementById("grafanaDot");
    const hLbl  = document.getElementById("grafanaLabel");
    if (dot)   dot.className   = "grafana-status-dot " + (connected ? "connected" : "disconnected");
    if (label) label.textContent = connected ? "Connected ✓" : "Log into Grafana";
    if (hDot)  hDot.className  = "dot " + (connected ? "dot-green" : "dot-red");
    if (hLbl)  hLbl.textContent = connected ? "Grafana ✓" : "Grafana ✗";
  }

  // ── Load / save Grafana config ────────────────────────────────────────────
  function loadGrafanaConfig(cfg) {
    if (!cfg) return;
    if ($("grafanaUrl"))           $("grafanaUrl").value           = cfg.grafanaUrl          || "https://192.168.24.230";
    if ($("grafanaAutoEnabled"))   $("grafanaAutoEnabled").checked  = !!cfg.grafanaAuto;
    if ($("grafanaLockedInterval"))$("grafanaLockedInterval").value = cfg.grafanaLockedInterval || 30;
    if ($("grafanaSuperEnabled"))  $("grafanaSuperEnabled").checked  = cfg.grafanaSuperEnabled !== false;
    if ($("grafanaSuperInterval")) $("grafanaSuperInterval").value  = cfg.grafanaSuperInterval || 60;
    localStorage.setItem("qtp_grafana_url", cfg.grafanaUrl || "https://192.168.24.230");
    // ASRS source toggle
    const src = cfg.asrsSource || "sheet_dump";
    const apiEl   = $("asrsSourceApi");
    const sheetEl = $("asrsSourceSheet");
    if (apiEl)   apiEl.checked   = src === "quadron_api";
    if (sheetEl) sheetEl.checked = src === "sheet_dump";
  }

  function readGrafanaConfig() {
    return {
      grafanaUrl:           ($("grafanaUrl")?.value?.trim()          || "https://192.168.24.230"),
      grafanaAuto:          !!$("grafanaAutoEnabled")?.checked,
      grafanaLockedInterval: parseInt($("grafanaLockedInterval")?.value) || 30,
      grafanaSuperEnabled:  !!$("grafanaSuperEnabled")?.checked,
      grafanaSuperInterval: parseInt($('grafanaSuperInterval')?.value) || 60,
      asrsSource:           $("asrsSourceApi")?.checked ? "quadron_api" : "sheet_dump",
    };
  }

  // ── Update status display ─────────────────────────────────────────────────
  function updateGrafanaStatus(st) {
    if (!st) return;
    setConnected(st.connected);

    const lockedEl = $("grafanaLockedLast");
    const superEl  = $("grafanaSuperLast");
    if (lockedEl) lockedEl.textContent = st.lastLockedFetch
      ? `Last: ${new Date(st.lastLockedFetch).toLocaleTimeString()} · ${st.lockedCount} totes`
      : "Never fetched";
    if (superEl) superEl.textContent = st.lastSuperFetch
      ? `Last: ${new Date(st.lastSuperFetch).toLocaleTimeString()} · ${st.superCount} totes`
      : "Never fetched";
  }

  function showResult(text, isErr) {
    const bar = $("grafanaResultBar");
    const txt = $("grafanaResultText");
    if (!bar || !txt) return;
    txt.textContent = text;
    bar.style.display = "";
    bar.className = "grafana-result-bar " + (isErr ? "err" : "ok");
    setTimeout(() => { bar.style.display = "none"; }, 8000);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    // Load saved URL from localStorage immediately
    const savedUrl = localStorage.getItem("qtp_grafana_url");
    if (savedUrl && $("grafanaUrl")) $("grafanaUrl").value = savedUrl;

    // Save URL on input
    $("grafanaUrl")?.addEventListener("input", e => {
      localStorage.setItem("qtp_grafana_url", e.target.value.trim());
      chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: { grafanaUrl: e.target.value.trim() } }).catch(() => {});
    });

    // Auto checkbox → start/stop Grafana alarms
    $("grafanaAutoEnabled")?.addEventListener("change", async e => {
      const gcfg = readGrafanaConfig();
      await chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: gcfg });
      if (e.target.checked) {
        const r = await chrome.runtime.sendMessage({ type: "GRAFANA_START_AUTO", ...gcfg });
        if (r?.result?.ok) showResult(`Auto-fetch ON — ${r.result.inserted} totes loaded`, false);
        else showResult("Failed to start auto-fetch. Is Grafana open?", true);
      } else {
        await chrome.runtime.sendMessage({ type: "GRAFANA_STOP_AUTO" });
        showResult("Auto-fetch stopped.", false);
      }
    });

    // Interval changes → save config
    ["grafanaLockedInterval","grafanaSuperInterval","grafanaSuperEnabled"].forEach(id => {
      $(id)?.addEventListener("change", () => {
        chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: readGrafanaConfig() }).catch(() => {});
      });
    });

    // ASRS Source radio → save immediately on change
    ["asrsSourceApi","asrsSourceSheet"].forEach(id => {
      $(id)?.addEventListener("change", () => {
        chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: readGrafanaConfig() }).catch(() => {});
      });
    });

    // Fetch Now
    $("grafanaFetchNowBtn")?.addEventListener("click", async () => {
      const btn = $("grafanaFetchNowBtn");
      if (btn) btn.textContent = "Fetching…";
      await chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: readGrafanaConfig() });
      const r = await chrome.runtime.sendMessage({ type: "GRAFANA_FETCH_NOW" });
      if (btn) btn.textContent = "↻ Fetch Now";
      if (r?.result?.ok) {
        showResult(`✓ +${r.result.inserted||0} added, -${r.result.cleared||0} cleared · Queue: ${r.result.total||0}`, false);
        setTimeout(refreshState, 400); // refresh queue display
      } else {
        showResult(`✗ ${r?.result?.reason || "Fetch failed. Ensure you are logged into Grafana."}`, true);
      }
    });

    // Listen for Grafana status updates from background
    chrome.runtime.onMessage.addListener(msg => {
      if (msg?.type === "GRAFANA_STATUS") updateGrafanaStatus(msg.status);
    });

    // Initial session check + periodic recheck every 30s
    checkSession();
    _statusTimer = setInterval(checkSession, 30000);

    // Load status from background
    chrome.runtime.sendMessage({ type: "GRAFANA_GET_STATUS" }).then(r => {
      if (r?.status) updateGrafanaStatus(r.status);
    }).catch(() => {});
  }

  return { init, loadGrafanaConfig, readGrafanaConfig };
})();
