
// Show/hide single zone based on MultiZone state
function updateManualZoneDisplay() {
  const single = document.getElementById("manualSingleZone");
  if (!single) return;
  const isMulti = (typeof MultiZone !== "undefined") && MultiZone.isEnabled();
  single.style.display = isMulti ? "none" : "";
}
// ui/app.js — UI controller for Phase 2
// Handles tab switching, Manual mode panel, and real-time state updates.

// Suppress benign MV3 messaging-race rejections (service worker sleeps/tears down
// while a sendMessage response is pending). These are noise, not failures.
const _BENIGN_MSG = /message channel closed|Receiving end does not exist|Extension context invalidated/i;
window.addEventListener("unhandledrejection", (ev) => {
  const m = (ev.reason && ev.reason.message) || String(ev.reason || "");
  if (_BENIGN_MSG.test(m)) ev.preventDefault();
});
// Belt-and-suspenders: every page→worker sendMessage gets a handled rejection so
// it never surfaces in the extension Errors panel. Benign → resolve undefined; real → rethrow.
if (chrome.runtime && chrome.runtime.sendMessage) {
  const _send = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (...args) => {
    const r = _send(...args);
    return (r && typeof r.catch === "function")
      ? r.catch(e => { if (_BENIGN_MSG.test((e && e.message) || "")) return undefined; throw e; })
      : r;
  };
}

const $ = id => document.getElementById(id);

// ── Element references ────────────────────────────────────────────────────────
const els = {
  host:$("host"), zone:$("zone"), instanceCode:$("instanceCode"),
  totes:$("totes"), interval:$("interval"), retryDelay:$("retryDelay"),
  startBtn:$("startBtn"), stopBtn:$("stopBtn"), skipBtn:$("skipBtn"),
  pauseBtn:$("pauseBtn"), resumeBtn:$("resumeBtn"),
  clearLogBtn:$("clearLogBtn"), toteCount:$("toteCount"),
  authDot:$("authDot"), authLabel:$("authLabel"),
  progressLabel:$("progressLabel"), progressCount:$("progressCount"),
  progressFill:$("progressFill"), log:$("log"),
  statTotal:$("statTotal"), statCalled:$("statCalled"),
  statAlready:$("statAlready"), statUnavail:$("statUnavail"), statSkipped:$("statSkipped"),
  toteTableBody:$("toteTableBody"), tableEmpty:$("tableEmpty"),
  exportCsvBtn:$("exportCsvBtn"), exportJsonBtn:$("exportJsonBtn"),
  clearDetailedLogBtn:$("clearDetailedLogBtn"),
  logsCount:$("logsCount"), autoBadge:$("autoBadge"),
};

// ── Tab navigation ────────────────────────────────────────────────────────────
// "Tab navigation" = clicking a tab button shows its panel and hides the others.
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${target}`).classList.add("active");
    if (target === "manual" || target === "auto" || target === "logs") {
      const g = document.getElementById("navTotePuller");
      if (g) g.classList.remove("collapsed");
    }
  });
});

// Sidebar "Tote Puller" group — expand/collapse its Manual/Auto sub-items
(() => {
  const toggle = document.getElementById("totePullerToggle");
  const group  = document.getElementById("navTotePuller");
  if (!toggle || !group) return;
  toggle.addEventListener("click", () => {
    const collapsed = group.classList.toggle("collapsed");
    toggle.setAttribute("aria-expanded", String(!collapsed));
  });
})();

// ── Settings persistence ──────────────────────────────────────────────────────
// "Persistence" = saving data so it survives the extension being closed and reopened.
const DEFAULTS = QTP_CONSTANTS.DEFAULTS;

function parseTotes(raw) {
  return QTP_UTILS.parseToteList(raw);
}

function updateToteCount() {
  els.toteCount.textContent = `${parseTotes(els.totes.value).length} queued`;
}

async function loadSettings() {
  const resp = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
  const s    = resp && resp.config ? resp.config : {};
  els.host.value         = s.host         || DEFAULTS.HOST;
  els.zone.value         = s.zone         || DEFAULTS.ZONE;
  els.instanceCode.value = s.instanceCode || DEFAULTS.INSTANCE_CODE;
  els.retryDelay.value   = s.retryDelay   || DEFAULTS.RETRY_DELAY;
  // Manual interval is stored in localStorage (private to manual mode) so that
  // auto-mode config saves don't overwrite it via the shared storage key.
  const local = JSON.parse(localStorage.getItem("qtp_local") || "{}");
  els.interval.value = local.manualCallInterval || s.callInterval || DEFAULTS.CALL_INTERVAL;
  if (local.totes) els.totes.value = local.totes;
  updateToteCount();
}

async function saveSettings() {
  const callInterval = Math.max(1, parseInt(els.interval.value, 10) || 5);
  const config = {
    host:         els.host.value.trim().replace(/\/+$/, ""),
    zone:         els.zone.value.trim(),
    instanceCode: els.instanceCode.value.trim(),
    callInterval,
    retryDelay:   Math.max(1, parseInt(els.retryDelay.value, 10) || 5),
  };
  // Save host/zone/instanceCode/retryDelay to shared config.
  // callInterval is NOT saved here — it lives in localStorage so that
  // auto-mode config saves (which use the same storage key) can't overwrite it.
  await chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config: {
    host:         config.host,
    zone:         config.zone,
    instanceCode: config.instanceCode,
    retryDelay:   config.retryDelay,
  }});
  // Persist manual-only settings to localStorage
  localStorage.setItem("qtp_local", JSON.stringify({
    totes: els.totes.value,
    manualCallInterval: callInterval,
  }));
  return config;
}

// ── Auth indicator ────────────────────────────────────────────────────────────
function setAuth(state, label) {
  els.authDot.className    = "dot " + (state || "");
  els.authLabel.textContent = label;
}

async function checkAuth() {
  const host = els.host.value.trim().replace(/\/+$/, "") || DEFAULTS.HOST;
  const resp = await chrome.runtime.sendMessage({ type: "CHECK_AUTH", host });
  setAuth(
    resp && resp.ok ? "ok" : "bad",
    resp && resp.ok ? (resp.sub ? `Logged in as ${resp.sub}` : "Logged in") : (resp?.reason || "Not logged in")
  );
}

// ── Running log renderer ──────────────────────────────────────────────────────
// "Renderer" = code that takes data and turns it into visible HTML on screen.
const LEVEL_CLASS = {
  op_ok:   "op-ok",
  op_warn: "op-warn",
  op_err:  "op-err",
  skipped: "op-skip",
  ignored: "op-ignore",
  net_err: "net-err",
  info:    "info",
  warn:    "info",
};

function renderLog(entries) {
  els.log.innerHTML = "";
  for (const e of entries) {
    const div = document.createElement("div");
    div.className = "log-entry " + (LEVEL_CLASS[e.level] || "info");
    div.innerHTML = `<span class="time">${new Date(e.t).toLocaleTimeString()}</span><span class="msg"></span>`;
    div.querySelector(".msg").textContent = e.msg;
    els.log.appendChild(div);
  }
  els.log.scrollTop = els.log.scrollHeight;
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function renderProgress(state) {
  const total = state.total || 0;
  const done  = state.done  || 0;
  els.progressCount.textContent = `${done} / ${total}`;
  els.progressFill.style.width  = total ? (done / total) * 100 + "%" : "0%";
  els.progressLabel.textContent = state.running
    ? (state.label || "Running…")
    : (total && done >= total ? "✓ Done" : "Idle");
}

// ── Stats + tote table ────────────────────────────────────────────────────────
const COND_META = {
  inserted:      { label:"Inserted into Queue",           cls:"tag-green"  },
  released:      { label:"Released from Quadron",         cls:"tag-green"  },
  already_queued:{ label:"Already in Queue / In Movement",cls:"tag-yellow" },
  not_available: { label:"Not Available",                 cls:"tag-red"    },
  skipped:       { label:"Manually Skipped",              cls:"tag-muted"  },
  ignored_cooldown:{ label:"Ignored (Cooldown)",          cls:"tag-blue"   },
};

function renderStats(detailedLog) {
  if (!detailedLog) return;
  const count  = cond => detailedLog.filter(e => e.condition === cond).length;
  const called = count("inserted") + count("released");
  els.statTotal.textContent   = detailedLog.length;
  els.statCalled.textContent  = called;
  els.statAlready.textContent = count("already_queued");
  els.statUnavail.textContent = count("not_available");
  els.statSkipped.textContent = count("skipped") + count("ignored_cooldown");

  const rows = [...detailedLog].sort((a, b) => b.t - a.t);
  els.toteTableBody.innerHTML  = "";
  els.tableEmpty.style.display = rows.length ? "none" : "";

  for (const e of rows) {
    const meta = COND_META[e.condition] || { label: e.condition, cls: "tag-red" };
    const tr   = document.createElement("tr");
    tr.innerHTML =
      `<td class="td-tote">${escHtml(e.tote)}</td>` +
      `<td class="td-zone">${escHtml(e.zone || "—")}</td>` +
      `<td><span class="tag ${meta.cls}">${meta.label}</span></td>` +
      `<td class="td-time">${new Date(e.t).toLocaleTimeString()}</td>`;
    els.toteTableBody.appendChild(tr);
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── UI state toggle ───────────────────────────────────────────────────────────
function setRunningUI(running, paused) {
  const activeRun = running && !paused;
  const isPaused  = running &&  paused;
  els.startBtn.disabled  = running;
  els.stopBtn.disabled   = !running;
  els.skipBtn.disabled   = !activeRun;
  if (els.pauseBtn) {
    els.pauseBtn.disabled      = !activeRun;
    els.pauseBtn.style.display = isPaused ? "none" : "";
  }
  if (els.resumeBtn) {
    els.resumeBtn.disabled      = !isPaused;
    els.resumeBtn.style.display = isPaused ? "" : "none";
  }
  [els.host, els.zone, els.instanceCode, els.totes, els.interval, els.retryDelay]
    .forEach(el => el.disabled = running);
}

// ── Full state refresh ────────────────────────────────────────────────────────
async function refreshState() {
  const resp = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!resp) return;
  setRunningUI(!!resp.running, !!resp.paused);
  renderProgress(resp);
  renderLog(resp.log || []);
  renderStats(resp.detailedLog || []);
}

// ── Export ────────────────────────────────────────────────────────────────────
function downloadFile(content, filename, mime) {
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([content], { type: mime })),
    download: filename,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function csvCell(v) { return QTP_UTILS.escapeCSVCell(v); }

async function exportDetailedLog(format) {
  const resp    = await chrome.runtime.sendMessage({ type: "GET_DETAILED_LOG" });
  const entries = (resp && resp.detailedLog) || [];
  const now     = new Date();
  const stamp   = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const seen = new Map();
  for (const e of entries) seen.set(e.tote, e);
  const unique = [...seen.values()].sort((a, b) => a.t - b.t);
  const countBy = c => unique.filter(e => e.condition === c).length;

  if (format === "csv") {
    const header = ["Tote ID","Zone","Condition","Status","Mode","Time","API Message"];
    const rows   = unique.map(e => {
      const meta = COND_META[e.condition] || { label: e.condition };
      return [e.tote, e.zone||"", e.condition, meta.label, e.mode||"manual", new Date(e.t).toLocaleString(), e.rawMsg].map(csvCell).join(",");
    });
    const summary = ["","--- 24-Hour Summary ---",
      `Total Unique Totes,${unique.length}`,
      `Successfully Called,${countBy("inserted")+countBy("released")}`,
      `Already in Queue / Moving,${countBy("already_queued")}`,
      `Not Available,${countBy("not_available")}`,
      `Skipped / Ignored,${countBy("skipped")+countBy("ignored_cooldown")}`,
      `Exported,${now.toLocaleString()}`];
    downloadFile([header.join(","), ...rows, ...summary].join("\n"),
      `quadron-tote-log-${stamp}.csv`, "text/csv");
  } else {
    const out = {
      exportedAt: now.toISOString(),
      summary: { totalUniqueTotes:unique.length, called:countBy("inserted")+countBy("released"),
        alreadyQueued:countBy("already_queued"), notAvailable:countBy("not_available"),
        skipped:countBy("skipped")+countBy("ignored_cooldown") },
      totes: unique.map(e => {
        const meta = COND_META[e.condition] || { label: e.condition };
        return { tote:e.tote, zone:e.zone, condition:e.condition, status:meta.label,
                 mode:e.mode||"manual", timestamp:new Date(e.t).toISOString(), apiMessage:e.rawMsg };
      }),
    };
    downloadFile(JSON.stringify(out, null, 2), `quadron-tote-log-${stamp}.json`, "application/json");
  }
}


// ── Service Worker Heartbeat ──────────────────────────────────────────────────
// Chrome MV3 service workers sleep after ~30 seconds of inactivity.
// When asleep, setTimeout timers are lost — causing gaps between tote calls.
// This heartbeat pings the SW every 20 seconds while a run is active,
// keeping it awake so timers fire correctly.
let _heartbeatTimer = null;

function startHeartbeat() {
  stopHeartbeat();
  _heartbeatTimer = setInterval(async () => {
    try {
      await chrome.runtime.sendMessage({ type: "HEARTBEAT" });
    } catch(e) {
      // SW may have restarted — that's fine, next tick will reconnect
    }
  }, 5000); // every 5 seconds — keeps SW alive (Chrome kills SW after ~30s idle)
}

function stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

// ── Event listeners ───────────────────────────────────────────────────────────
els.totes.addEventListener("input", () => { updateToteCount(); saveSettings(); });
[els.host, els.zone, els.instanceCode, els.interval, els.retryDelay].forEach(el => {
  el.addEventListener("change", saveSettings);
  el.addEventListener("blur",   saveSettings);
});
els.host.addEventListener("change", checkAuth);

els.startBtn.addEventListener("click", async () => {
  const cfg   = await saveSettings();
  const totes = parseTotes(els.totes.value);
  if (!cfg.host)     return alert("Host is required.");
  if (!totes.length) return alert("Add at least one valid tote ID (format: TL0000002607).");

  // Zone config — uses MultiZone if enabled in Auto tab, otherwise single zone
  const zoneCfg      = (typeof MultiZone !== "undefined") ? MultiZone.getZoneConfig() : null;
  const zone         = zoneCfg?.multiZone ? zoneCfg.zone         : (cfg.zone         || "");
  const instanceCode = zoneCfg?.multiZone ? zoneCfg.instanceCode : (cfg.instanceCode || "LK-069");
  if (!zone) return alert("Zone is required.");

  const zoneLabel = zoneCfg?.multiZone
    ? "Zones " + zoneCfg.zones.map(z => z.zone).join(", ")
    : "Zone " + zone;
  const ok = await SafetyLimiters.confirmStart({
    title: "Start Manual Mode?",
    message: `${totes.length} totes → ${zoneLabel}`,
  });
  if (!ok) return;

  startHeartbeat();
  await chrome.runtime.sendMessage({ type: "START", config: {
    ...cfg, zone, instanceCode,
    multiZone: zoneCfg?.multiZone || false,
    zones:     zoneCfg?.zones     || [],
    totes
  }});
  refreshState();
});

els.stopBtn.addEventListener("click", async () => {
  stopHeartbeat();
  await chrome.runtime.sendMessage({ type: "STOP" });
  refreshState();
});

els.pauseBtn?.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "MANUAL_PAUSE" });
  refreshState();
});

els.resumeBtn?.addEventListener("click", async () => {
  startHeartbeat();
  await chrome.runtime.sendMessage({ type: "MANUAL_RESUME" });
  refreshState();
});

els.skipBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "SKIP_TOTE" });
  refreshState();
});

els.clearLogBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_LOG" });
  refreshState();
});

els.exportCsvBtn.addEventListener("click",  () => exportDetailedLog("csv"));
els.exportJsonBtn.addEventListener("click", () => exportDetailedLog("json"));

els.clearDetailedLogBtn.addEventListener("click", async () => {
  if (!confirm("Clear the 24-hour tote summary? This cannot be undone.")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_DETAILED_LOG" });
  renderStats([]);
});

// Listen for live state updates pushed from the background service worker
chrome.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === "STATE_UPDATE") {
    setRunningUI(!!msg.state.running, !!msg.state.paused);
    renderProgress(msg.state);
    renderLog(msg.state.log || []);
    renderStats(msg.state.detailedLog || []);
    // Stop heartbeat when run completes
    if (!msg.state.running) stopHeartbeat();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  // Resilient init: a slow/unresponsive service worker must never prevent the
  // tab panels (Purge/Tracker render on init) from mounting.
  const safe = async (label, fn) => { try { return await fn(); } catch (e) { console.warn("[init] " + label + " failed:", e); } };
  await safe("loadSettings", loadSettings);
  await safe("refreshState", refreshState);
  await safe("checkAuth", checkAuth);
  safe("MultiZone", () => MultiZone.init());
  safe("AutoPanel", () => AutoPanel.init());
  safe("GrafanaPanel", () => GrafanaPanel.init());
  safe("SafetyLimiters", () => SafetyLimiters.init());
  safe("LogsPanel", () => LogsPanel.init());
  safe("PurgePanel", () => PurgePanel.init());
  safe("TrackerPanel", () => TrackerPanel.init());
  safe("UtilisationPanel", () => UtilisationPanel.init());
  safe("CCPanel", () => CCPanel.init());
  safe("CNGValidatorPanel", () => CNGValidatorPanel.init());
  safe("RCAPanel", () => RCAPanel.init());
  safe("ReportPanel", () => ReportPanel.init());

  // Update manual zone display + configure button
  // Mount MultiZone panel in both tabs — same config, shared state
  MultiZone.mount(document.getElementById("autoZonePanel"));
  MultiZone.mount(document.getElementById("manualZonePanel"));
  updateManualZoneDisplay();

  // Re-check single zone visibility whenever MultiZone state changes
  // Use MutationObserver on manualZonePanel to detect re-renders
  const mzObs = new MutationObserver(updateManualZoneDisplay);
  const mzTarget = document.getElementById("manualZonePanel");
  if (mzTarget) mzObs.observe(mzTarget, { childList:true, subtree:true });

  // Also update on tab switch
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => { if (btn.dataset.tab === 'manual') updateManualZoneDisplay(); });
  });
})();
