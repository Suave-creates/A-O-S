// Bulk Tote Inv Check (2026-10-01) - 100% READ-ONLY. Paste a bulk list of
// totes, get every per-partition barcode/SKU on file for each one, straight
// from Grafana's own Tote Level Inventory dashboard data. Never pulls a
// tote or affects any operation. Mirrors CNGValidatorPanel's own structure
// (ToteListParser for the shared textarea-parsing convention, same
// run()/summary/results-table shape) - this feature just has one data
// source (Grafana) instead of three, so no reconciliation/verdict logic.
const BulkInventoryCheck = (() => {
  const toteListEl = document.getElementById("bicTotes");
  const toteCountEl = document.getElementById("bicToteCount");
  const runBtn = document.getElementById("bicRunBtn");
  const csvBtn = document.getElementById("bicCsvBtn");
  const statusBar = document.getElementById("bicStatusBar");
  const statusEl = document.getElementById("bicStatus");
  const progressBar = document.getElementById("bicProgressBar");
  const errBox = document.getElementById("bicError");
  const emptyEl = document.getElementById("bicEmpty");
  const summaryPanel = document.getElementById("bicSummaryPanel");
  const resultsPanel = document.getElementById("bicResultsPanel");
  const resultsNote = document.getElementById("bicResultsNote");
  const resultsBody = document.getElementById("bicResultsBody");
  const searchEl = document.getElementById("bicSearch");
  const filterSeg = document.getElementById("bicFilterSeg");

  const sumTotalEl = document.getElementById("bicSumTotal");
  const sumFoundEl = document.getElementById("bicSumFound");
  const sumNotFoundEl = document.getElementById("bicSumNotFound");
  const sumBarcodesEl = document.getElementById("bicSumBarcodes");
  const sumSkusEl = document.getElementById("bicSumSkus");

  let lastItems = [];
  let filter = "ALL"; // ALL | FOUND | NOT_FOUND
  let query = "";

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  // the search term highlighted inside a cell
  function hl(v) {
    if (v == null || v === "") return "—";
    const s = String(v);
    const q = query.trim();
    if (!q) return escHtml(s);
    const i = s.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return escHtml(s);
    return escHtml(s.slice(0, i)) + "<mark>" + escHtml(s.slice(i, i + q.length)) + "</mark>" + escHtml(s.slice(i + q.length));
  }
  // create_time comes back as an epoch-ms number (matching the real
  // captured Grafana response's own "time" column type) - rendered as a
  // readable local timestamp, never a raw millisecond number an operator
  // would have to decode themselves.
  function fmtCreateTime(v) {
    if (v == null) return Fmt.nil;
    const n = Number(v);
    if (!Number.isFinite(n)) return escHtml(v);
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? escHtml(v) : Fmt.when(d);
  }

  function updateToteCount() {
    const totes = ToteListParser.parseToteList(toteListEl.value);
    toteCountEl.textContent = `${totes.length} valid tote${totes.length === 1 ? "" : "s"}`;
  }

  function renderSummary(items) {
    const found = items.filter((i) => i.found);
    const skus = new Set();
    let barcodes = 0;
    for (const i of found) for (const p of i.partitions) { barcodes++; if (p.sku) skus.add(p.sku); }
    sumTotalEl.textContent = items.length.toLocaleString();
    sumFoundEl.textContent = found.length.toLocaleString();
    sumNotFoundEl.textContent = (items.length - found.length).toLocaleString();
    sumBarcodesEl.textContent = barcodes.toLocaleString();
    sumSkusEl.textContent = skus.size.toLocaleString();
    summaryPanel.style.display = items.length ? "" : "none";
    resultsPanel.hidden = !items.length;
    emptyEl.hidden = !!items.length;
  }

  // A tote passes the search if its ID, or any of its barcodes / SKUs, contains the text; a found tote then
  // shows only the partitions that match (all of them when the tote ID itself matched).
  function visible(items) {
    const q = query.trim().toLowerCase();
    const has = (v) => v != null && String(v).toLowerCase().includes(q);
    const out = [];
    for (const item of items) {
      if (filter === "FOUND" && !item.found) continue;
      if (filter === "NOT_FOUND" && item.found) continue;
      if (!q || has(item.tote)) { out.push({ item, parts: item.found ? item.partitions : [] }); continue; }
      if (!item.found) continue;
      const parts = item.partitions.filter((p) => has(p.serialId) || has(p.sku));
      if (parts.length) out.push({ item, parts });
    }
    return out;
  }

  // One row per PARTITION (not per tote) - a found tote with N partitions
  // gets N rows, each showing that partition's own barcode/SKU; a
  // not-found tote gets exactly one row saying so, never silently omitted.
  function renderRows() {
    const shown = visible(lastItems);
    const totes = shown.length;
    const rowsCount = shown.reduce((n, s) => n + Math.max(s.parts.length, 1), 0);
    resultsNote.textContent = totes === lastItems.length && !query.trim()
      ? `${rowsCount.toLocaleString()} row${rowsCount === 1 ? "" : "s"}`
      : `${totes.toLocaleString()} of ${lastItems.length.toLocaleString()} totes · ${rowsCount.toLocaleString()} rows`;
    if (!shown.length) {
      resultsBody.innerHTML = `<tr><td colspan="6" class="bic-none">${query.trim() ? `Nothing matches “${escHtml(query.trim())}”.` : "No totes in this view."}</td></tr>`;
      return;
    }
    const rowsHtml = [];
    for (const { item, parts } of shown) {
      if (!item.found) {
        rowsHtml.push(
          `<tr class="bic-first bic-missing"><td>${hl(item.tote)}</td><td><span class="status-pill status-FAILED">Not Found</span></td><td colspan="4" class="note">No partition on file in Grafana</td></tr>`
        );
        continue;
      }
      parts.forEach((p, i) => {
        rowsHtml.push(
          `<tr class="${i === 0 ? "bic-first" : "bic-cont"}">
            <td>${i === 0 ? hl(item.tote) : ""}</td>
            <td>${i === 0 ? `<span class="status-pill status-COMPLETED">Found · ${item.partitions.length}</span>` : ""}</td>
            <td>${hl(p.partition)}</td>
            <td>${hl(p.serialId)}</td>
            <td>${hl(p.sku)}</td>
            <td class="when">${fmtCreateTime(p.create_time)}</td>
          </tr>`
        );
      });
    }
    resultsBody.innerHTML = rowsHtml.join("");
  }

  async function run() {
    errBox.classList.add("hidden");
    const totes = ToteListParser.parseToteList(toteListEl.value);
    if (!totes.length) {
      errBox.textContent = "Add at least one valid tote ID (format: TL0000025362 or TS0000018492).";
      errBox.classList.remove("hidden");
      return;
    }

    runBtn.disabled = true;
    statusBar.hidden = false;
    progressBar.classList.remove("hidden");
    statusEl.textContent = `Checking ${totes.length} tote(s)…`;
    try {
      const result = await Api.post("/bulk-inventory-check/check", { totes });
      showResult(result, `Done — ${result.foundCount} found, ${result.notFoundCount} not found · checked at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
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
    lastItems = result.items || [];
    renderSummary(lastItems);
    renderRows();
    statusBar.hidden = false;
    statusEl.textContent = status;
    csvBtn.disabled = !lastItems.length;
  }

  let offShared = null;
  function start() {
    if (offShared) return;
    offShared = SharedRun.follow("bulkInventoryCheck", "/bulk-inventory-check", (last) => {
      const r = last.result || {};
      showResult(r, `Last check ${SharedRun.byLine(last)} — ${r.foundCount || 0} found, ${r.notFoundCount || 0} not found`);
    }, () => runBtn.disabled);
  }
  function stop() { if (offShared) { offShared(); offShared = null; } }

  function buildCsv() {
    const cell = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [["Tote", "Status", "Partition", "Barcode (Serial ID)", "SKU", "Created"].join(",")];
    for (const item of lastItems) {
      if (!item.found) {
        lines.push([item.tote, "Not Found", "", "", "", ""].map(cell).join(","));
        continue;
      }
      for (const p of item.partitions) {
        lines.push([item.tote, "Found", p.partition, p.serialId, p.sku, fmtCreateTime(p.create_time)].map(cell).join(","));
      }
    }
    return lines.join("\n");
  }

  function exportCsv() {
    if (!lastItems.length) return;
    const blob = new Blob([buildCsv()], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `bulk-tote-inv-check-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  toteListEl.addEventListener("input", updateToteCount);
  runBtn.addEventListener("click", run);
  csvBtn.addEventListener("click", exportCsv);
  searchEl.addEventListener("input", () => { query = searchEl.value; renderRows(); });
  filterSeg.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-v]");
    if (!b) return;
    filter = b.dataset.v;
    filterSeg.querySelectorAll("[data-v]").forEach((x) => x.classList.toggle("active", x === b));
    renderRows();
  });
  updateToteCount();

  return { start, stop };
})();
