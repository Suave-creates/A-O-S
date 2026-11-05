// CNG Inv Validator - 100% READ-ONLY three-way tote-partition reconciliation
// (Quadron vs NexS vs Grafana). Never calls PULL_QUADRON_TOTE.
const CNGValidatorPanel = (() => {
  const toteListEl = document.getElementById("cngTotes");
  const toteCountEl = document.getElementById("cngToteCount");
  const facility = "NXS1";
  const runBtn = document.getElementById("cngRunBtn");
  const copyBtn = document.getElementById("cngCopyBtn");
  const csvBtn = document.getElementById("cngCsvBtn");
  const statusEl = document.getElementById("cngStatus");
  const progressBar = document.getElementById("cngProgressBar");
  const errBox = document.getElementById("cngError");
  const summaryPanel = document.getElementById("cngSummaryPanel");
  const statusBar = document.getElementById("cngStatusBar");
  const emptyEl = document.getElementById("cngEmpty");
  const resultsPanel = document.getElementById("cngResultsPanel");
  const resultsBody = document.getElementById("cngResultsBody");

  const sumTotalEl = document.getElementById("cngSumTotal");
  const sumMatchEl = document.getElementById("cngSumMatch");
  const sumMismatchEl = document.getElementById("cngSumMismatch");
  const sumPartialEl = document.getElementById("cngSumPartial");
  const filterBtns = [...document.querySelectorAll(".cng-filter-btn")];

  let lastRows = [];
  let activeFilter = "all";
  let expandedBase = null; // at most one detail row open at a time

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtVal(v) {
    return v == null ? '<span class="cng-cell-na">—</span>' : String(v);
  }
  function csvVal(v) {
    return v == null ? "" : String(v);
  }

  function updateToteCount() {
    const totes = ToteListParser.parseToteList(toteListEl.value);
    toteCountEl.textContent = `${totes.length} valid tote${totes.length === 1 ? "" : "s"}`;
  }

  function renderSummary(rows) {
    const n = (v) => rows.filter((r) => r.verdict === v).length;
    sumTotalEl.textContent = rows.length;
    sumMatchEl.textContent = n("MATCH");
    sumMismatchEl.textContent = n("MISMATCH");
    sumPartialEl.textContent = n("PARTIAL") + n("MISSING");
    summaryPanel.style.display = rows.length ? "" : "none";
    resultsPanel.hidden = !rows.length;
    emptyEl.hidden = !!rows.length;
    copyBtn.disabled = csvBtn.disabled = !rows.length;
  }

  function verdictPillClass(verdict) {
    return verdict === "MISSING" ? "status-CNG_MISSING" : `status-${verdict}`;
  }

  function partitionMatrix(row) {
    if (!row.partitions.length) return `<p class="note cng-nopart">No partitions found in Quadron or Grafana for this tote.</p>`;
    const rows = row.partitions
      .map(
        (p) => `<tr class="${p.match === false ? "cng-mismatch" : ""}">
          <td>PR${p.part}</td><td>${fmtVal(p.quadron)}</td><td>${fmtVal(p.nexs)}</td><td>${fmtVal(p.grafana)}</td>
          <td>${p.match == null ? "·" : p.match ? '<i class="ico" data-i="check"></i>' : '<i class="ico" data-i="x"></i>'}</td>
        </tr>`
      )
      .join("");
    return `<table class="cng-pmatrix">
      <thead><tr><th>Partition</th><th>Quadron</th><th>NexS</th><th>Grafana</th><th>=</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function renderRows() {
    const rows = activeFilter === "all" ? lastRows : lastRows.filter((r) => r.verdict === activeFilter);
    if (!rows.length) {
      resultsBody.innerHTML = `<tr><td colspan="6" class="cng-none">No totes with this verdict.</td></tr>`;
      return;
    }
    resultsBody.innerHTML = rows
      .map((r) => {
        const isOpen = expandedBase === r.base;
        const detail = isOpen ? `<tr class="cng-detail-row"><td colspan="6">${partitionMatrix(r)}</td></tr>` : "";
        return `<tr class="cng-tote-row" data-base="${escHtml(r.base)}">
          <td class="cng-expand">${isOpen ? '<i class="ico" data-i="chevdown"></i>' : '<i class="ico" data-i="chevright"></i>'}</td>
          <td>${escHtml(r.base)}</td>
          <td>${fmtVal(r.quadron)}</td>
          <td>${fmtVal(r.nexs)}</td>
          <td>${fmtVal(r.grafana)}</td>
          <td><span class="status-pill ${verdictPillClass(r.verdict)}">${r.verdict}</span></td>
        </tr>${detail}`;
      })
      .join("");

    resultsBody.querySelectorAll(".cng-tote-row").forEach((tr) => {
      tr.addEventListener("click", () => {
        const base = tr.dataset.base;
        expandedBase = expandedBase === base ? null : base;
        renderRows();
      });
    });
  }

  function setFilter(f) {
    activeFilter = f;
    filterBtns.forEach((b) => b.classList.toggle("active", b.dataset.filter === f));
    renderRows();
  }

  async function run() {
    errBox.classList.add("hidden");
    const totes = ToteListParser.parseToteList(toteListEl.value);
    if (!totes.length) {
      errBox.textContent = "Add at least one valid tote ID (format: TS0000018492).";
      errBox.classList.remove("hidden");
      return;
    }

    runBtn.disabled = true;
    statusBar.hidden = false;
    progressBar.classList.remove("hidden");
    statusEl.textContent = `Reconciling ${totes.length} tote(s)…`;
    expandedBase = null;
    try {
      const result = await NexsConnect.run({ owner: "cngValidator", reason: "CNG Validator" }, () => Api.post("/cng-validator/run", { totes, facility }));
      showResult(result, `Done — ${(result.rows || []).length} tote(s) checked at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
      statusEl.textContent = "";
      statusBar.hidden = true;
    } finally {
      runBtn.disabled = false;
      progressBar.classList.add("hidden");
    }
  }

  // Draws a result - this page's own run, or the latest run anyone made (shared - core/sharedRun.js)
  function showResult(result, status) {
    lastRows = result.rows || [];
    expandedBase = null;
    renderSummary(lastRows);
    renderRows();
    statusBar.hidden = false;
    statusEl.textContent = status;
  }

  let offShared = null;
  function start() {
    if (offShared) return;
    offShared = SharedRun.follow("cngValidator", "/cng-validator", (last) => {
      showResult(last.result || {}, `Last check ${SharedRun.byLine(last)} — ${((last.result && last.result.rows) || []).length} tote(s)`);
    }, () => runBtn.disabled);
  }
  function stop() { if (offShared) { offShared(); offShared = null; } }

  async function copyResults() {
    if (!lastRows.length) return;
    try {
      await navigator.clipboard.writeText(buildCsv());
      Toast.show({ title: "Copied", message: `${lastRows.length} tote(s) as CSV`, tone: "ok", ms: 2500 });
    } catch (e) {
      /* clipboard permission denied/unavailable - not a functional failure, just skip */
    }
  }

  function buildCsv() {
    const cell = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [["Tote", "Quadron", "NexS", "Grafana", "Verdict", "Partitions(PR:Q/N/G)"].join(",")];
    lastRows.forEach((r) => {
      const dash = (v) => (v == null ? "-" : v);
      const parts = r.partitions.map((p) => `PR${p.part}:${dash(p.quadron)}/${dash(p.nexs)}/${dash(p.grafana)}`).join(" ");
      lines.push([r.base, csvVal(r.quadron), csvVal(r.nexs), csvVal(r.grafana), r.verdict, parts].map(cell).join(","));
    });
    return lines.join("\n");
  }

  function exportCsv() {
    if (!lastRows.length) return;
    const blob = new Blob([buildCsv()], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cng-validator-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  toteListEl.addEventListener("input", updateToteCount);
  runBtn.addEventListener("click", run);
  csvBtn.addEventListener("click", exportCsv);
  copyBtn.addEventListener("click", copyResults);
  filterBtns.forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.filter)));
  updateToteCount();

  return { start, stop };
})();
