// ui/components/purge.js
// One Click Purge tab — generates purge candidates from the ASRS dump, classifies
// via the blocked-inventory API, validates against the Quadron live API, flags
// mismatches, and exports a downloadable dump + mismatch report.
// Export-only: this tab never feeds the Auto queue.

const PurgePanel = (() => {
  const $ = id => document.getElementById(id);
  const FACILITY_KEY = "qtp_purge_facility";
  const FILTERS_KEY  = "qtp_purge_filters";

  const DEFAULT_FILTERS = { toteBarcodeMax: 7, partitionMax: 1, pidInvMin: 100, pidToteMin: 3, blockedMode: "both" };
  function loadFilters() {
    try { return { ...DEFAULT_FILTERS, ...(JSON.parse(localStorage.getItem(FILTERS_KEY)) || {}) }; }
    catch (e) { return { ...DEFAULT_FILTERS }; }
  }
  function readFiltersFromUI() {
    const intOr = (id, d, min) => { const v = parseInt($(id)?.value, 10); return (isNaN(v) ? d : Math.max(min, v)); };
    return {
      toteBarcodeMax: intOr("pfToteBarcode", DEFAULT_FILTERS.toteBarcodeMax, 1),
      partitionMax:   intOr("pfPartition",   DEFAULT_FILTERS.partitionMax, 1),
      pidInvMin:      intOr("pfPidInv",       DEFAULT_FILTERS.pidInvMin, 0),
      pidToteMin:     intOr("pfPidTote",      DEFAULT_FILTERS.pidToteMin, 1),
      blockedMode:    $("pfBlocked")?.value || DEFAULT_FILTERS.blockedMode
    };
  }
  function saveFilters(f) { try { localStorage.setItem(FILTERS_KEY, JSON.stringify(f)); } catch (e) {} }

  let _last = null;        // last result { summary, candidates, mismatches, pidBreakdown }
  let _running = false;

  // ── HTML ────────────────────────────────────────────────────────────────────
  function render(container) {
    const facility = localStorage.getItem(FACILITY_KEY) || "NXS1";
    const pf = loadFilters();
    container.innerHTML = `
      <style>
        #tab-purge .purge-filter-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:14px 0}
        #tab-purge .purge-filter-grid select{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg-2);color:var(--text);font-size:13px;font-family:inherit}
        #tab-purge .purge-filter-grid select:focus{outline:none;border-color:var(--signal)}
        #tab-purge .purge-filter-head{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin:6px 0 0;display:flex;align-items:center;gap:8px}
        #tab-purge .purge-filter-head .sh-tag{font-family:var(--mono);font-size:10px;color:var(--muted-dim);text-transform:none;letter-spacing:0}
        @media (max-width:760px){ #tab-purge .purge-filter-grid{grid-template-columns:repeat(2,1fr)} }
      </style>
      <div class="card">
        <div class="card-title">⛏ Tote Purge</div>
        <p class="purge-sub">Builds candidates from the ASRS dump (Apps Script), checks blocked inventory per SKU, then validates each tote against the Quadron live API. Review the downloadable dump before any totes are pulled.</p>

        <div class="purge-src-grid">
          <div class="purge-src" id="purgeSrcAsrs"><span class="purge-src-dot">●</span> ASRS dump <small id="purgeSrcAsrsHint">checking…</small></div>
          <div class="purge-src" id="purgeSrcQuadron"><span class="purge-src-dot">●</span> Quadron API <small id="purgeSrcQuadronHint">checking…</small></div>
          <div class="purge-src" id="purgeSrcBlocked"><span class="purge-src-dot">●</span> Blocked API <small id="purgeSrcBlockedHint">NexS — log in required</small></div>
        </div>

        <p class="purge-filter-head">Filters <span class="sh-tag">your rules — totes/PIDs must satisfy all of these</span></p>
        <div class="purge-filter-grid">
          <label class="field"><span class="label">Total Tote Barcode (≤)</span><input id="pfToteBarcode" type="number" min="1" value="${pf.toteBarcodeMax}" /><span class="field-hint">totes with up to this many barcodes</span></label>
          <label class="field"><span class="label">Tote Partition (≤)</span><input id="pfPartition" type="number" min="1" value="${pf.partitionMax}" /><span class="field-hint">active partitions in the tote</span></label>
          <label class="field"><span class="label">Total PID Inv (&gt;)</span><input id="pfPidInv" type="number" min="0" value="${pf.pidInvMin}" /><span class="field-hint">PID total ASRS inventory above this</span></label>
          <label class="field"><span class="label">Total PID Tote (≥)</span><input id="pfPidTote" type="number" min="1" value="${pf.pidToteMin}" /><span class="field-hint">PID present in at least N totes</span></label>
          <label class="field"><span class="label">Blocked</span>
            <select id="pfBlocked">
              <option value="both"${pf.blockedMode==="both"?" selected":""}>Both</option>
              <option value="blocked"${pf.blockedMode==="blocked"?" selected":""}>Blocked only</option>
              <option value="non_blocked"${pf.blockedMode==="non_blocked"?" selected":""}>Non-Blocked (0)</option>
            </select>
            <span class="field-hint">blocked status to include</span>
          </label>
        </div>

        <div class="purge-cfg-row">
          <label class="field purge-facility-field"><span class="label">NexS Facility (blocked API header)</span>
            <input id="purgeFacility" type="text" placeholder="NXS1" value="${facility}" /></label>
          <button class="btn ghost subtle" id="purgeResetFilters">↺ Reset filters</button>
          <button class="btn primary" id="purgeGenBtn">Generate Purge Candidates</button>
        </div>
        <div class="purge-status" id="purgeStatus"></div>
      </div>

      <div class="card" id="purgeResults" style="display:none">
        <div class="stats-header">
          <span class="stats-title">Purge Summary</span>
          <div class="stats-actions">
            <button class="btn ghost subtle small-btn" id="purgeDlCsv">Dump CSV</button>
            <button class="btn ghost subtle small-btn" id="purgeDlJson">Dump JSON</button>
            <button class="btn ghost subtle small-btn" id="purgeCopy">Copy Dump</button>
            <button class="btn ghost subtle small-btn danger-btn" id="purgeDlMismatch">Mismatch CSV</button>
          </div>
        </div>
        <div class="grid-4 purge-stats">
          <div class="stat-box"><div class="stat-value" id="purgeStTotes">0</div><div class="stat-label">Purge Totes</div></div>
          <div class="stat-box"><div class="stat-value" id="purgeStInv">0</div><div class="stat-label">Inventory</div></div>
          <div class="stat-box"><div class="stat-value" id="purgeStPids">0</div><div class="stat-label">Unique PIDs</div></div>
          <div class="stat-box"><div class="stat-value" id="purgeStValid">0</div><div class="stat-label">Validated</div></div>
        </div>
        <div class="grid-4 purge-stats">
          <div class="stat-box"><div class="stat-value" id="purgeStBlocked">0</div><div class="stat-label">Blocked</div></div>
          <div class="stat-box"><div class="stat-value" id="purgeStNonBlocked">0</div><div class="stat-label">Non-Blocked</div></div>
          <div class="stat-box purge-warn-box"><div class="stat-value" id="purgeStMismatch">0</div><div class="stat-label">Mismatches</div></div>
          <div class="stat-box"><div class="stat-value" id="purgeStApiFail">0</div><div class="stat-label">API Skipped</div></div>
        </div>
        <div class="purge-integrity" id="purgeIntegrity"></div>

        <div class="purge-section-title">PID Breakdown</div>
        <div class="purge-table-wrap"><table class="purge-table" id="purgePidTable"></table></div>

        <div class="purge-section-title" id="purgeMismatchTitle">Mismatch Report</div>
        <div class="purge-table-wrap"><table class="purge-table" id="purgeMismatchTable"></table></div>

        <div class="purge-section-title">Purge Dump <small id="purgeDumpNote"></small></div>
        <div class="purge-table-wrap"><table class="purge-table" id="purgeDumpTable"></table></div>
      </div>`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const esc = s => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const BLOCKED_LABEL = { both: "Both", blocked: "Blocked only", non_blocked: "Non-Blocked (0)" };
  function fmtFilters(f){
    if (!f) return "";
    return `Total Tote Barcode ≤ ${f.toteBarcodeMax} · Tote Partition ≤ ${f.partitionMax} · `
         + `Total PID Inv > ${f.pidInvMin} (blocked only) · Total PID Tote ≥ ${f.pidToteMin} · `
         + `Blocked: ${BLOCKED_LABEL[f.blockedMode] || f.blockedMode}`;
  }
  function csvCell(v){ const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; }
  function toCsv(headers, rows){ return [headers.join(","), ...rows.map(r => r.map(csvCell).join(","))].join("\n"); }
  function dl(content, filename, mime){
    const blob = new Blob([content], { type: mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function setSrc(id, ok, hint){
    const el = $(id); if (!el) return;
    el.classList.toggle("on", !!ok); el.classList.toggle("off", !ok);
    const h = $(id + "Hint"); if (h && hint != null) h.textContent = hint;
  }
  function status(msg, kind){
    const el = $("purgeStatus"); if (!el) return;
    el.textContent = msg || ""; el.className = "purge-status" + (kind ? " " + kind : "");
  }

  // ── Data-source readiness (informational) ──────────────────────────────────────
  async function refreshSources(){
    try {
      const { config } = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
      const hasSheet = !!(config && config.sheetUrl);
      const hasHost  = !!(config && config.host);
      setSrc("purgeSrcAsrs", hasSheet, hasSheet ? "Apps Script configured" : "Set Apps Script URL in Auto tab");
      setSrc("purgeSrcQuadron", hasHost, hasHost ? (config.host) : "Set host in Auto tab");
    } catch (e) {
      setSrc("purgeSrcAsrs", false, "config unavailable");
      setSrc("purgeSrcQuadron", false, "config unavailable");
    }
    setSrc("purgeSrcBlocked", true, "Ensure you're logged into app.nexs.lenskart.com");
  }

  // ── Generate ────────────────────────────────────────────────────────────────────
  async function generate(){
    if (_running) return;
    const facility = ($("purgeFacility")?.value || "NXS1").trim() || "NXS1";
    localStorage.setItem(FACILITY_KEY, facility);
    const filters = readFiltersFromUI();
    saveFilters(filters);

    let config = {};
    try { config = (await chrome.runtime.sendMessage({ type: "GET_CONFIG" })).config || {}; } catch (e) {}
    if (!config.sheetUrl) { status("No Apps Script URL — set it in the Auto tab (it serves the ASRS dump).", "err"); return; }

    _running = true;
    const btn = $("purgeGenBtn"); if (btn) { btn.disabled = true; btn.textContent = "Generating…"; }
    status(`Filters → ${fmtFilters(filters)} · reading ASRS dump…`, "info");

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "PURGE_GENERATE", opts: {
        sheetUrl: config.sheetUrl, host: config.host, instanceCode: config.instanceCode, facilityCode: facility, filters
      }});
    } catch (e) { resp = { ok:false, reason: e.message || String(e) }; }

    _running = false;
    if (btn) { btn.disabled = false; btn.textContent = "Generate Purge Candidates"; }

    if (!resp || !resp.ok) { status("Failed: " + ((resp && resp.reason) || "unknown error"), "err"); return; }
    _last = resp;
    renderResults(resp);
    const s = resp.summary;
    let msg = `${s.totalTotes} purge totes · ${s.uniquePids} PIDs · ${s.mismatchCount} mismatch(es)`;
    if (!s.quadronAvailable) msg += " · Quadron unavailable (validation skipped)";
    if (s.blockedApiFails) msg += ` · ${s.blockedApiFails} PID(s) skipped (blocked API)`;
    status(msg, s.mismatchCount ? "warn" : "ok");
  }

  // ── Render results ────────────────────────────────────────────────────────────
  function renderResults(r){
    const s = r.summary;
    $("purgeResults").style.display = "";
    $("purgeStTotes").textContent      = s.totalTotes;
    $("purgeStInv").textContent        = s.totalInventory;
    $("purgeStPids").textContent       = s.uniquePids;
    $("purgeStValid").textContent      = s.validatedCount;
    $("purgeStBlocked").textContent    = s.blockedCount;
    $("purgeStNonBlocked").textContent = s.nonBlockedCount;
    $("purgeStMismatch").textContent   = s.mismatchCount;
    $("purgeStApiFail").textContent    = s.blockedApiFails;

    // Data-integrity line — lets the operator verify counts reconcile
    const ig = $("purgeIntegrity");
    if (ig) {
      const lines = s.candidateLines != null ? s.candidateLines : s.totalTotes;
      const distinct = s.distinctTotes != null ? s.distinctTotes : s.totalTotes;
      const reconciles = (s.blockedCount + s.nonBlockedCount) === lines;
      const skipped = s.apiSkippedTotes || 0;
      ig.innerHTML =
        `<strong>${lines}</strong> candidate line${lines===1?"":"s"} across <strong>${distinct}</strong> distinct tote${distinct===1?"":"s"} `
        + `· Large <strong>${s.largeTotes||0}</strong> / Small <strong>${s.smallTotes||0}</strong> `
        + `· Blocked ${s.blockedCount} + Non-Blocked ${s.nonBlockedCount} ${reconciles ? "✓ reconciles" : "⚠ mismatch"} `
        + `· Validated ${s.validatedCount} + Mismatches ${s.mismatchCount} ${(s.validatedCount+s.mismatchCount)===lines ? "✓" : "⚠"}`
        + (skipped ? ` · <span style="color:var(--net-err)">⚠ ${skipped} tote(s) NOT evaluated — blocked API failed (review separately)</span>` : "")
        + ` · <span style="color:var(--muted-dim)">“PID Inv − Blocked” = ASRS dump PID total − NexS blocked</span>`;
    }

    // PID breakdown
    const pidHead = `<tr><th>PID</th><th>Totes</th><th>Inv Sel.</th><th>Blocked</th><th>PID Total</th><th>PID Inv − Blocked</th></tr>`;
    const pidRows = r.pidBreakdown.map(p =>
      `<tr><td>${esc(p.pid)}</td><td>${p.totesSelected}</td><td>${p.inventorySelected}</td><td>${p.blockedInventory}</td><td>${p.totalPidInventory}</td><td>${p.availableInventory}</td></tr>`
    ).join("");
    $("purgePidTable").innerHTML = pidHead + (pidRows || `<tr><td colspan="6" class="purge-empty">No PIDs</td></tr>`);

    // Mismatches
    $("purgeMismatchTitle").textContent = `Mismatch Report (${r.mismatches.length})`;
    const mmHead = `<tr><th>Tote ID</th><th>PID</th><th>Issue</th><th>ASRS</th><th>Quadron</th><th>Action</th></tr>`;
    const mmRows = r.mismatches.map(m =>
      `<tr class="purge-mm-${esc(m.issueType)}"><td>${esc(m.toteId)}</td><td>${esc(m.pid)}</td><td>${esc(m.issueType)}</td><td>${esc(m.asrsValue)}</td><td>${esc(m.quadronValue)}</td><td>${esc(m.recommendedAction)}</td></tr>`
    ).join("");
    $("purgeMismatchTable").innerHTML = mmHead + (mmRows || `<tr><td colspan="6" class="purge-empty">No mismatches — all candidates validated ✓</td></tr>`);

    // Dump (cap inline rows; full set in the download)
    const CAP = 1000;
    const cand = r.candidates;
    const filterNote = r.filters ? ` · filters: ${fmtFilters(r.filters)}` : "";
    $("purgeDumpNote").textContent = (cand.length > CAP ? `(showing first ${CAP} of ${cand.length} — full set in CSV/JSON)` : `(${cand.length} totes)`) + filterNote;
    const dumpHead = `<tr><th>Tote ID</th><th>Tote Type</th><th>PID</th><th>Part</th><th>ASRS</th><th>Quad</th><th>Blocked</th><th>PID Inv − Blocked</th><th>PID Total</th><th>#Totes</th><th>Purge Type</th><th>Status</th></tr>`;
    const dumpRows = cand.slice(0, CAP).map(c => {
      const qInv  = (c.quadronQty == null) ? "—" : c.quadronQty;
      const qDiff = (c.quadronQty != null && c.quadronQty !== c.inventoryCount);
      const avail = (c.availableInventory != null) ? c.availableInventory : (c.totalPidInventory - (c.blockedInventory || 0));
      const toteType = c.toteType || (String(c.toteId).startsWith("TL") ? "Large" : "Small");
      return `<tr class="purge-row-${c.quadronValidated ? "ok" : "flag"}"><td>${esc(c.toteId)}</td><td>${esc(toteType)}</td><td>${esc(c.pid)}</td><td>${esc(c.partition || "—")}</td><td>${c.inventoryCount}</td><td${qDiff ? ' style="color:var(--accent);font-weight:700"' : ''}>${qInv}</td><td>${c.blockedInventory}</td><td>${avail}</td><td>${c.totalPidInventory}</td><td>${c.totalPidTotes}</td><td>${esc(c.purgeType)}</td><td>${esc(c.validationStatus)}</td></tr>`;
    }).join("");
    $("purgeDumpTable").innerHTML = dumpHead + (dumpRows || `<tr><td colspan="12" class="purge-empty">No candidates</td></tr>`);
  }

  // ── Exports ───────────────────────────────────────────────────────────────────
  function dumpCsv(){
    if (!_last) return "";
    const headers = ["Tote ID","Tote Type","PID","Partition","ASRS Inventory","Quadron Inventory","Quadron Partition","Blocked Inventory","Available (PID Total - Blocked)","Overall PID Inventory","PID Tote Count","Purge Type","Validation Status","Notes"];
    const rows = _last.candidates.map(c => {
      const avail = (c.availableInventory != null) ? c.availableInventory : (c.totalPidInventory - (c.blockedInventory || 0));
      const qPart = (c.quadronPartition == null) ? "" : ("PR" + c.quadronPartition);
      const qInv  = (c.quadronQty == null) ? "" : c.quadronQty;
      const toteType = c.toteType || (String(c.toteId).startsWith("TL") ? "Large" : "Small");
      return [c.toteId,toteType,c.pid,c.partition||"",c.inventoryCount,qInv,qPart,c.blockedInventory,avail,c.totalPidInventory,c.totalPidTotes,c.purgeType,c.validationStatus,(c.notes||[]).join("; ")];
    });
    const comments = [
      `# Purge Dump — generated ${new Date().toISOString()}`,
      `# Filters applied: ${fmtFilters(_last.filters || readFiltersFromUI())}`,
      ``
    ].join("\n");
    return comments + "\n" + toCsv(headers, rows);
  }
  function mismatchCsv(){
    if (!_last) return "";
    const headers = ["Tote ID","PID","Issue Type","ASRS Value","Quadron Value","Recommended Action"];
    const rows = _last.mismatches.map(m => [m.toteId,m.pid,m.issueType,m.asrsValue,m.quadronValue,m.recommendedAction]);
    return toCsv(headers, rows);
  }
  function stamp(){ return new Date().toISOString().replace(/[:.]/g,"-").slice(0,19); }

  // ── Init ────────────────────────────────────────────────────────────────────────
  function init(){
    const container = $("tab-purge");
    if (!container) return;
    render(container);
    refreshSources();

    $("purgeGenBtn")?.addEventListener("click", generate);
    $("purgeFacility")?.addEventListener("change", () => localStorage.setItem(FACILITY_KEY, ($("purgeFacility").value || "NXS1").trim() || "NXS1"));

    ["pfToteBarcode","pfPartition","pfPidInv","pfPidTote","pfBlocked"].forEach(id => {
      $(id)?.addEventListener("change", () => saveFilters(readFiltersFromUI()));
    });
    $("purgeResetFilters")?.addEventListener("click", () => {
      saveFilters({ ...DEFAULT_FILTERS });
      $("pfToteBarcode").value = DEFAULT_FILTERS.toteBarcodeMax;
      $("pfPartition").value   = DEFAULT_FILTERS.partitionMax;
      $("pfPidInv").value      = DEFAULT_FILTERS.pidInvMin;
      $("pfPidTote").value     = DEFAULT_FILTERS.pidToteMin;
      $("pfBlocked").value     = DEFAULT_FILTERS.blockedMode;
      status("Filters reset to defaults.", "info");
    });

    $("purgeDlCsv")?.addEventListener("click", () => { if (_last) dl(dumpCsv(), `purge-dump-${stamp()}.csv`, "text/csv"); });
    $("purgeDlJson")?.addEventListener("click", () => { if (_last) dl(JSON.stringify({ filters: _last.filters || readFiltersFromUI(), summary:_last.summary, candidates:_last.candidates, mismatches:_last.mismatches, pidBreakdown:_last.pidBreakdown, apiSkipped:_last.apiSkipped||[] }, null, 2), `purge-dump-${stamp()}.json`, "application/json"); });
    $("purgeDlMismatch")?.addEventListener("click", () => { if (_last) dl(mismatchCsv(), `purge-mismatch-${stamp()}.csv`, "text/csv"); });
    $("purgeCopy")?.addEventListener("click", async () => {
      if (!_last) return;
      try { await navigator.clipboard.writeText(dumpCsv()); status("Dump copied to clipboard.", "ok"); }
      catch (e) { status("Clipboard blocked — use Dump CSV instead.", "warn"); }
    });

    // Progress from the engine
    chrome.runtime.onMessage.addListener(msg => {
      if (msg && msg.type === "PURGE_PROGRESS") {
        status(`Blocked inventory: ${msg.done}/${msg.total} PIDs…`, "info");
      }
    });

    // Refresh source chips whenever the tab is opened
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => { if (btn.dataset.tab === "purge") refreshSources(); });
    });
  }

  return { init };
})();
