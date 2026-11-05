// ui/components/cc-dashboard.js
// Cycle Count Operations Control Center — shell only. State, data fetching, the command header,
// left nav, and the investigation drawer live here. Each module's actual content is rendered by
// a same-named global function in cc-modules.js (renderMissionControl, renderAlerts, etc.) so
// this file doesn't balloon into one unmaintainable blob.
//
// All Grafana access goes through background/index.js (CC_FETCH message), reusing the console's
// existing callGrafanaDS (direct fetch, falls back to tab-injection on failure).

const CCPanel = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pctStr = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "—");

  const NAV_ITEMS = [
    { key: "mission", label: "Mission Control", icon: "◈" },
    { key: "alerts", label: "Alerts", icon: "▲" },
    { key: "reconciliation", label: "Reconciliation", icon: "⇄" },
    { key: "ghost", label: "Ghost Inventory", icon: "◌" },
    { key: "operators", label: "Operators", icon: "☺" },
    { key: "stations", label: "Stations", icon: "▦" },
    { key: "analytics", label: "Analytics", icon: "△" },
    { key: "reports", label: "Reports", icon: "▤" },
    { key: "settings", label: "Settings", icon: "⚙" },
  ];
  // Grafana-style quick range list — presetRange() below parses any of these keys generically.
  const QUICK_RANGES = [
    { key: "5m",    label: "Last 5 minutes" },
    { key: "15m",   label: "Last 15 minutes" },
    { key: "30m",   label: "Last 30 minutes" },
    { key: "1h",    label: "Last 1 hour" },
    { key: "3h",    label: "Last 3 hours" },
    { key: "6h",    label: "Last 6 hours" },
    { key: "12h",   label: "Last 12 hours" },
    { key: "24h",   label: "Last 24 hours" },
    { key: "2d",    label: "Last 2 days" },
    { key: "today", label: "Today" },
  ];
  const SETTINGS_KEY = "cc_control_center_settings_v1";
  const DEFAULT_SETTINGS = {
    falseRateWarn: 25, minSample: 5, ghostWarn: 5, pendingWarn: 5, offenderMinCount: 2,
    riskWeights: JSON.parse(JSON.stringify(CC_CLASSIFY.DEFAULT_RISK_WEIGHTS)),
  };

  // ── state ────────────────────────────────────────────────────────────────────
  let activeModule = "mission";
  let lastDiscrepancyRows = [];
  let lastStockCheckRows = [];
  let lastRange = { fromDate: null, toDate: null };
  let currentAnalytics = null;
  let previousAnalytics = null;
  let periodDurationLabel = "period";
  let lastRepeatOffenderSet = new Set();
  let ccSettings = DEFAULT_SETTINGS;
  let lastLoadedAt = null;
  let activeRangeKey = "today";

  let feedTimer = null, tickTimer = null;
  let feedSeenKeys = new Set();
  let feedItems = [];

  // ── time helpers ─────────────────────────────────────────────────────────────
  function toDatetimeLocalValue(date) {
    const pad = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function presetRange(key) {
    const now = new Date(); const to = now; let from;
    if (key === "today") {
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    } else {
      const m = /^(\d+)(m|h|d)$/.exec(key || "");
      const n = m ? Number(m[1]) : 1;
      const unitMs = !m ? 3600000 : m[2] === "m" ? 60000 : m[2] === "h" ? 3600000 : 86400000;
      from = new Date(now.getTime() - n * unitMs);
    }
    return { from, to };
  }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function shortDateTime(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
  function setRange(fromDate, toDate, presetKey) {
    $("ccFromInput").value = toDatetimeLocalValue(fromDate);
    $("ccToInput").value = toDatetimeLocalValue(toDate);
    activeRangeKey = presetKey || null;
    const known = QUICK_RANGES.find(r => r.key === presetKey);
    $("ccRangeLabel").textContent = known ? known.label : `${shortDateTime(fromDate)} → ${shortDateTime(toDate)}`;
    renderQuickList($("ccRangeSearch") ? $("ccRangeSearch").value : "");
  }
  function renderQuickList(filter) {
    const list = $("ccRangeQuickList");
    if (!list) return;
    const f = (filter || "").trim().toLowerCase();
    const items = QUICK_RANGES.filter(r => !f || r.label.toLowerCase().includes(f));
    list.innerHTML = items.length
      ? items.map(r => `<button type="button" class="cc-range-quick-item${r.key === activeRangeKey ? " active" : ""}" data-key="${r.key}">${esc(r.label)}</button>`).join("")
      : `<div class="cc-range-quick-empty">No matches</div>`;
  }
  function openRangePanel() {
    $("ccRangePanel").classList.remove("hidden");
    if ($("ccRangeSearch")) $("ccRangeSearch").value = "";
    renderQuickList("");
  }
  function closeRangePanel() { $("ccRangePanel").classList.add("hidden"); }
  function fmtTime(createTime) {
    const d = CC_CLASSIFY.parseCreateTime(createTime);
    return d ? d.toLocaleString() : "";
  }
  function durationLabelFor(ms) {
    const h = ms / 3600000;
    if (h < 1.5) return "hour";
    if (h <= 30) return `${Math.round(h)}h period`;
    return `${Math.round(h / 24)}d period`;
  }
  function agoLabel(ts) {
    if (!ts) return "never";
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    return `${Math.round(mins / 60)}h ago`;
  }

  // ── settings persistence ────────────────────────────────────────────────────
  async function loadSettings() {
    try {
      const res = await chrome.storage.local.get(SETTINGS_KEY);
      if (res && res[SETTINGS_KEY]) ccSettings = { ...DEFAULT_SETTINGS, ...res[SETTINGS_KEY], riskWeights: { ...DEFAULT_SETTINGS.riskWeights, ...(res[SETTINGS_KEY].riskWeights || {}), base: { ...DEFAULT_SETTINGS.riskWeights.base, ...((res[SETTINGS_KEY].riskWeights || {}).base || {}) } } };
    } catch (e) { console.warn("Failed to load CC settings, using defaults:", e); }
  }
  async function saveSettings(newSettings) {
    ccSettings = newSettings;
    try { await chrome.storage.local.set({ [SETTINGS_KEY]: ccSettings }); } catch (e) { console.warn("Failed to persist CC settings:", e); }
    renderActiveModule();
  }

  // ── fetch + orchestration ───────────────────────────────────────────────────
  async function ccFetch(host, fromMs, toMs) {
    const resp = await chrome.runtime.sendMessage({ type: "CC_FETCH", host, fromMs, toMs });
    if (!resp || !resp.ok) throw new Error((resp && resp.reason) || "CC_FETCH failed");
    return resp;
  }
  function computeAnalyticsBundle(discRows, scRows) {
    const classified = CC_CLASSIFY.reconcile(discRows, scRows);
    const summary = CC_CLASSIFY.summarize(classified);
    const stationStats = CC_CLASSIFY.stationBreakdown(classified);
    const operatorStats = CC_CLASSIFY.operatorBreakdown(classified);
    const offenders = CC_CLASSIFY.repeatedOffenderTotes(discRows, ccSettings.offenderMinCount);
    return { classified, summary, stationStats, operatorStats, offenders };
  }

  async function loadData() {
    const fromDate = new Date($("ccFromInput").value);
    const toDate = new Date($("ccToInput").value);
    if (isNaN(fromDate) || isNaN(toDate) || fromDate >= toDate) { showError("Invalid time range: 'From' must be before 'To'."); return; }

    setLoading(true); hideError(); hideAuthBanner();
    try {
      const cfg = (await chrome.runtime.sendMessage({ type: "GET_CONFIG" }))?.config || {};
      const host = (cfg.grafanaUrl || "https://192.168.24.230").replace(/\/+$/, "");
      const durationMs = toDate.getTime() - fromDate.getTime();
      periodDurationLabel = durationLabelFor(durationMs);

      const resp = await ccFetch(host, fromDate.getTime(), toDate.getTime());
      lastDiscrepancyRows = resp.discrepancyRows || [];
      lastStockCheckRows = resp.stockCheckRows || [];
      lastRange = { fromDate, toDate };

      currentAnalytics = computeAnalyticsBundle(lastDiscrepancyRows, lastStockCheckRows);
      lastRepeatOffenderSet = new Set(currentAnalytics.offenders.map(o => o.container));
      lastLoadedAt = Date.now();

      try {
        const prevFrom = fromDate.getTime() - durationMs, prevTo = fromDate.getTime();
        const prevResp = await ccFetch(host, prevFrom, prevTo);
        previousAnalytics = computeAnalyticsBundle(prevResp.discrepancyRows || [], prevResp.stockCheckRows || []);
      } catch (e) {
        console.warn("Previous-period fetch failed (trend insights will be skipped):", e);
        previousAnalytics = null;
      }

      renderActiveModule();
      updateHeader();
      restartFeedPolling();
    } catch (err) {
      console.error(err);
      const msg = (err && err.message) || String(err);
      if (/grafana_session|log into Grafana|No Grafana tab open/i.test(msg)) showAuthBanner(msg);
      else showError(msg);
      lastDiscrepancyRows = []; lastStockCheckRows = []; currentAnalytics = null; previousAnalytics = null;
      renderActiveModule();
      updateHeader();
    } finally {
      setLoading(false);
    }
  }

  function setLoading(is) { $("ccLoadingIndicator").classList.toggle("hidden", !is); $("ccLoadBtn").disabled = is; }
  function showError(msg) { $("ccErrorBox").textContent = msg; $("ccErrorBox").classList.remove("hidden"); }
  function hideError() { $("ccErrorBox").classList.add("hidden"); }
  function showAuthBanner(msg) {
    $("ccAuthBanner").innerHTML = `Not logged into Grafana (or session expired): ${esc(msg)}. Open Grafana in a tab, log in, then click Load again.`;
    $("ccAuthBanner").classList.remove("hidden");
  }
  function hideAuthBanner() { $("ccAuthBanner").classList.add("hidden"); }

  // ── command header ──────────────────────────────────────────────────────────
  function updateHeader() {
    const critEl = $("ccHdrCritical"), healthEl = $("ccHdrHealth"), accEl = $("ccHdrAccuracy"), riskEl = $("ccHdrRisk"), refreshEl = $("ccHdrRefresh");
    if (!currentAnalytics) {
      [critEl, healthEl, accEl, riskEl].forEach(el => el.textContent = "—");
      refreshEl.textContent = "No data loaded";
      $("ccHealthRing").style.setProperty("--cc-health-pct", "0%");
      $("ccHealthRing").className = "cc-health-ring";
      return;
    }
    const summary = currentAnalytics.summary;
    const health = CC_CLASSIFY.plantHealthScore(summary);
    const accuracyDenom = summary.CORRECTLY_FLAGGED + summary.INCORRECTLY_FLAGGED + summary.CORRECTLY_RELEASED + summary.DATA_MISMATCH;
    const accuracyNum = summary.CORRECTLY_FLAGGED + summary.CORRECTLY_RELEASED;
    const alerts = CC_CLASSIFY.alertQueue(currentAnalytics.classified, lastRepeatOffenderSet, ccSettings.riskWeights);
    const critical = alerts.filter(a => a.risk.category === "Critical").length;
    const avgRisk = alerts.length ? Math.round(alerts.reduce((s, a) => s + a.risk.score, 0) / alerts.length) : 0;

    healthEl.textContent = health.score;
    accEl.textContent = pctStr(accuracyNum, accuracyDenom);
    riskEl.textContent = avgRisk;
    critEl.textContent = critical;
    refreshEl.textContent = `Last refresh: ${agoLabel(lastLoadedAt)}`;

    const ring = $("ccHealthRing");
    ring.style.setProperty("--cc-health-pct", `${health.score}%`);
    ring.className = "cc-health-ring " + (health.score >= 80 ? "cc-tone-good" : health.score >= 55 ? "cc-tone-warn" : "cc-tone-bad");
  }

  // ── module switching ────────────────────────────────────────────────────────
  function buildCtx() {
    return {
      current: currentAnalytics, previous: previousAnalytics,
      discRows: lastDiscrepancyRows, scRows: lastStockCheckRows,
      range: lastRange, periodLabel: periodDurationLabel,
      repeatOffenderSet: lastRepeatOffenderSet, settings: ccSettings,
      esc, fmtTime, pctStr, downloadCsv, openDrawer, saveSettings,
      goToModule: (key, presetSearch) => { if (presetSearch != null) window.__ccPresetSearch = presetSearch; setModule(key); },
    };
  }
  function renderActiveModule() {
    const content = $("ccContent");
    const renderer = window[`render${activeModule[0].toUpperCase()}${activeModule.slice(1)}`];
    if (typeof renderer !== "function") { content.innerHTML = `<div class="cc-empty">Module "${esc(activeModule)}" not implemented.</div>`; return; }
    renderer(content, buildCtx());
  }
  function setModule(key) {
    activeModule = key;
    document.querySelectorAll("#tab-cc .cc-nav-item").forEach(b => b.classList.toggle("active", b.dataset.module === key));
    renderActiveModule();
  }

  // ── investigation drawer (shared across modules) ────────────────────────────
  function formatGap(ms) {
    const mins = ms / 60000;
    if (mins < 60) return `${Math.round(mins)}m`;
    const hrs = mins / 60;
    if (hrs < 48) return `${hrs.toFixed(1)}h`;
    return `${(hrs / 24).toFixed(1)}d`;
  }
  function openDrawer(row) {
    const risk = CC_CLASSIFY.computeRiskScore(row, lastRepeatOffenderSet, ccSettings.riskWeights);
    const reportD = CC_CLASSIFY.parseCreateTime(row.createTime);
    const checkD = row.stockCheckTime != null ? CC_CLASSIFY.parseCreateTime(row.stockCheckTime) : null;
    const gapText = (reportD && checkD) ? formatGap(Math.abs(checkD - reportD)) : "—";
    const isGhost = row.resultKey === "GHOST";

    const timeline = isGhost
      ? `<div class="cc-tl-step"><span class="cc-tl-dot"></span>Stock Check Performed<span class="cc-tl-time">${fmtTime(row.stockCheckTime)}</span></div>
         <div class="cc-tl-note">No Discrepancy Marked event found for this tote in the loaded window — this is the "ghost tote" case.</div>`
      : `<div class="cc-tl-step"><span class="cc-tl-dot"></span>Discrepancy Reported (${esc(row.discrepancyType) || "—"})<span class="cc-tl-time">${fmtTime(row.createTime)}</span></div>
         ${row.stockCheckTime != null
            ? `<div class="cc-tl-arrow">↓ ${gapText} later</div><div class="cc-tl-step"><span class="cc-tl-dot"></span>Stock Check Performed (${esc(row.stockCheckVerdict)})<span class="cc-tl-time">${fmtTime(row.stockCheckTime)}</span></div>`
            : `<div class="cc-tl-arrow">↓</div><div class="cc-tl-step cc-tl-pending"><span class="cc-tl-dot"></span>Stock Check — not yet found in this window</div>`}`;

    $("ccDrawerBody").innerHTML = `
      <div class="cc-drawer-title">Tote ${esc(row.container)} <span class="cc-badge cc-tone-${row.resultTone}">${esc(row.resultLabel)}</span></div>
      <div class="cc-drawer-grid">
        <div><span class="cc-dl">Operator</span><span class="cc-dv">${esc(row.user) || "—"}</span></div>
        <div><span class="cc-dl">Station</span><span class="cc-dv">${esc(row.station) || "—"}</span></div>
        <div><span class="cc-dl">Operation</span><span class="cc-dv">${esc(row.operationType) || "—"}</span></div>
        <div><span class="cc-dl">Marked As</span><span class="cc-dv">${esc(row.discrepancyType) || "—"}</span></div>
        <div><span class="cc-dl">Stock Check Result</span><span class="cc-dv">${esc(row.stockCheckVerdict) || "—"}</span></div>
        <div><span class="cc-dl">SC Counts (A/S/E)</span><span class="cc-dv">${row.stockCheckCounts ? `${row.stockCheckCounts.alright}/${row.stockCheckCounts.short}/${row.stockCheckCounts.excess}` : "—"}</span></div>
        <div><span class="cc-dl">Time to Stock Check</span><span class="cc-dv">${gapText}</span></div>
        <div><span class="cc-dl">Repeat Offender?</span><span class="cc-dv">${lastRepeatOffenderSet.has(row.container) ? "Yes" : "No"}</span></div>
      </div>
      <div class="cc-drawer-section-h">Event Timeline</div>
      <div class="cc-timeline">${timeline}</div>
      <div class="cc-drawer-section-h">Risk Score — ${risk.score} (${risk.category})</div>
      <div class="cc-risk-reasons">${risk.reasons.map(r => `<div>• ${esc(r)}</div>`).join("")}</div>
      <div class="cc-drawer-hint">Not available from current data sources: Barcode, PID, and location/movement history (no matching API yet). This timeline shows only the two events we actually have.</div>
    `;
    $("ccDrawer").classList.add("open");
    $("ccDrawerOverlay").classList.remove("hidden");
  }
  function closeDrawer() { $("ccDrawer").classList.remove("open"); $("ccDrawerOverlay").classList.add("hidden"); }

  // ── shared CSV helper (used by Reconciliation + Reports modules) ───────────
  function downloadCsv(filename, header, rows) {
    const lines = [header.join(",")];
    for (const row of rows) lines.push(row.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  // ── live-ish activity feed (polling, honestly labelled — not push) ─────────
  function feedKey(row) { return `${row.container}|${row.resultKey}|${row.createTime}`; }
  async function feedTick() {
    if (document.visibilityState !== "visible") return;
    try {
      const cfg = (await chrome.runtime.sendMessage({ type: "GET_CONFIG" }))?.config || {};
      const host = (cfg.grafanaUrl || "https://192.168.24.230").replace(/\/+$/, "");
      const now = Date.now();
      const resp = await ccFetch(host, now - 15 * 60000, now);
      const classified = CC_CLASSIFY.reconcile(resp.discrepancyRows || [], resp.stockCheckRows || []);
      const fresh = classified
        .filter(r => !feedSeenKeys.has(feedKey(r)))
        .sort((a, b) => (CC_CLASSIFY.parseCreateTime(b.createTime) || 0) - (CC_CLASSIFY.parseCreateTime(a.createTime) || 0));
      for (const r of fresh) {
        feedSeenKeys.add(feedKey(r));
        feedItems.unshift({ time: r.createTime, text: `${r.container} — ${r.resultLabel}${r.station ? ` @ ${r.station}` : ""}`, tone: r.resultTone });
      }
      feedItems = feedItems.slice(0, 40);
      if (activeModule === "mission") renderActiveModule();
    } catch (e) { /* best-effort */ }
  }
  function restartFeedPolling() {
    if (feedTimer) clearInterval(feedTimer);
    feedSeenKeys = new Set((currentAnalytics ? currentAnalytics.classified : []).map(feedKey));
    feedItems = [];
    feedTimer = setInterval(feedTick, 30000);
  }
  window.__ccGetFeed = () => feedItems; // read by cc-modules.js Mission Control renderer

  // ── render + wire ────────────────────────────────────────────────────────────
  function render(container) {
    container.innerHTML = `
      <style>${CC_STYLES}</style>
      <div class="cc-app">
        <header class="cc-cmd-header">
          <div class="cc-cmd-left">
            <div class="cc-health-ring" id="ccHealthRing"><span id="ccHdrHealth">—</span></div>
            <div class="cc-cmd-title-block">
              <div class="cc-cmd-eyebrow"><span class="cc-live-dot"></span>OPERATIONS CONTROL CENTER</div>
              <div class="cc-cmd-title">Cycle Count Reconciliation</div>
              <div class="cc-cmd-refresh" id="ccHdrRefresh">No data loaded</div>
            </div>
          </div>
          <div class="cc-cmd-stats">
            <div class="cc-cmd-stat"><span class="cc-cmd-stat-v" id="ccHdrAccuracy">—</span><span class="cc-cmd-stat-l">Accuracy</span></div>
            <div class="cc-cmd-stat"><span class="cc-cmd-stat-v" id="ccHdrRisk">—</span><span class="cc-cmd-stat-l">Avg Alert Risk</span></div>
            <div class="cc-cmd-stat cc-cmd-stat-crit" id="ccHdrCriticalBtn"><span class="cc-cmd-stat-v" id="ccHdrCritical">—</span><span class="cc-cmd-stat-l">Critical Alerts</span></div>
          </div>
          <div class="cc-cmd-controls">
            <div class="cc-range-wrap">
              <button type="button" id="ccRangeTrigger" class="cc-range-trigger">
                <span class="cc-range-icon">🕐</span>
                <span id="ccRangeLabel">Today</span>
                <span class="cc-range-chevron">▾</span>
              </button>
              <div id="ccRangePanel" class="cc-range-panel hidden">
                <div class="cc-range-abs">
                  <div class="cc-range-abs-title">Absolute time range</div>
                  <label class="cc-range-field">
                    <span>From</span>
                    <div class="cc-range-input-wrap">
                      <input type="datetime-local" id="ccFromInput" class="cc-range-input" />
                      <span class="cc-range-cal-icon">📅</span>
                    </div>
                  </label>
                  <label class="cc-range-field">
                    <span>To</span>
                    <div class="cc-range-input-wrap">
                      <input type="datetime-local" id="ccToInput" class="cc-range-input" />
                      <span class="cc-range-cal-icon">📅</span>
                    </div>
                  </label>
                  <button type="button" id="ccApplyRangeBtn" class="cc-range-apply">Apply time range</button>
                  <div class="cc-range-hint">Pick any custom From / To, or choose a quick range on the right.</div>
                </div>
                <div class="cc-range-quick">
                  <div class="cc-range-search-wrap">
                    <span class="cc-range-search-icon">🔍</span>
                    <input type="text" id="ccRangeSearch" class="cc-range-search" placeholder="Search quick ranges" />
                  </div>
                  <div class="cc-range-quick-list" id="ccRangeQuickList"></div>
                </div>
              </div>
            </div>
            <button id="ccLoadBtn" class="cc-btn cc-btn-primary">Load</button>
            <span id="ccLoadingIndicator" class="cc-loading hidden">Loading…</span>
          </div>
        </header>

        <div id="ccAuthBanner" class="cc-auth-banner hidden"></div>
        <div id="ccErrorBox" class="cc-error hidden"></div>

        <div class="cc-body">
          <nav class="cc-nav" id="ccNav">
            ${NAV_ITEMS.map(n => `<button class="cc-nav-item${n.key === "mission" ? " active" : ""}" data-module="${n.key}"><span class="cc-nav-icon">${n.icon}</span>${n.label}</button>`).join("")}
          </nav>
          <main class="cc-content" id="ccContent">
            <div class="cc-empty">Click "Load" to populate the Control Center.</div>
          </main>
        </div>
      </div>

      <div id="ccDrawerOverlay" class="cc-drawer-overlay hidden"></div>
      <div id="ccDrawer" class="cc-drawer">
        <button id="ccDrawerCloseBtn" class="cc-drawer-close">✕</button>
        <div id="ccDrawerBody"></div>
      </div>
    `;
  }

  function wire() {
    $("ccNav").addEventListener("click", e => {
      const btn = e.target.closest(".cc-nav-item"); if (!btn) return;
      setModule(btn.dataset.module);
    });
    $("ccHdrCriticalBtn").addEventListener("click", () => setModule("alerts"));

    $("ccRangeTrigger").addEventListener("click", (e) => {
      e.stopPropagation();
      $("ccRangePanel").classList.contains("hidden") ? openRangePanel() : closeRangePanel();
    });
    $("ccRangePanel").addEventListener("click", e => e.stopPropagation());
    document.addEventListener("click", () => {
      if (!$("ccRangePanel").classList.contains("hidden")) closeRangePanel();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeRangePanel(); });

    $("ccRangeQuickList").addEventListener("click", (e) => {
      const btn = e.target.closest(".cc-range-quick-item"); if (!btn) return;
      const { from, to } = presetRange(btn.dataset.key);
      setRange(from, to, btn.dataset.key);
      closeRangePanel();
      loadData();
    });
    $("ccRangeSearch").addEventListener("input", (e) => renderQuickList(e.target.value));
    $("ccApplyRangeBtn").addEventListener("click", () => {
      const fromDate = new Date($("ccFromInput").value);
      const toDate = new Date($("ccToInput").value);
      if (isNaN(fromDate) || isNaN(toDate) || fromDate >= toDate) { showError("Invalid time range: 'From' must be before 'To'."); return; }
      setRange(fromDate, toDate, null);
      closeRangePanel();
      loadData();
    });
    [$("ccFromInput"), $("ccToInput")].forEach(input => input.addEventListener("change", () => {
      activeRangeKey = null;
      renderQuickList($("ccRangeSearch") ? $("ccRangeSearch").value : "");
    }));
    $("ccLoadBtn").addEventListener("click", loadData);

    $("ccDrawerCloseBtn").addEventListener("click", closeDrawer);
    $("ccDrawerOverlay").addEventListener("click", closeDrawer);
  }

  function init() {
    const container = $("tab-cc");
    if (!container) return;
    loadSettings().then(() => {
      render(container);
      wire();
      const { from, to } = presetRange("today");
      setRange(from, to, "today");
      loadData();
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = setInterval(updateHeader, 15000); // ticks the "last refresh: Xm ago" label
    });
  }

  return { init };
})();
