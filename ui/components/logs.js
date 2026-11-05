// ui/components/logs.js — Enterprise Logs Tab Controller

const LogsPanel = (() => {
  const $ = id => document.getElementById(id);

  // ── State ───────────────────────────────────────────────────────────────────
  let _allLogs    = [];   // full dataset from background
  let _filtered   = [];   // after search + filter applied
  let _page       = 0;
  const PAGE_SIZE = 100;

  let _activeFilter   = "all";
  let _searchQuery    = "";
  let _modeFilter     = "";
  let _priorityFilter = "";

  // ── Level display config ────────────────────────────────────────────────────
  const LEVEL_CONFIG = {
    op_ok:   { badge:"✅", cls:"lbadge-ok",      label:"Called"   },
    op_warn: { badge:"⚠",  cls:"lbadge-warn",    label:"Notice"   },
    op_err:  { badge:"❌",  cls:"lbadge-err",     label:"N/A"      },
    net_err: { badge:"🔴",  cls:"lbadge-net",     label:"Network"  },
    ignored: { badge:"🕐",  cls:"lbadge-ignored", label:"Ignored"  },
    skipped: { badge:"⏭",  cls:"lbadge-skipped", label:"Skipped"  },
    info:    { badge:"ℹ",  cls:"lbadge-info",    label:"System"   },
    warn:    { badge:"⚠",  cls:"lbadge-sysw",    label:"Warning"  },
    debug:   { badge:"🔍",  cls:"lbadge-debug",   label:"Debug"    },
  };

  const PRIORITY_BADGE = {
    P0: "pbadge-p0",
    P1: "pbadge-p1",
    P2: "pbadge-p2",
  };

  // ── Fetch logs from background ──────────────────────────────────────────────
  async function loadLogs() {
    showLoading(true);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "SEARCH_LOGS",
        filters: { limit: 5000 }, // fetch last 5000, filter in UI
      });
      _allLogs = (resp && resp.logs) ? resp.logs : [];
      applyFilters();
      updateStats();
    } catch(e) {
      console.error("[QTP Logs] Load failed:", e);
    } finally {
      showLoading(false);
    }
  }

  // ── Filtering & search ──────────────────────────────────────────────────────
  function applyFilters() {
    let logs = [..._allLogs];

    // Level filter
    if (_activeFilter !== "all") {
      logs = logs.filter(e => e.level === _activeFilter);
    }

    // Mode filter
    if (_modeFilter) {
      logs = logs.filter(e => e.mode === _modeFilter);
    }

    // Priority filter
    if (_priorityFilter) {
      logs = logs.filter(e => e.priority === _priorityFilter);
    }

    // Search query — matches toteId, zone, message, apiMsg
    if (_searchQuery) {
      const q = _searchQuery.toLowerCase();
      logs = logs.filter(e =>
        (e.toteId   && e.toteId.toLowerCase().includes(q))   ||
        (e.message  && e.message.toLowerCase().includes(q))  ||
        (e.zone     && e.zone.toLowerCase().includes(q))     ||
        (e.apiMsg   && e.apiMsg.toLowerCase().includes(q))   ||
        (e.condition && e.condition.toLowerCase().includes(q))
      );
    }

    _filtered = logs; // already newest-first from background
    _page = 0;
    renderTable();
    updateFooter();
  }

  // ── Render table ─────────────────────────────────────────────────────────────
  function renderTable() {
    const tbody = $("logsTableBody");
    const empty = $("logsEmpty");
    if (!tbody) return;

    const start  = _page * PAGE_SIZE;
    const slice  = _filtered.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = "";

    if (_filtered.length === 0) {
      if (empty) empty.style.display = "";
      return;
    }
    if (empty) empty.style.display = "none";

    const frag = document.createDocumentFragment();

    for (const e of slice) {
      const tr   = document.createElement("tr");
      const lcfg = LEVEL_CONFIG[e.level] || { badge:"•", cls:"lbadge-info", label:e.level };
      const pcls = e.priority ? (PRIORITY_BADGE[e.priority] || "") : "";

      tr.className = "log-row log-row-" + (e.level || "info");
      tr.innerHTML =
        `<td class="lc-time">${QTP_UTILS.formatTime(e.t)}</td>` +
        `<td class="lc-level"><span class="lbadge ${lcfg.cls}">${lcfg.badge} ${lcfg.label}</span></td>` +
        `<td class="lc-tote">${escHtml(e.toteId || "—")}</td>` +
        `<td class="lc-zone">${escHtml(e.zone   || "—")}</td>` +
        `<td class="lc-pri">${e.priority ? `<span class="lpbadge ${pcls}">${e.priority}</span>` : "—"}</td>` +
        `<td class="lc-mode">${e.mode ? `<span class="lmode-badge lmode-${e.mode}">${e.mode}</span>` : "—"}</td>` +
        `<td class="lc-msg"><span class="lmsg">${escHtml(e.message || "")}</span>${e.apiMsg ? `<span class="lapimsg">${escHtml(e.apiMsg)}</span>` : ""}</td>`;

      frag.appendChild(tr);
    }

    tbody.appendChild(frag);
  }

  // ── Stats bar ────────────────────────────────────────────────────────────────
  function updateStats() {
    const count = level => _allLogs.filter(e => e.level === level).length;
    setText("logStatTotal",   _allLogs.length);
    setText("logStatOk",      count("op_ok"));
    setText("logStatWarn",    count("op_warn"));
    setText("logStatErr",     count("op_err"));
    setText("logStatNet",     count("net_err"));
    setText("logStatIgnored", count("ignored"));
    setText("logStatSkipped", count("skipped"));

    // Update tab badge count
    const badge = document.getElementById("logsCount");
    if (badge) badge.textContent = _allLogs.length;
  }

  // ── Footer / pagination ───────────────────────────────────────────────────────
  function updateFooter() {
    const total  = _filtered.length;
    const start  = _page * PAGE_SIZE + 1;
    const end    = Math.min((_page + 1) * PAGE_SIZE, total);
    const pages  = Math.ceil(total / PAGE_SIZE) || 1;

    setText("logsShowing",   total === 0 ? "No entries" : `Showing ${start}–${end} of ${total}`);
    setText("logsPageLabel", `Page ${_page + 1} of ${pages}`);
    setText("logsTotalCount","");

    const prev = $("logsPrevBtn");
    const next = $("logsNextBtn");
    if (prev) prev.disabled = _page === 0;
    if (next) next.disabled = (_page + 1) * PAGE_SIZE >= total;
  }

  // ── Export ────────────────────────────────────────────────────────────────────
  async function exportCSV() {
    const resp = await chrome.runtime.sendMessage({ type: "EXPORT_LOGS_CSV" });
    if (!resp || !resp.csv) return;
    downloadFile(resp.csv, `qtp-logs-${dateStamp()}.csv`, "text/csv");
  }

  async function exportJSON() {
    const logs = _filtered.length ? _filtered : _allLogs;
    const out = {
      exportedAt: new Date().toISOString(),
      totalEntries: logs.length,
      filters: { level:_activeFilter, mode:_modeFilter, priority:_priorityFilter, search:_searchQuery },
      entries: logs.map(e => ({ ...e, timestampHuman: QTP_UTILS.formatDateTime(e.t) })),
    };
    downloadFile(JSON.stringify(out, null, 2), `qtp-logs-${dateStamp()}.json`, "application/json");
  }

  function downloadFile(content, filename, mime) {
    const a = Object.assign(document.createElement("a"), {
      href:     URL.createObjectURL(new Blob([content], { type: mime })),
      download: filename,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function dateStamp() {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function setText(id, val) { const el = $(id); if (el) el.textContent = val; }
  function showLoading(show) {
    const el = $("logsLoading");
    if (el) el.style.display = show ? "" : "none";
  }

  // ── Wire up events ────────────────────────────────────────────────────────────
  function init() {
    // Filter buttons
    document.querySelectorAll(".log-filter-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".log-filter-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        _activeFilter = btn.dataset.filter || "all";
        _page = 0;
        applyFilters();
      });
    });

    // Search input — debounced
    // "Debounce" = wait until user stops typing before running the search
    let searchTimer = null;
    $("logSearch")?.addEventListener("input", e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        _searchQuery = e.target.value.trim();
        _page = 0;
        applyFilters();
      }, 250);
    });

    $("logSearchClear")?.addEventListener("click", () => {
      const inp = $("logSearch");
      if (inp) inp.value = "";
      _searchQuery = "";
      _page = 0;
      applyFilters();
    });

    // Dropdown filters
    $("logModeFilter")?.addEventListener("change", e => {
      _modeFilter = e.target.value;
      _page = 0;
      applyFilters();
    });

    $("logPriorityFilter")?.addEventListener("change", e => {
      _priorityFilter = e.target.value;
      _page = 0;
      applyFilters();
    });

    // Pagination
    $("logsPrevBtn")?.addEventListener("click", () => {
      if (_page > 0) { _page--; renderTable(); updateFooter(); scrollToTop(); }
    });
    $("logsNextBtn")?.addEventListener("click", () => {
      if ((_page + 1) * PAGE_SIZE < _filtered.length) { _page++; renderTable(); updateFooter(); scrollToTop(); }
    });

    function scrollToTop() {
      const wrap = $("logsTableWrap");
      if (wrap) wrap.scrollTop = 0;
    }

    // Refresh button
    $("logRefreshBtn")?.addEventListener("click", loadLogs);

    // Export
    $("logExportCsvBtn")?.addEventListener("click",  exportCSV);
    $("logExportJsonBtn")?.addEventListener("click", exportJSON);

    // Clear all
    $("logClearBtn")?.addEventListener("click", async () => {
      if (!confirm("Clear ALL log entries? This cannot be undone.")) return;
      await chrome.runtime.sendMessage({ type: "CLEAR_ALL_LOGS" });
      _allLogs = []; _filtered = [];
      renderTable(); updateStats(); updateFooter();
    });

    // Listen for live updates — refresh when new log entries arrive
    chrome.runtime.onMessage.addListener(msg => {
      if (msg && (msg.type === "STATE_UPDATE" || msg.type === "AUTO_STATE_UPDATE")) {
        // Only reload if Logs tab is active
        const logsTab = document.getElementById("tab-logs");
        if (logsTab && logsTab.classList.contains("active")) {
          loadLogs();
        } else {
          // Just update the count badge
          chrome.runtime.sendMessage({ type: "SEARCH_LOGS", filters: { limit: 1 } })
            .then(resp => {
              // We don't get total from this — just trigger a background count update
            }).catch(() => {});
        }
      }
    });

    // Load on tab switch
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.tab === "logs") {
          loadLogs();
        }
      });
    });

    // Initial load
    loadLogs();
  }

  return { init, loadLogs };
})();
