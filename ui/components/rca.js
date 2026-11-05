// ui/components/rca.js
// Supervisor Dashboard RCA tab — Time Category and Type are chosen BEFORE
// running; those two selections are sent to the background worker, which
// builds a SQL query that only pulls matching rows from Grafana (see
// buildRcaSql in background/index.js). Nothing is fetched-then-discarded —
// the query itself is scoped. RCA classification (No Inventory / Bin Blocked
// / Locked / Shuttle Offline / GTP In Transit / Outside Tote / Unclassified)
// runs on whatever comes back and lives in background/index.js (RCA_RULES).
//
// Time Category (multi-select) — fixed 5 buckets from SQL_SUPERVISOR's CASE
//   statement. Defaults to everything except "0-1 hours".
// Type (multi-select) — station `type` column. Fixed list below, confirmed
//   against a real dump on 2026-07-27; add a new value here if a station
//   type shows up that isn't in this list.
// RCA Reason — set by clicking a summary pill AFTER a run (this one filters
//   the already-fetched result client-side, since it can't be pushed into SQL).
//
// Changing Time Category / Type only takes effect on the NEXT "Run RCA" —
// they're query inputs, not a live display filter on already-fetched rows.

const RCAPanel = (() => {
  const $ = id => document.getElementById(id);

  let _allRows = [];
  let _rows = [];
  let _running = false;
  let _hasRun = false;       // false = never fetched yet, distinct from "fetched but got 0 rows"
  let _activeReason = "ALL"; // set by clicking a summary pill, applied client-side after fetch
  let _viewMode = "item";    // "item" = one row per fetched row, "tote" = grouped by unique tote ID

  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Grafana's JSON API mislabels naive IST scan_time as UTC when serializing
  // to epoch-ms — confirmed live on 2026-07-27 (user's clock 6:20 PM matched
  // raw values corrected by -5:30, not the raw values themselves). Must stay
  // in sync with the identical fix in background/index.js's rcaToMs().
  const GRAFANA_SCAN_TIME_TZ_FIX_MS = 5.5 * 3600000;
  const fmt = v => {
    const n = Number(v);
    const ms = !isNaN(n) && n > 1e10 ? (n - GRAFANA_SCAN_TIME_TZ_FIX_MS) : Date.parse(v);
    return isNaN(ms) ? (v == null ? "" : String(v)) : new Date(ms).toLocaleString();
  };

  const RCA_REASONS = [
    { code: "NO_INVENTORY",    label: "No Inventory",    cls: "noinv"   },
    { code: "BIN_BLOCKED",     label: "Bin Blocked",     cls: "binblk"  },
    { code: "LOCKED",          label: "Locked",          cls: "locked"  },
    { code: "SHUTTLE_OFFLINE", label: "Shuttle Offline", cls: "offline" },
    { code: "TNFT",            label: "TNFT",            cls: "tnft"    },
    { code: "GTP_TRANSIT",     label: "GTP In Transit",  cls: "gtp"     },
    { code: "OUTSIDE_TOTE",    label: "Outside Tote",    cls: "outside" },
    { code: "UNCLASSIFIED",    label: "Unclassified",    cls: "unclass" },
  ];
  const RCA_CLS = Object.fromEntries(RCA_REASONS.map(t => [t.code, t.cls]));
  const badge = r => r ? `<span class="rca-badge ${RCA_CLS[r.rcaCode] || "unclass"}">${esc(r.rcaLabel)}</span>` : "";

  const TIME_OPTIONS = ["0-1 hours", "1-2 hours", "2-3 hours", "3-4 hours", ">4 hours"];
  const TIME_DEFAULT = new Set(TIME_OPTIONS.filter(t => t !== "0-1 hours"));

  // Confirmed against a real Supervisor Dashboard dump (2026-07-27): ADHOC,
  // BULK, FR0, FR01, JIT, PARTIAL_PICK, QC_FAIL. Add new codes here if they
  // start appearing in the data.
  const TYPE_OPTIONS = ["ADHOC", "BULK", "FR0", "FR01", "JIT", "PARTIAL_PICK", "QC_FAIL"];
  const TYPE_DEFAULT = new Set(TYPE_OPTIONS);

  // ── Generic multi-select dropdown (button + checkbox panel) ────────────────
  function mselMarkup(id, label, options, checkedSet) {
    return `
      <div class="rca-field">
        <label>${esc(label)}</label>
        <div class="rca-msel" data-msel-root="${id}">
          <button type="button" class="rca-msel-btn" data-msel-btn="${id}">All</button>
          <div class="rca-msel-panel" data-msel-panel="${id}" hidden>
            <div class="rca-msel-actions">
              <button type="button" data-msel-all="${id}">All</button>
              <button type="button" data-msel-none="${id}">None</button>
            </div>
            <div data-msel-opts="${id}">${mselOptsHtml(id, options, checkedSet)}</div>
          </div>
        </div>
      </div>`;
  }
  function mselOptsHtml(id, options, checkedSet) {
    return options.map(o => `<label class="rca-msel-opt"><input type="checkbox" data-msel-cb="${id}" value="${esc(o)}" ${checkedSet.has(o) ? "checked" : ""}/> ${esc(o)}</label>`).join("");
  }
  function mselGetSelected(id) {
    return new Set([...document.querySelectorAll(`[data-msel-cb="${id}"]:checked`)].map(cb => cb.value));
  }
  function mselSetLabel(id) {
    const btn = document.querySelector(`[data-msel-btn="${id}"]`);
    if (!btn) return;
    const cbs = document.querySelectorAll(`[data-msel-cb="${id}"]`);
    const sel = document.querySelectorAll(`[data-msel-cb="${id}"]:checked`).length;
    btn.textContent = cbs.length === 0 ? "All" : sel === cbs.length ? "All" : sel === 0 ? "None" : `${sel} selected`;
  }
  function mselWire(id, onChange) {
    const root = document.querySelector(`[data-msel-root="${id}"]`);
    if (!root) return;
    const btn = root.querySelector(`[data-msel-btn="${id}"]`);
    const panel = root.querySelector(`[data-msel-panel="${id}"]`);
    btn.addEventListener("click", e => { e.stopPropagation(); document.querySelectorAll(".rca-msel-panel").forEach(p => { if (p !== panel) p.hidden = true; }); panel.hidden = !panel.hidden; });
    panel.addEventListener("click", e => e.stopPropagation());
    root.querySelector(`[data-msel-all="${id}"]`).addEventListener("click", () => { root.querySelectorAll(`[data-msel-cb="${id}"]`).forEach(cb => cb.checked = true); mselSetLabel(id); onChange(); });
    root.querySelector(`[data-msel-none="${id}"]`).addEventListener("click", () => { root.querySelectorAll(`[data-msel-cb="${id}"]`).forEach(cb => cb.checked = false); mselSetLabel(id); onChange(); });
    root.addEventListener("change", e => { if (e.target.matches(`[data-msel-cb="${id}"]`)) { mselSetLabel(id); onChange(); } });
  }

  function render(container) {
    container.innerHTML = `
      <style>
        #tab-rca .rca-controls{display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px}
        #tab-rca .rca-field{display:flex;flex-direction:column;gap:4px}
        #tab-rca .rca-field label{font-size:11px;color:var(--muted,#8b949e);text-transform:uppercase;letter-spacing:.03em}
        #tab-rca select{font-size:13px}
        #tab-rca .rca-status{color:var(--muted,#8b949e);font-size:12px}
        #tab-rca .rca-msel{position:relative}
        #tab-rca .rca-msel-btn{background:#161b22;border:1px solid var(--line,#2a313c);color:var(--text,#e6edf3);border-radius:6px;padding:6px 10px;font-size:13px;cursor:pointer;min-width:140px;text-align:left}
        #tab-rca .rca-msel-btn:hover{border-color:var(--accent,#7aa2f7)}
        #tab-rca .rca-msel-panel{position:absolute;top:calc(100% + 4px);left:0;z-index:10;background:#1b2230;border:1px solid var(--line,#2a313c);border-radius:8px;padding:6px;min-width:180px;max-height:240px;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.4)}
        #tab-rca .rca-msel-actions{display:flex;gap:6px;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid var(--line,#2a313c)}
        #tab-rca .rca-msel-actions button{flex:1;background:#21262d;border:1px solid var(--line,#2a313c);color:var(--text,#e6edf3);border-radius:5px;padding:4px 0;font-size:11px;cursor:pointer}
        #tab-rca .rca-msel-actions button:hover{border-color:var(--accent,#7aa2f7)}
        #tab-rca .rca-msel-opt{display:flex;align-items:center;gap:6px;padding:4px 6px;font-size:12px;border-radius:5px;cursor:pointer;white-space:nowrap}
        #tab-rca .rca-msel-opt:hover{background:rgba(255,255,255,.04)}
        #tab-rca .rca-sum{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
        #tab-rca .rca-sum-pill{border:1px solid var(--line,#2a313c);border-radius:10px;padding:8px 14px;cursor:pointer;user-select:none;min-width:110px}
        #tab-rca .rca-sum-pill:hover{border-color:var(--accent,#7aa2f7)}
        #tab-rca .rca-sum-pill.active{border-color:var(--accent,#7aa2f7);background:rgba(122,162,247,.08)}
        #tab-rca .rca-sum-label{display:block;font-size:11px;color:var(--muted,#8b949e)}
        #tab-rca .rca-sum-val{display:block;font-size:18px;font-weight:700;font-family:ui-monospace,Menlo,monospace}
        #tab-rca .rca-tablewrap{overflow:auto;border:1px solid var(--line,#2a313c);border-radius:10px;max-height:64vh}
        #tab-rca table.rca-table{border-collapse:collapse;width:100%;font-size:12px;white-space:nowrap}
        #tab-rca table.rca-table th,#tab-rca table.rca-table td{padding:7px 9px;border-bottom:1px solid var(--line,#2a313c);text-align:left;vertical-align:top}
        #tab-rca table.rca-table thead th{position:sticky;top:0;background:#1b2230;z-index:1;font-weight:600;color:var(--muted,#8b949e)}
        #tab-rca td.rca-raw{max-width:260px;white-space:normal;word-break:break-all;color:var(--muted,#8b949e);font-family:ui-monospace,Menlo,monospace;font-size:11px}
        #tab-rca .rca-badge{padding:2px 9px;border-radius:11px;font-size:11px;font-weight:600;display:inline-block;white-space:nowrap}
        #tab-rca .rca-badge.noinv{background:#3a1115;color:#ff7b72}
        #tab-rca .rca-badge.binblk{background:#3a1115;color:#ff7b72}
        #tab-rca .rca-badge.locked{background:#3a2e10;color:#e3b341}
        #tab-rca .rca-badge.offline{background:#3a1115;color:#ff7b72}
        #tab-rca .rca-badge.tnft{background:#0f3a1f;color:#56d364}
        #tab-rca .rca-badge.gtp{background:#10283a;color:#79c0ff}
        #tab-rca .rca-badge.outside{background:#241b3a;color:#d2a8ff}
        #tab-rca .rca-badge.unclass{background:#21262d;color:#8b949e}
        #tab-rca .rca-toggle{display:flex;border:1px solid var(--line,#2a313c);border-radius:6px;overflow:hidden}
        #tab-rca .rca-toggle button{background:#161b22;border:none;color:var(--muted,#8b949e);padding:6px 12px;font-size:13px;cursor:pointer}
        #tab-rca .rca-toggle button:not(:last-child){border-right:1px solid var(--line,#2a313c)}
        #tab-rca .rca-toggle button.active{background:var(--accent,#7aa2f7);color:#0d1117;font-weight:600}
      </style>

      <div class="card">
        <div class="card-title">🩺 Supervisor Dashboard RCA</div>
        <p class="purge-sub" style="margin-bottom:12px">Pick Time Category & Type, then Run — the query only pulls matching rows from Grafana. Read-only.</p>

        <div class="rca-controls">
          <input id="rcaHost" type="hidden" />
          <button id="rcaRunBtn" class="btn primary">▶ Run RCA</button>
          ${mselMarkup("rcaTimeMsel", "Time Category", TIME_OPTIONS, TIME_DEFAULT)}
          ${mselMarkup("rcaTypeMsel", "Type", TYPE_OPTIONS, TYPE_DEFAULT)}
          <div class="rca-field">
            <label>View</label>
            <div class="rca-toggle" id="rcaViewToggle">
              <button type="button" data-view="item" class="active">By Item</button>
              <button type="button" data-view="tote">By Unique Tote</button>
            </div>
          </div>
          <button id="rcaCsvBtn" class="btn ghost subtle">⬇ Export CSV</button>
          <span class="rca-status" id="rcaStatus"></span>
        </div>

        <div class="rca-sum" id="rcaSum"></div>
      </div>

      <div class="card">
        <div class="rca-tablewrap">
          <table class="rca-table">
            <thead id="rcaThead"></thead>
            <tbody id="rcaBody"></tbody>
          </table>
        </div>
      </div>`;
  }

  function status(msg) { const el = $("rcaStatus"); if (el) el.textContent = msg || ""; }

  function renderSummary() {
    const scope = _allRows; // already Time Category / Type filtered server-side
    const counts = Object.fromEntries(RCA_REASONS.map(t => [t.code, 0]));
    let total;
    if (_viewMode === "tote") {
      const groups = groupByTote(scope);
      groups.forEach(g => { if (counts[g.rcaCode] != null) counts[g.rcaCode]++; });
      total = groups.length;
    } else {
      scope.forEach(r => { if (counts[r.rcaCode] != null) counts[r.rcaCode]++; });
      total = scope.length;
    }
    const totalLabel = _viewMode === "tote" ? "Total Totes" : "Total";
    const pills = [
      `<div class="rca-sum-pill${_activeReason === "ALL" ? " active" : ""}" data-code="ALL"><span class="rca-sum-label">${totalLabel}</span><span class="rca-sum-val">${total}</span></div>`,
      ...RCA_REASONS.map(t => `<div class="rca-sum-pill${_activeReason === t.code ? " active" : ""}" data-code="${t.code}"><span class="rca-sum-label">${esc(t.label)}</span><span class="rca-sum-val">${counts[t.code]}</span></div>`),
    ];
    $("rcaSum").innerHTML = pills.join("");
    $("rcaSum").querySelectorAll(".rca-sum-pill").forEach(p => {
      p.addEventListener("click", () => { _activeReason = p.dataset.code; applyFilters(); });
    });
  }

  // Rolls item-level rows up into one row per unique tote — many order lines
  // often share the same physical tote (same location, same containerStatus,
  // same scan), so this tells you how many DISTINCT totes actually need
  // attention rather than how many order lines are affected. RCA is taken
  // from the first item in each group since it's derived from tote-level
  // fields (location/status/scan), which are identical across the group.
  function groupByTote(rows) {
    const map = new Map();
    for (const r of rows) {
      const key = (r.resolvedTote || r.tote || "").trim().toUpperCase() || "(no tote id)";
      if (!map.has(key)) map.set(key, { tote: key, items: [], stations: new Set(), skus: new Set(), orderIds: new Set(), fittingIds: [] });
      const g = map.get(key);
      g.items.push(r);
      if (r.stationId) g.stations.add(r.stationId);
      if (r.sku) g.skus.add(r.sku);
      if (r.orderId) g.orderIds.add(r.orderId);
      if (r.fittingId) g.fittingIds.push(r.fittingId);
    }
    return [...map.values()].map(g => {
      const first = g.items[0];
      return {
        tote: g.tote, itemCount: g.items.length,
        stationCount: g.stations.size, stations: [...g.stations].join(", "),
        skuCount: g.skus.size, orderCount: g.orderIds.size,
        fittingIds: g.fittingIds.join(", "),
        timeCategory: first.timeCategory, scanTime: first.scanTime,
        containerStatus: first.containerStatus, inventoryBorrower: first.inventoryBorrower,
        rcaCode: first.rcaCode, rcaLabel: first.rcaLabel,
      };
    }).sort((a, b) => b.itemCount - a.itemCount); // totes affecting the most order lines first
  }

  function renderTableHead() {
    const thead = $("rcaThead");
    if (!thead) return;
    thead.innerHTML = _viewMode === "tote"
      ? `<tr><th>Tote</th><th># Items</th><th># Stations</th><th># SKUs</th><th># Orders</th>
           <th>Time Cat.</th><th>Scan Time</th><th>Container Status (raw)</th>
           <th>Inventory/Borrower (raw)</th><th>RCA</th></tr>`
      : `<tr><th>Station</th><th>Slot</th><th>Fitting ID</th><th>Type</th><th>Time Cat.</th>
           <th>Wave</th><th>Order ID</th><th>Priority</th><th>Min Elapsed</th><th>SKU</th>
           <th>Tote</th><th>Scanner</th><th>Scan Time</th><th>Scan Time (raw)</th><th>Container Status (raw)</th>
           <th>Queue Tote (raw)</th><th>Inventory/Borrower (raw)</th><th>Qty Left</th><th>RCA</th></tr>`;
  }

  function renderTable() {
    const tb = $("rcaBody");
    if (!tb) return;
    renderTableHead();
    const colCount = _viewMode === "tote" ? 10 : 19;
    if (!_rows.length) {
      const msg = !_hasRun ? "Not run yet — pick Time Category & Type above, then click ▶ Run RCA."
        : !_allRows.length ? "Fetched OK, but 0 rows matched your Time Category / Type selection."
        : "No rows match the current RCA Reason — click a different pill above, or Total to see all.";
      tb.innerHTML = `<tr><td colspan="${colCount}" class="purge-empty">${esc(msg)}</td></tr>`;
      return;
    }
    if (_viewMode === "tote") {
      tb.innerHTML = groupByTote(_rows).map(g => `<tr>
        <td>${esc(g.tote)}</td><td>${g.itemCount}</td><td>${g.stationCount}</td><td>${g.skuCount}</td><td>${g.orderCount}</td>
        <td>${esc(g.timeCategory)}</td><td>${fmt(g.scanTime)}</td>
        <td class="rca-raw">${esc(g.containerStatus)}</td><td class="rca-raw">${esc(g.inventoryBorrower)}</td>
        <td>${badge(g)}</td>
      </tr>`).join("");
      return;
    }
    tb.innerHTML = _rows.map(r => `<tr>
      <td>${esc(r.stationId)}</td><td>${esc(r.slot)}</td><td>${esc(r.fittingId)}</td><td>${esc(r.type)}</td>
      <td>${esc(r.timeCategory)}</td><td>${esc(r.wave)}</td><td>${esc(r.orderId)}</td><td>${esc(r.priority)}</td>
      <td>${esc(r.minutesElapsed)}</td><td>${esc(r.sku)}</td><td>${esc(r.resolvedTote || r.tote)}</td>
      <td>${esc(r.scanner)}</td><td>${fmt(r.scanTime)}</td><td class="rca-raw">${esc(r.scanTime)}</td>
      <td class="rca-raw">${esc(r.containerStatus)}</td><td class="rca-raw">${esc(r.queueTote)}</td>
      <td class="rca-raw">${esc(r.inventoryBorrower)}</td>
      <td>${esc(r.quantityLeft)}</td><td>${badge(r)}</td>
    </tr>`).join("");
  }

  function applyFilters() {
    _rows = _activeReason === "ALL" ? _allRows : _allRows.filter(r => r.rcaCode === _activeReason);
    renderSummary();
    renderTable();
  }

  async function run() {
    if (_running) return;
    const times = [...mselGetSelected("rcaTimeMsel")];
    const types = [...mselGetSelected("rcaTypeMsel")];
    if (!times.length) { status("Select at least one Time Category before running."); return; }
    if (!types.length) { status("Select at least one Type before running."); return; }

    const host = ($("rcaHost").value || "").trim().replace(/\/+$/, "");
    _running = true;
    const btn = $("rcaRunBtn"); if (btn) { btn.disabled = true; btn.textContent = "Running…"; }
    status(`Fetching Supervisor Dashboard for ${times.length} time bucket(s), ${types.length} type(s)…`);

    let resp;
    try { resp = await chrome.runtime.sendMessage({ type: "RCA_RUN", host, timeCategories: times, types }); }
    catch (e) { resp = { ok: false, reason: e.message || String(e) }; }

    _running = false;
    if (btn) { btn.disabled = false; btn.textContent = "▶ Run RCA"; }

    if (!resp || !resp.ok) { status("Failed: " + ((resp && resp.reason) || "unknown error")); return; }
    _hasRun = true;
    _allRows = resp.rows || [];
    _activeReason = "ALL"; // reset the reason filter for this fresh result set

    applyFilters();
    status(_allRows.length
      ? `Done — ${_allRows.length} row(s) fetched (already scoped to your Time Category / Type selection) · ${_rows.length} shown`
      : "Fetch succeeded but 0 rows matched your Time Category / Type selection.");
  }

  function exportCsv() {
    if (!_rows.length) return;
    const cell = v => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    let head, lines;
    if (_viewMode === "tote") {
      head = ["Tote","ItemCount","StationCount","SkuCount","OrderCount","TimeCategory","ScanTime","ContainerStatusRaw","InventoryBorrowerRaw","RCA","FittingIDs"];
      lines = [head.join(",")];
      groupByTote(_rows).forEach(g => {
        lines.push([g.tote, g.itemCount, g.stationCount, g.skuCount, g.orderCount, g.timeCategory,
          fmt(g.scanTime), g.containerStatus, g.inventoryBorrower, g.rcaLabel, g.fittingIds].map(cell).join(","));
      });
    } else {
      head = ["Station","Slot","FittingID","Type","TimeCategory","Wave","OrderID","Priority","MinutesElapsed","SKU","Tote","Scanner","ScanTime","ScanTimeRaw","ContainerStatusRaw","QueueToteRaw","InventoryBorrowerRaw","QtyLeft","RCA"];
      lines = [head.join(",")];
      _rows.forEach(r => {
        lines.push([r.stationId, r.slot, r.fittingId, r.type, r.timeCategory, r.wave, r.orderId, r.priority,
          r.minutesElapsed, r.sku, r.resolvedTote || r.tote, r.scanner, fmt(r.scanTime), r.scanTime, r.containerStatus,
          r.queueTote, r.inventoryBorrower, r.quantityLeft, r.rcaLabel].map(cell).join(","));
      });
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `supervisor-rca-${_viewMode}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  async function init() {
    const container = $("tab-rca");
    if (!container) return;
    render(container);

    try {
      const { config } = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
      $("rcaHost").value = (config && (config.grafanaUrl || config.host)) || "https://192.168.24.230";
    } catch (e) { $("rcaHost").value = "https://192.168.24.230"; }

    $("rcaRunBtn")?.addEventListener("click", run);
    $("rcaCsvBtn")?.addEventListener("click", exportCsv);
    $("rcaViewToggle")?.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", () => {
        _viewMode = btn.dataset.view;
        $("rcaViewToggle").querySelectorAll("button").forEach(b => b.classList.toggle("active", b === btn));
        renderSummary();
        renderTable();
      });
    });
    // Time Category / Type only take effect on the next Run — no live re-filtering needed here.
    mselWire("rcaTimeMsel", () => {});
    mselWire("rcaTypeMsel", () => {});
    document.addEventListener("click", () => document.querySelectorAll(".rca-msel-panel").forEach(p => p.hidden = true));

    status("Not run yet — pick Time Category & Type above, then click ▶ Run RCA.");
    renderSummary();
    renderTable();
  }

  return { init };
})();
