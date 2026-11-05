// ui/components/cng-validator.js
// CNG Inv Validator tab — three-way tote inventory reconciliation across
// Quadron, Nexs and Grafana. Merged in from the standalone "Tote Inventory
// Validator" extension (panel.html/panel.js/panel.css + background.js).
//
// Talks to background/cng-validator.js via chrome.runtime.connect({name:
// "validator"}) for the RUN flow. No auth display of its own — auth status
// lives in the app header (#authStatus for Quadron, #grafanaStatusPill for
// Grafana), which already reflects the same cookie checks this tab's fetches
// rely on.
//
// All element ids are prefixed "cng" — the Manual tab already owns #totes /
// #toteCount, so reusing those names here would silently break both tabs.

const CNGValidatorPanel = (() => {
  const $ = id => document.getElementById(id);

  const FACILITY_KEY = "qtp_cng_facility";

  let LAST_ROWS = [];
  let FILTER = "all";

  // ── HTML ──────────────────────────────────────────────────────────────────
  function render(container) {
    const facility = localStorage.getItem(FACILITY_KEY) || "NXS1";
    container.innerHTML = `
      <style>
        #tab-cng .cng-grid-wrap table.cng-grid { font-family:var(--mono); font-size:12px; }
        #tab-cng .cng-grid tbody tr.cng-tote-row { cursor:pointer; }
        #tab-cng .cng-grid tbody tr.cng-tote-row:hover { background:rgba(255,255,255,.03); }
        #tab-cng .cng-grid td.cng-exp { width:22px; color:var(--muted); text-align:center; }
        #tab-cng .cng-grid tr.cng-mismatch-row td { background:rgba(255,93,93,.06); }
        #tab-cng .cng-verdict { font-size:10px; font-weight:700; letter-spacing:.4px; padding:2px 8px; border-radius:var(--r-pill); }
        #tab-cng .cng-verdict.MATCH    { color:var(--green);  background:rgba(70,217,138,.14); }
        #tab-cng .cng-verdict.MISMATCH { color:var(--red);    background:rgba(255,93,93,.16); }
        #tab-cng .cng-verdict.PARTIAL  { color:var(--yellow); background:rgba(243,195,77,.16); }
        #tab-cng .cng-verdict.MISSING  { color:var(--muted);  background:var(--surface-2); }
        #tab-cng .cng-detail-row td { padding:0 10px 10px; background:var(--surface); }
        #tab-cng table.cng-pmatrix { width:100%; border-collapse:collapse; margin-top:2px; border:1px solid var(--border); border-radius:6px; overflow:hidden; }
        #tab-cng table.cng-pmatrix th, #tab-cng table.cng-pmatrix td { padding:5px 10px; font-size:11px; border-bottom:1px solid var(--border); text-align:right; }
        #tab-cng table.cng-pmatrix th:first-child, #tab-cng table.cng-pmatrix td:first-child { text-align:left; color:var(--muted); }
        #tab-cng table.cng-pmatrix tr.bad td { background:rgba(255,93,93,.08); color:var(--red); }
        #tab-cng .cng-cell-na { color:var(--muted-dim); }
        #tab-cng .stats-row.four { grid-template-columns:repeat(4,1fr); }
      </style>

      <section class="card">
        <div class="card-title">🧮 CNG Inv Validator</div>
        <p class="purge-sub">Paste 20–200 totes and reconcile per-partition quantities across Quadron, Nexs and Grafana. A tote is flagged the moment any two sources disagree.</p>

        <label class="field">
          <span class="label">Totes <span class="hint" id="cngToteCount">0 totes</span></span>
          <textarea id="cngTotes" rows="6" placeholder="TL0000016926&#10;TS0000018492&#10;TL0000023329&#10;(commas / spaces / new lines all fine)"></textarea>
        </label>

        <div class="cfg-row">
          <label class="field cfg-col">
            <span class="label">Facility</span>
            <select id="cngFacility">
              <option value="NXS1" ${facility === "NXS1" ? "selected" : ""}>NXS1</option>
              <option value="NXS2" ${facility === "NXS2" ? "selected" : ""}>NXS2</option>
            </select>
          </label>
        </div>
      </section>

      <div class="action-row">
        <button id="cngRunBtn" class="btn primary">▶ Validate</button>
      </div>

      <section class="progress-card" id="cngProgressCard" style="display:none">
        <div class="progress-head">
          <span id="cngProgressLabel">Idle</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" id="cngProgressFill" style="width:0%"></div></div>
      </section>

      <section class="stats-card" id="cngResultsWrap" style="display:none">
        <div class="stats-header">
          <span class="stats-title">Reconciliation Results</span>
          <div class="stats-actions">
            <button class="log-filter-btn active" data-filter="all">All</button>
            <button class="log-filter-btn" data-filter="MISMATCH">Mismatch</button>
            <button class="log-filter-btn" data-filter="PARTIAL">Partial</button>
            <button class="log-filter-btn" data-filter="MATCH">Match</button>
            <button id="cngCopyBtn" class="btn ghost subtle small-btn">⧉ Copy</button>
            <button id="cngCsvBtn" class="btn ghost subtle small-btn">⬇ CSV</button>
          </div>
        </div>
        <div class="stats-row four" id="cngSummary">
          <div class="stat-box">        <span class="stat-value" id="cngStatTotal">0</span>    <span class="stat-label">Totes</span></div>
          <div class="stat-box green">  <span class="stat-value" id="cngStatMatch">0</span>    <span class="stat-label">Match</span></div>
          <div class="stat-box red">    <span class="stat-value" id="cngStatMismatch">0</span> <span class="stat-label">Mismatch</span></div>
          <div class="stat-box yellow"> <span class="stat-value" id="cngStatPartial">0</span>  <span class="stat-label">Partial</span></div>
        </div>
        <div class="tote-table-wrap cng-grid-wrap">
          <table class="tote-table cng-grid">
            <thead>
              <tr><th></th><th>Tote</th><th class="r">Quadron</th><th class="r">Nexs IMS</th><th class="r">Grafana</th><th>Verdict</th></tr>
            </thead>
            <tbody id="cngGridBody"></tbody>
          </table>
          <p class="table-empty" id="cngGridEmpty" style="display:none">Nothing matches this filter.</p>
        </div>
      </section>
    `;
  }

  // ── Input parsing ───────────────────────────────────────────────────────
  function parseTotes(raw) {
    const tokens = raw.split(/[\s,;]+/).map(t => t.trim().toUpperCase()).filter(Boolean);
    const bases = tokens.map(t => {
      const m = t.match(/^(.*?)-\d+$/); // strip a trailing "-N" partition suffix
      return m ? m[1] : t;
    });
    return [...new Set(bases)];
  }

  function updateCount() {
    const n = parseTotes($("cngTotes").value).length;
    $("cngToteCount").textContent = `${n} tote${n === 1 ? "" : "s"}`;
  }

  // ── Run ──────────────────────────────────────────────────────────────────
  function setProgress(pct, msg) {
    $("cngProgressCard").style.display = "";
    if (typeof pct === "number") $("cngProgressFill").style.width = Math.min(100, pct) + "%";
    $("cngProgressLabel").textContent = msg;
  }

  function run() {
    const totes = parseTotes($("cngTotes").value);
    if (!totes.length) { setProgress(0, "Enter at least one tote."); return; }

    const facility = $("cngFacility").value;
    localStorage.setItem(FACILITY_KEY, facility);

    $("cngRunBtn").disabled = true;
    $("cngResultsWrap").style.display = "none";
    setProgress(2, "Starting…");

    const port = chrome.runtime.connect({ name: "validator" });
    port.onMessage.addListener(m => {
      if (m.type === "progress") setProgress(m.pct, m.msg);
      else if (m.type === "warn") setProgress(undefined, m.msg);
      else if (m.type === "error") {
        $("cngRunBtn").disabled = false;
        setProgress(0, "⚠ " + m.msg);
      } else if (m.type === "done") {
        $("cngRunBtn").disabled = false;
        setProgress(100, "Done.");
        setTimeout(() => { $("cngProgressCard").style.display = "none"; }, 600);
        LAST_ROWS = m.rows;
        renderResults();
      }
    });
    port.postMessage({ type: "RUN", totes, facility, grafanaChunk: 40 });
  }

  // ── Render results ───────────────────────────────────────────────────────
  const cell = v => (v == null ? '<span class="cng-cell-na">—</span>' : v);

  function renderResults() {
    $("cngResultsWrap").style.display = "";
    const counts = { MATCH: 0, MISMATCH: 0, PARTIAL: 0, MISSING: 0 };
    LAST_ROWS.forEach(r => { counts[r.verdict] = (counts[r.verdict] || 0) + 1; });

    $("cngStatTotal").textContent    = LAST_ROWS.length;
    $("cngStatMatch").textContent    = counts.MATCH;
    $("cngStatMismatch").textContent = counts.MISMATCH;
    $("cngStatPartial").textContent  = counts.PARTIAL + counts.MISSING;

    const body = $("cngGridBody");
    body.innerHTML = "";
    const rows = LAST_ROWS.filter(r => FILTER === "all" || r.verdict === FILTER);

    $("cngGridEmpty").style.display = rows.length ? "none" : "";
    if (!rows.length) return;

    rows.forEach(r => {
      const bad = r.verdict === "MISMATCH";
      const tr = document.createElement("tr");
      tr.className = "cng-tote-row" + (bad ? " cng-mismatch-row" : "");
      tr.innerHTML = `
        <td class="cng-exp">▸</td>
        <td>${r.base}</td>
        <td class="r">${cell(r.quadron)}</td>
        <td class="r">${cell(r.nexs)}</td>
        <td class="r">${cell(r.grafana)}</td>
        <td><span class="cng-verdict ${r.verdict}">${r.verdict}</span></td>`;
      const detail = document.createElement("tr");
      detail.className = "cng-detail-row";
      detail.hidden = true;
      detail.innerHTML = `<td colspan="6">${partitionTable(r)}</td>`;

      tr.addEventListener("click", () => {
        detail.hidden = !detail.hidden;
        tr.querySelector(".cng-exp").textContent = detail.hidden ? "▸" : "▾";
      });
      body.appendChild(tr);
      body.appendChild(detail);
    });
  }

  function partitionTable(r) {
    const rows = r.partitions.map(p => {
      const bad = p.match === false;
      return `<tr class="${bad ? "bad" : "ok"}">
        <td>PR${p.part}</td>
        <td>${cell(p.quadron)}</td>
        <td>${cell(p.nexs)}</td>
        <td>${cell(p.grafana)}</td>
        <td>${p.match === false ? "✗" : p.match === true ? "✓" : "·"}</td>
      </tr>`;
    }).join("");
    return `<table class="cng-pmatrix">
      <thead><tr><th>Partition</th><th>Quadron</th><th>Nexs</th><th>Grafana</th><th>=</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  // ── Export ───────────────────────────────────────────────────────────────
  function toCSV() {
    const head = ["Tote", "Quadron", "Nexs_IMS", "Grafana", "Verdict", "Partitions(PR:Q/N/G)"];
    const lines = [head.join(",")];
    for (const r of LAST_ROWS) {
      const parts = r.partitions
        .map(p => `PR${p.part}:${p.quadron ?? "-"}/${p.nexs ?? "-"}/${p.grafana ?? "-"}`)
        .join(" ");
      lines.push([r.base, r.quadron ?? "", r.nexs ?? "", r.grafana ?? "", r.verdict, `"${parts}"`].join(","));
    }
    return lines.join("\n");
  }

  function download(name, text) {
    const blob = new Blob([text], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function init() {
    render(document.getElementById("tab-cng"));

    $("cngTotes").addEventListener("input", updateCount);
    $("cngRunBtn").addEventListener("click", run);
    $("cngCsvBtn").addEventListener("click", () => download(`cng-inv-validation-${Date.now()}.csv`, toCSV()));
    $("cngCopyBtn").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(toCSV());
        $("cngCopyBtn").textContent = "Copied";
        setTimeout(() => { $("cngCopyBtn").textContent = "⧉ Copy"; }, 1200);
      } catch (e) { /* clipboard blocked — ignore */ }
    });
    document.querySelectorAll("#cngResultsWrap .log-filter-btn").forEach(b => {
      b.addEventListener("click", () => {
        document.querySelectorAll("#cngResultsWrap .log-filter-btn").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
        FILTER = b.dataset.filter;
        renderResults();
      });
    });
  }

  return { init };
})();
