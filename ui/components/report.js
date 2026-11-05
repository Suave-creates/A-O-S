// ui/components/report.js — ASRS Daily Report tab (one-pager).
//
// Three different kinds of data on this page — colour-coded consistently
// throughout (teal=Historical, amber=Live, blue=Manual), explained once in
// a legend under the title instead of repeating the shift-hours text on
// every section:
//   • Historical — Compaction, Tote Freed, CC Done, Discrepancies Marked,
//     CC Stations — queried for the selected date's A/B/C IST shift windows.
//     Shift C (22:00–06:00) is labeled by its START date. CC Done is deduped
//     to distinct base totes server-side (stock-check rows come back per
//     partition, sometimes per material line too).
//   • Live — Tote Utilisation / Totes In ASRS / Aisle Occupancy. The source
//     systems only expose CURRENT state, there is no history table behind
//     them, so these reflect report-generation time, not the picked date.
//   • Manual — Outside Totes. The automatic (RCA-derived) number was
//     confirmed incorrect, so this is typed in and saved per report-date in
//     chrome.storage.local, included in both snapshot exports.
//
// The report sheet itself (#rptPrintArea) renders in a light theme, scoped
// via --rpt-* CSS custom properties defined on .rpt-sheet — the surrounding
// app controls (date picker, buttons) stay in the extension's normal dark
// theme. All 6 shift/live panels are direct children of one CSS grid so
// CSS Grid's default row-stretch keeps both columns evenly aligned row by
// row, instead of two independently-stacked columns drifting out of sync.
//
// All queried data comes from one ASRS_DAILY_REPORT background message — see
// buildAsrsDailyReport() in background/index.js.

const ReportPanel = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const nf = n => Number(n || 0).toLocaleString();
  const pctFrom100 = u => (u == null ? "—" : Number(u).toFixed(1) + "%");

  const CAP_KEY = "asrs_util_caps"; // same key as utilisation.js — single source of truth for capacities
  const DEFAULT_CAPS = { largeLens: 300, largeFrame: 240, smallLens: 200, smallFrame: 200 };
  function loadCaps() {
    try { return { ...DEFAULT_CAPS, ...(JSON.parse(localStorage.getItem(CAP_KEY)) || {}) }; }
    catch (e) { return { ...DEFAULT_CAPS }; }
  }

  // ── Manual Outside Totes entry — persisted per report-date ─────────────────
  const MANUAL_OUTSIDE_KEY = "asrs_report_manual_outside_v1";
  async function loadManualOutside(dateStr) {
    try {
      const res = await chrome.storage.local.get(MANUAL_OUTSIDE_KEY);
      const all = (res && res[MANUAL_OUTSIDE_KEY]) || {};
      return all[dateStr] || null;
    } catch (e) { return null; }
  }
  async function saveManualOutside(dateStr, vals) {
    const res = await chrome.storage.local.get(MANUAL_OUTSIDE_KEY);
    const all = (res && res[MANUAL_OUTSIDE_KEY]) || {};
    all[dateStr] = { ...vals, savedAt: Date.now() };
    await chrome.storage.local.set({ [MANUAL_OUTSIDE_KEY]: all });
    return all[dateStr];
  }
  function readOutsideInputs() {
    return {
      h24plus: Math.max(0, parseInt($("rptOut24").value, 10) || 0),
      h12to24: Math.max(0, parseInt($("rptOut1224").value, 10) || 0),
    };
  }
  function writeOutsideInputs(vals) {
    $("rptOut24").value = vals ? vals.h24plus : "";
    $("rptOut1224").value = vals ? vals.h12to24 : "";
    updateOutsideTotal();
  }
  function updateOutsideTotal() {
    const v = readOutsideInputs();
    const el = $("rptOutTotal");
    if (el) el.textContent = nf(v.h24plus + v.h12to24);
    updateSaveButtonVisibility();
  }
  // Save button only needs to be visible while there's something unsaved —
  // hide it right after a successful save, show it again if the boxes are
  // edited afterward (or nothing's been saved yet for this date).
  function outsideIsDirty() {
    const v = readOutsideInputs();
    if (!_outsideSavedVals) return true;
    return v.h24plus !== _outsideSavedVals.h24plus || v.h12to24 !== _outsideSavedVals.h12to24;
  }
  function updateSaveButtonVisibility() {
    const btn = $("rptOutSaveBtn");
    if (btn) btn.style.display = outsideIsDirty() ? "" : "none";
  }

  let _report = null;
  let _running = false;
  let _outsideSavedVals = null;

  function yesterdayIST() {
    // "Today" per IST wall clock, then step back one day. Uses Intl so it's
    // correct regardless of the machine's OS timezone.
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const y = +parts.find(p => p.type === "year").value, m = +parts.find(p => p.type === "month").value, d = +parts.find(p => p.type === "day").value;
    const t = Date.UTC(y, m - 1, d) - 86400000;
    const dt = new Date(t);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  }

  function render(container) {
    container.innerHTML = `
      <style>
        #tab-report .rpt-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
        #tab-report .rpt-status{color:var(--muted);font-size:12px;font-family:var(--mono)}
        #tab-report .rpt-empty{color:var(--muted);font-family:var(--mono);font-size:12px;text-align:center;padding:34px 16px}

        /* ── Light-theme tokens, scoped to the report sheet only — the rest
           of the extension (controls above) stays on the app's dark theme. ── */
        #tab-report .rpt-sheet{
          --rpt-bg:#ffffff; --rpt-panel-bg:#fbfcfe; --rpt-surface-2:#eef2f7;
          --rpt-border:#d7dee7; --rpt-border-soft:#e9edf2;
          --rpt-text:#17202c; --rpt-muted:#5c6b80; --rpt-muted-dim:#8b98a8;
          --rpt-hist:#0d9488; --rpt-hist-tint:rgba(13,148,136,.10);
          --rpt-live:#b45309; --rpt-live-tint:rgba(180,83,9,.10);
          --rpt-manual:#1d4ed8; --rpt-manual-tint:rgba(29,78,216,.10);
          --rpt-red:#dc2626; --rpt-purple:#7c3aed; --rpt-green:#16a34a;

          position:relative;border:1px solid var(--rpt-border);border-radius:var(--r-lg);
          padding:26px 26px 22px;color:var(--rpt-text);
          background:linear-gradient(180deg, #ffffff 0%, #fbfcfe 220px);
          box-shadow:0 10px 34px -16px rgba(15,23,42,.22), 0 1px 2px rgba(15,23,42,.05);
          overflow:hidden;
        }
        #tab-report .rpt-sheet::before{content:"";position:absolute;top:0;left:0;right:0;height:4px;
          background:linear-gradient(90deg, var(--accent-strong), var(--accent) 22%, var(--signal) 70%, var(--signal-dim))}

        #tab-report .rpt-title-row{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
        #tab-report .rpt-title{font-size:19px;font-weight:800;color:var(--rpt-text);letter-spacing:-.01em}
        #tab-report .rpt-title-sub{display:block;font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--rpt-muted-dim);margin-bottom:5px}
        #tab-report .rpt-gen-note{font-size:11px;color:var(--rpt-muted);font-family:var(--mono);text-align:right;white-space:nowrap}

        #tab-report .rpt-legend{display:flex;gap:20px;flex-wrap:wrap;margin:16px 0 22px;padding-bottom:16px;border-bottom:1px solid var(--rpt-border-soft)}
        #tab-report .rpt-legend-item{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--rpt-muted)}
        #tab-report .rpt-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
        #tab-report .rpt-dot.hist{background:var(--rpt-hist)}
        #tab-report .rpt-dot.live{background:var(--rpt-live)}
        #tab-report .rpt-dot.manual{background:var(--rpt-manual)}

        /* Panels are DIRECT grid children (not nested in two independently-
           stacked column wrappers) so each row's cells stretch to match
           height — this is what keeps the two columns aligned row by row. */
        #tab-report .rpt-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px 20px;align-items:stretch}
        #tab-report .rpt-block{min-width:0}
        #tab-report .rpt-aisle-block{margin-top:18px}
        #tab-report .rpt-locked-block{margin-bottom:18px}
        #tab-report table.rpt-table td.locked-sd{color:var(--rpt-purple)}
        #tab-report table.rpt-table td.locked-p0{color:var(--rpt-red)}
        #tab-report table.rpt-table td.locked-p1{color:var(--rpt-live)}
        #tab-report table.rpt-table td.locked-p2{color:var(--rpt-green)}

        #tab-report .rpt-panel{height:100%;display:flex;flex-direction:column;box-sizing:border-box;
          background:var(--rpt-panel-bg);border:1px solid var(--rpt-border-soft);
          border-top:3px solid var(--rpt-border);border-radius:14px;padding:15px 16px 16px}
        #tab-report .rpt-panel.hist{border-top-color:var(--rpt-hist)}
        #tab-report .rpt-panel.live{border-top-color:var(--rpt-live)}
        #tab-report .rpt-panel.manual{border-top-color:var(--rpt-manual)}

        #tab-report .rpt-h{font-size:11.5px;color:var(--rpt-text);text-transform:uppercase;letter-spacing:.06em;
          font-weight:700;margin:0 0 11px;display:flex;align-items:center;gap:8px}
        #tab-report .rpt-h .rpt-icon{font-size:13px}
        #tab-report .rpt-h .tag{margin-left:auto;font-family:var(--mono);font-size:9px;font-weight:700;
          letter-spacing:.05em;text-transform:uppercase;padding:3px 8px;border-radius:var(--r-pill)}
        #tab-report .rpt-h .tag.hist{background:var(--rpt-hist-tint);color:var(--rpt-hist)}
        #tab-report .rpt-h .tag.live{background:var(--rpt-live-tint);color:var(--rpt-live)}
        #tab-report .rpt-h .tag.manual{background:var(--rpt-manual-tint);color:var(--rpt-manual)}

        #tab-report .rpt-table-wrap{border:1px solid var(--rpt-border-soft);border-radius:10px;overflow:hidden}
        #tab-report table.rpt-table{border-collapse:collapse;width:100%;font-size:12.5px}
        #tab-report table.rpt-table th,#tab-report table.rpt-table td{padding:8px 10px;text-align:center;border-bottom:1px solid var(--rpt-border-soft)}
        #tab-report table.rpt-table tbody tr:last-child td{border-bottom:none}
        #tab-report table.rpt-table th{background:var(--rpt-surface-2);color:var(--rpt-muted);font-weight:700;
          font-size:10px;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--rpt-border)}
        #tab-report table.rpt-table td:first-child, #tab-report table.rpt-table th:first-child{text-align:left;color:var(--rpt-text);font-weight:600}
        #tab-report table.rpt-table tbody tr:nth-child(even) td{background:rgba(15,23,42,.018)}
        #tab-report table.rpt-table td.num{font-family:var(--mono);color:var(--rpt-text);font-weight:600}
        #tab-report table.rpt-table td.total{background:var(--rpt-hist-tint)!important;color:var(--rpt-hist);font-weight:700}
        #tab-report table.rpt-table tr.grand td{background:rgba(15,23,42,.035)!important;font-weight:700}
        #tab-report table.rpt-table tr.grand td.total{background:rgba(13,148,136,.16)!important}

        #tab-report table.rpt-table td.manual-cell{padding:5px 6px}
        #tab-report table.rpt-table input.manual-in{width:64px;text-align:center;font-family:var(--mono);
          font-size:12.5px;font-weight:700;background:#ffffff;border:1px solid var(--rpt-border);
          border-radius:7px;color:var(--rpt-text);padding:6px 4px}
        #tab-report table.rpt-table input.manual-in:focus{outline:none;border-color:var(--rpt-live);box-shadow:0 0 0 3px var(--rpt-live-tint)}
        #tab-report .manual-in-capture{display:inline-block;width:64px;text-align:center;font-family:var(--mono);
          font-size:12.5px;font-weight:700;background:#ffffff;border:1px solid var(--rpt-border);
          border-radius:7px;color:var(--rpt-text);padding:6px 4px;box-sizing:border-box}

        #tab-report .rpt-sheet .btn{background:var(--rpt-panel-bg);border:1px solid var(--rpt-border);color:var(--rpt-text)}
        #tab-report .rpt-sheet .btn:hover:not(:disabled){border-color:var(--rpt-live)}
        #tab-report .rpt-sheet .rpt-status{color:var(--rpt-muted)}

        #tab-report .rpt-note{font-size:10.5px;color:var(--rpt-muted-dim);font-family:var(--mono);margin-top:8px}
        #tab-report .rpt-err{font-size:11px;color:var(--rpt-red);font-family:var(--mono);margin-top:8px}
        #tab-report .rpt-out-row{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}

        @media print {
          #tab-report .rpt-controls, #tab-report .rpt-out-row .btn{display:none}
          #tab-report .rpt-sheet{box-shadow:none}
          #tab-report .rpt-sheet::before{display:none}
        }
        @media (max-width: 900px){ #tab-report .rpt-grid{grid-template-columns:1fr} }
      </style>

      <div class="card">
        <div class="card-title">📄 ASRS Daily Report — One Pager</div>
        <p class="purge-sub" style="margin-bottom:12px">
          Shift tables (Compaction, Tote Freed, CC Done, Discrepancies Marked, Station Coverage) are pulled for the selected date's A/B/C IST shifts.
          Current Locked Totes, Tote Utilisation, Totes In ASRS, and Aisle Occupancy have no history API — those sections always show the
          <strong>current live state</strong>. Outside Totes is entered manually below.
        </p>
        <div class="rpt-controls">
          <label class="field" style="max-width:180px">
            <span class="label">Report Date (Shift A/B/C)</span>
            <input type="date" id="rptDate" />
          </label>
          <button id="rptLoadBtn" class="btn primary">▶ Generate</button>
          <button id="rptPrintBtn" class="btn ghost subtle">🖨 Print</button>
          <button id="rptPngBtn" class="btn ghost subtle" disabled>📷 Download PNG</button>
          <button id="rptCsvBtn" class="btn ghost subtle" disabled>⬇ Download Snapshot (CSV)</button>
          <span class="rpt-status" id="rptStatus"></span>
        </div>
      </div>

      <div id="rptSheetMount"></div>
    `;
  }

  function shiftRow(label, s) {
    return `<tr><td>${esc(label)}</td><td class="num">${nf(s.A)}</td><td class="num">${nf(s.B)}</td><td class="num">${nf(s.C)}</td><td class="num total">${nf(s.Total)}</td></tr>`;
  }

  function renderSheet() {
    const mount = $("rptSheetMount");
    if (!mount) return;
    if (!_report) { mount.innerHTML = `<div class="card"><div class="rpt-empty">Pick a date and click Generate.</div></div>`; return; }

    const r = _report;
    const dateLabel = r.dateStr;
    const genLabel = new Date(r.live.generatedAt).toLocaleString();
    const locked = r.locked || { sd: 0, p0: 0, p1: 0, p2: 0, total: 0, unavailable: true };

    // ── Tote Utilisation + Totes In ASRS ──
    // Prefer the Tote Utilisation tab's own cached last-run result (same
    // stats/totals shape) over the report's independent live fetch, so this
    // panel is never a second, slightly-different-in-time snapshot.
    const cachedUtil = r.cachedUtil;
    const tu = cachedUtil ? cachedUtil : r.live.toteUtil;
    let largePct = null, smallPct = null, totalPct = null;
    let asrsRows = { large: { frame: 0, lens: 0 }, small: { frame: 0, lens: 0 } };
    if (tu) {
      const largeCap = tu.stats.largeLens.cap + tu.stats.largeFrame.cap;
      const largeQty = tu.stats.largeLens.qty + tu.stats.largeFrame.qty;
      const smallCap = tu.stats.smallLens.cap + tu.stats.smallFrame.cap;
      const smallQty = tu.stats.smallLens.qty + tu.stats.smallFrame.qty;
      largePct = largeCap > 0 ? (largeQty / largeCap) * 100 : 0;
      smallPct = smallCap > 0 ? (smallQty / smallCap) * 100 : 0;
      // Total must match the extension's own Tote Utilisation tab exactly —
      // that's tu.totals.util (qty summed across all 4 categories / cap summed
      // across all 4), the same weighted total shown in its main gauge. An
      // unweighted (Large% + Small%)/2 diverges from it whenever Large's total
      // capacity differs from Small's, which is virtually always.
      totalPct = tu.totals.cap > 0 ? (tu.totals.qty / tu.totals.cap) * 100 : 0;
      asrsRows = {
        large: { frame: tu.stats.largeFrame.totes, lens: tu.stats.largeLens.totes },
        small: { frame: tu.stats.smallFrame.totes, lens: tu.stats.smallLens.totes },
      };
    }
    const asrsTotalFrame = asrsRows.large.frame + asrsRows.small.frame;
    const asrsTotalLens = asrsRows.large.lens + asrsRows.small.lens;
    const asrsGrandTotal = asrsTotalFrame + asrsTotalLens;

    // ── Aisle Occupancy ──
    const aisleNums = ["001", "002", "003", "004", "005", "006"];
    const aisleByNum = {}; r.live.aisleOccupancy.forEach(a => { aisleByNum[a.aisle] = a.value; });
    const lsByNum = r.live.aisleLS;

    mount.innerHTML = `
      <div class="rpt-sheet" id="rptPrintArea">
        <div class="rpt-title-row">
          <div class="rpt-title"><span class="rpt-title-sub">Plant Operations · ASRS</span>ASRS Daily Report — ${esc(dateLabel)}</div>
          <div class="rpt-gen-note">live sections as of ${esc(genLabel)}</div>
        </div>
        <div class="rpt-legend">
          <span class="rpt-legend-item"><span class="rpt-dot hist"></span>Historical — Shift A 06:00–14:00 · B 14:00–22:00 · C 22:00–06:00 (IST)</span>
          <span class="rpt-legend-item"><span class="rpt-dot live"></span>Live — as of report generation</span>
        </div>

        <div class="rpt-locked-block">
          <div class="rpt-panel live">
            <p class="rpt-h"><span class="rpt-icon">🔒</span>Current Locked Totes<span class="tag live">Live</span></p>
            <div class="rpt-table-wrap"><table class="rpt-table">
              <thead><tr><th>Current Locked Totes</th><th>⚡ Supervisor Lock</th><th>P0 Critical</th><th>P1 High</th><th>P2 Standard</th><th>Total</th></tr></thead>
              <tbody>
                <tr>
                  <td>Count</td>
                  <td class="num locked-sd">${nf(locked.sd)}</td>
                  <td class="num locked-p0">${nf(locked.p0)}</td>
                  <td class="num locked-p1">${nf(locked.p1)}</td>
                  <td class="num locked-p2">${nf(locked.p2)}</td>
                  <td class="num total">${nf(locked.total)}</td>
                </tr>
              </tbody>
            </table></div>
            ${locked.unavailable ? `<div class="rpt-note">Auto Mode hasn't fetched a locked-tote snapshot yet — showing zeros</div>` : ``}
          </div>
        </div>

        <div class="rpt-grid">
          <div class="rpt-block">
            <div class="rpt-panel hist">
              <p class="rpt-h"><span class="rpt-icon">🗜</span>Compaction<span class="tag hist">Historical</span></p>
              <div class="rpt-table-wrap"><table class="rpt-table">
                <thead><tr><th>Shift</th><th>A</th><th>B</th><th>C</th><th>Total</th></tr></thead>
                <tbody>
                  ${shiftRow("Compaction", r.shifts.compaction)}
                  ${shiftRow("Tote Freed", r.shifts.toteFreed)}
                </tbody>
              </table></div>
            </div>
          </div>

          <div class="rpt-block">
            <div class="rpt-panel hist">
              <p class="rpt-h"><span class="rpt-icon">🧮</span>CC Done / Discrepancies<span class="tag hist">Historical</span></p>
              <div class="rpt-table-wrap"><table class="rpt-table">
                <thead><tr><th>Shift</th><th>A</th><th>B</th><th>C</th><th>Total</th></tr></thead>
                <tbody>
                  ${shiftRow("CC Done", r.shifts.ccDone)}
                  ${shiftRow("Discrepancies Marked", r.shifts.discrepancies)}
                </tbody>
              </table></div>
            </div>
          </div>

          <div class="rpt-block">
            <div class="rpt-panel hist">
              <p class="rpt-h"><span class="rpt-icon">🏭</span>Station Coverage<span class="tag hist">Historical</span></p>
              <div class="rpt-table-wrap"><table class="rpt-table">
                <thead><tr><th>Shift</th><th>A</th><th>B</th><th>C</th><th>Total</th></tr></thead>
                <tbody>
                  ${shiftRow("CC Stations Ran", r.shifts.ccStationsRan)}
                  ${shiftRow("Stations Flagged (SHORT)", r.shifts.discrepancyStations)}
                </tbody>
              </table></div>
            </div>
          </div>

          <div class="rpt-block">
            <div class="rpt-panel live">
              <p class="rpt-h"><span class="rpt-icon">📥</span>Totes In ASRS<span class="tag live">Live</span></p>
              <div class="rpt-table-wrap"><table class="rpt-table">
                <thead><tr><th>Totes In ASRS</th><th>Frame</th><th>Lens</th><th>Total</th></tr></thead>
                <tbody>
                  <tr><td>Large Tote</td><td class="num">${nf(asrsRows.large.frame)}</td><td class="num">${nf(asrsRows.large.lens)}</td><td class="num total">${nf(asrsRows.large.frame + asrsRows.large.lens)}</td></tr>
                  <tr><td>Small Tote</td><td class="num">${nf(asrsRows.small.frame)}</td><td class="num">${nf(asrsRows.small.lens)}</td><td class="num total">${nf(asrsRows.small.frame + asrsRows.small.lens)}</td></tr>
                  <tr class="grand"><td>Total</td><td class="num">${nf(asrsTotalFrame)}</td><td class="num">${nf(asrsTotalLens)}</td><td class="num total">${nf(asrsGrandTotal)}</td></tr>
                </tbody>
              </table></div>
            </div>
          </div>

          <div class="rpt-block">
            <div class="rpt-panel live">
              <p class="rpt-h"><span class="rpt-icon">📦</span>Tote Utilisation<span class="tag live">Live</span></p>
              <div class="rpt-table-wrap"><table class="rpt-table">
                <thead><tr><th>Tote Type</th><th>Large Tote</th><th>Small Tote</th><th>Total Utilisation</th></tr></thead>
                <tbody>
                  <tr><td>Tote Utilisation</td><td class="num">${pctFrom100(largePct)}</td><td class="num">${pctFrom100(smallPct)}</td><td class="num total">${pctFrom100(totalPct)}</td></tr>
                </tbody>
              </table></div>
              ${!tu && r.live.toteUtilError ? `<div class="rpt-err">Tote Utilisation unavailable: ${esc(r.live.toteUtilError)}</div>` : ``}
            </div>
          </div>

          <div class="rpt-block">
            <div class="rpt-panel live">
              <p class="rpt-h"><span class="rpt-icon">🚚</span>Outside Totes<span class="tag live">Live</span></p>
              <div class="rpt-table-wrap"><table class="rpt-table">
                <thead><tr><th>Outside Totes</th><th>Above 24 Hours</th><th>12 - 24 Hours</th><th>Total</th></tr></thead>
                <tbody>
                  <tr>
                    <td>Count</td>
                    <td class="manual-cell"><input type="number" min="0" step="1" id="rptOut24" class="manual-in" /></td>
                    <td class="manual-cell"><input type="number" min="0" step="1" id="rptOut1224" class="manual-in" /></td>
                    <td class="num total" id="rptOutTotal">0</td>
                  </tr>
                </tbody>
              </table></div>
              <div class="rpt-out-row">
                <button id="rptOutSaveBtn" class="btn ghost subtle">💾 Save Outside Totes for ${esc(dateLabel)}</button>
              </div>
            </div>
          </div>
        </div>

        <div class="rpt-aisle-block">
          <div class="rpt-panel live">
            <p class="rpt-h"><span class="rpt-icon">🧭</span>Aisle Occupancy<span class="tag live">Live</span></p>
            <div class="rpt-table-wrap"><table class="rpt-table">
              <thead><tr><th>Aisle</th>${aisleNums.map(a => `<th>${Number(a)}</th>`).join("")}<th>Average</th></tr></thead>
              <tbody>
                <tr><td>Aisle Occupancy</td>${aisleNums.map(a => `<td class="num">${pctFrom100(aisleByNum[a])}</td>`).join("")}<td class="num total">${pctFrom100(r.live.aisleOccupancyAvg)}</td></tr>
                <tr><td>Large</td>${aisleNums.map(a => `<td class="num">${pctFrom100(lsByNum[a] && lsByNum[a].large)}</td>`).join("")}<td class="num total">${pctFrom100(r.live.aisleLSAvg.large)}</td></tr>
                <tr><td>Short</td>${aisleNums.map(a => `<td class="num">${pctFrom100(lsByNum[a] && lsByNum[a].short)}</td>`).join("")}<td class="num total">${pctFrom100(r.live.aisleLSAvg.short)}</td></tr>
              </tbody>
            </table></div>
          </div>
        </div>
      </div>
    `;

    $("rptOut24").addEventListener("input", updateOutsideTotal);
    $("rptOut1224").addEventListener("input", updateOutsideTotal);
    $("rptOutSaveBtn").addEventListener("click", () => saveOutsideForCurrentDate());

    loadManualOutside(r.dateStr).then(vals => {
      writeOutsideInputs(vals);
      _outsideSavedVals = vals ? { h24plus: vals.h24plus, h12to24: vals.h12to24 } : null;
      updateSaveButtonVisibility();
    });
  }

  async function saveOutsideForCurrentDate() {
    if (!_report) return;
    const vals = readOutsideInputs();
    await saveManualOutside(_report.dateStr, vals);
    _outsideSavedVals = { h24plus: vals.h24plus, h12to24: vals.h12to24 };
    updateSaveButtonVisibility();
  }

  function status(msg) { const el = $("rptStatus"); if (el) el.textContent = msg || ""; }

  // Reuses Auto Mode's own priority-queue snapshot (AUTO_GET_QUEUE) — same
  // fallback logic as the Auto Mode tab's queue display (auto.js renderQueue):
  // prefer the last full Grafana locked-tote breakdown (queue.locked), fall
  // back to the live in-memory queue counts before any fetch has run.
  // Reuses the Tote Utilisation tab's own last-run result when available (same
  // storage the utilisation.js cache write uses) — guarantees this report can
  // never disagree with that tab, since it's literally the same object rather
  // than a second independent live fetch. Falls back to the report's own live
  // fetch only if the Utilisation tab hasn't been run.
  async function loadCachedUtilResult() {
    try {
      const res = await chrome.storage.local.get("asrs_util_last_result");
      return (res && res.asrs_util_last_result) || null;
    } catch (e) { return null; }
  }

  async function fetchLockedSnapshot() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "AUTO_GET_QUEUE" });
      const queue = resp && resp.queue;
      if (!queue) return { sd: 0, p0: 0, p1: 0, p2: 0, total: 0, unavailable: true };
      const b = (queue.locked && queue.locked.total) ? queue.locked : null;
      const out = {
        sd: (b ? b.sd : queue.sdCount) || 0,
        p0: (b ? b.p0 : queue.p0Count) || 0,
        p1: (b ? b.p1 : queue.p1Count) || 0,
        p2: (b ? b.p2 : queue.p2Count) || 0,
        total: (b ? b.total : queue.total) || 0,
      };
      out.unavailable = out.total === 0 && !b;
      return out;
    } catch (e) { return { sd: 0, p0: 0, p1: 0, p2: 0, total: 0, unavailable: true }; }
  }

  async function generate() {
    if (_running) return;
    const dateStr = $("rptDate").value;
    if (!dateStr) { status("Pick a date first."); return; }
    _running = true;
    const btn = $("rptLoadBtn"); if (btn) { btn.disabled = true; btn.textContent = "Generating…"; }
    $("rptCsvBtn").disabled = true;
    $("rptPngBtn").disabled = true;
    status("Fetching Compaction / Tote Freed / CC Done / Discrepancies for A/B/C, plus live Aisle / Utilisation / Locked Totes…");

    let resp;
    try {
      const [reportResp, locked, cachedUtil] = await Promise.all([
        chrome.runtime.sendMessage({ type: "ASRS_DAILY_REPORT", dateStr, caps: loadCaps() }),
        fetchLockedSnapshot(),
        loadCachedUtilResult(),
      ]);
      resp = reportResp;
      if (resp && resp.ok) { resp.locked = locked; resp.cachedUtil = cachedUtil; }
    } catch (e) { resp = { ok: false, reason: e.message || String(e) }; }

    _running = false;
    if (btn) { btn.disabled = false; btn.textContent = "▶ Generate"; }

    if (!resp || !resp.ok) { _report = null; renderSheet(); status("Failed: " + ((resp && resp.reason) || "unknown error")); return; }

    _report = resp;
    renderSheet();
    $("rptCsvBtn").disabled = false;
    $("rptPngBtn").disabled = false;
    status(`Done — report for ${dateStr}, live sections as of ${new Date(resp.live.generatedAt).toLocaleTimeString()}`);
  }

  function exportCsv() {
    if (!_report) return;
    const r = _report;
    const outVals = readOutsideInputs();
    const cell = v => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [];
    lines.push(`ASRS Daily Report,${r.dateStr}`);
    lines.push(`Live sections as of,${new Date(r.live.generatedAt).toLocaleString()}`);
    lines.push("");
    const lk = r.locked || { sd: 0, p0: 0, p1: 0, p2: 0, total: 0 };
    lines.push("CURRENT LOCKED TOTES (live),Supervisor Lock,P0 Critical,P1 High,P2 Standard,Total");
    lines.push([lk.sd, lk.p0, lk.p1, lk.p2, lk.total].map(cell).join(","));
    lines.push("");
    lines.push("SHIFT,A,B,C,Total");
    const shiftLabels = {
      compaction: "Compaction", toteFreed: "Tote Freed",
      ccDone: "CC Done", discrepancies: "Discrepancies Marked",
      ccStationsRan: "CC Stations Ran", discrepancyStations: "Stations Flagged (SHORT)",
    };
    Object.keys(shiftLabels).forEach(k => {
      const s = r.shifts[k];
      lines.push([shiftLabels[k], s.A, s.B, s.C, s.Total].map(cell).join(","));
    });
    lines.push("");
    const tu = r.cachedUtil || r.live.toteUtil;
    if (tu) {
      const largeCap = tu.stats.largeLens.cap + tu.stats.largeFrame.cap, largeQty = tu.stats.largeLens.qty + tu.stats.largeFrame.qty;
      const smallCap = tu.stats.smallLens.cap + tu.stats.smallFrame.cap, smallQty = tu.stats.smallLens.qty + tu.stats.smallFrame.qty;
      const lp = largeCap > 0 ? (largeQty / largeCap) * 100 : 0, sp = smallCap > 0 ? (smallQty / smallCap) * 100 : 0;
      const totPct = tu.totals.cap > 0 ? (tu.totals.qty / tu.totals.cap) * 100 : 0; // matches Tote Utilisation tab's own total, not (L+S)/2
      lines.push(r.cachedUtil ? `TOTE UTILISATION (from Tote Utilisation tab — ${new Date(r.cachedUtil.generatedAt).toLocaleString()}),Large %,Small %,Total` : "TOTE UTILISATION (live),Large %,Small %,Total");
      lines.push([lp.toFixed(2), sp.toFixed(2), totPct.toFixed(2)].map(cell).join(","));
      lines.push("");
      const lf = tu.stats.largeFrame.totes, ll = tu.stats.largeLens.totes, sf = tu.stats.smallFrame.totes, sl = tu.stats.smallLens.totes;
      lines.push("TOTES IN ASRS (live),Frame,Lens,Total");
      lines.push(["Large Tote", lf, ll, lf + ll].map(cell).join(","));
      lines.push(["Small Tote", sf, sl, sf + sl].map(cell).join(","));
      lines.push(["Total", lf + sf, ll + sl, lf + ll + sf + sl].map(cell).join(","));
      lines.push("");
    }
    lines.push("OUTSIDE TOTES,Above 24 Hours,12 - 24 Hours,Total");
    lines.push([outVals.h24plus, outVals.h12to24, outVals.h24plus + outVals.h12to24].map(cell).join(","));
    lines.push("");
    const aisleNums = ["001", "002", "003", "004", "005", "006"];
    const aisleByNum = {}; r.live.aisleOccupancy.forEach(a => { aisleByNum[a.aisle] = a.value; });
    lines.push("AISLE OCCUPANCY (live)," + aisleNums.map(a => Number(a)).join(",") + ",Average");
    lines.push(["Aisle Occupancy", ...aisleNums.map(a => (aisleByNum[a] || 0).toFixed(2)), r.live.aisleOccupancyAvg.toFixed(2)].map(cell).join(","));
    lines.push(["Large", ...aisleNums.map(a => ((r.live.aisleLS[a] && r.live.aisleLS[a].large) || 0).toFixed(2)), r.live.aisleLSAvg.large.toFixed(2)].map(cell).join(","));
    lines.push(["Short", ...aisleNums.map(a => ((r.live.aisleLS[a] && r.live.aisleLS[a].short) || 0).toFixed(2)), r.live.aisleLSAvg.short.toFixed(2)].map(cell).join(","));

    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `asrs-daily-report-${r.dateStr}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  function printSheet() {
    if (!_report) { status("Generate a report first."); return; }
    window.print();
  }

  async function exportPng() {
    if (!_report) { status("Generate a report first."); return; }
    if (typeof html2canvas !== "function") { status("PNG export unavailable — html2canvas didn't load."); return; }
    const el = $("rptPrintArea");
    if (!el) return;
    const btn = $("rptPngBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Rendering…"; }
    status("Rendering PNG…");

    // html2canvas doesn't reliably paint <input> value text (form controls are
    // "replaced elements" it only partially supports — digits can come out as
    // the wrong glyphs). Swap the Outside Totes inputs for plain text spans
    // styled to look identical, just for the capture, then restore them.
    const swaps = [];
    el.querySelectorAll("td.manual-cell").forEach(td => {
      const inp = td.querySelector("input.manual-in");
      if (!inp) return;
      const span = document.createElement("span");
      span.className = "manual-in-capture";
      span.textContent = inp.value || "0";
      inp.style.display = "none";
      td.appendChild(span);
      swaps.push({ td, span, inp });
    });

    try {
      const bg = getComputedStyle(el).backgroundColor || "#ffffff";
      const canvas = await html2canvas(el, { backgroundColor: bg, scale: 2, useCORS: true });
      await new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
          if (!blob) { reject(new Error("canvas.toBlob returned null")); return; }
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `asrs-daily-report-${_report.dateStr}.png`;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 1500);
          resolve();
        }, "image/png");
      });
      status(`Done — PNG saved for ${_report.dateStr}`);
    } catch (e) {
      status("PNG export failed: " + (e.message || String(e)));
    } finally {
      swaps.forEach(({ span, inp }) => { span.remove(); inp.style.display = ""; });
      if (btn) { btn.disabled = false; btn.textContent = "📷 Download PNG"; }
    }
  }

  function init() {
    const container = $("tab-report");
    if (!container) return;
    render(container);
    $("rptDate").value = yesterdayIST();
    renderSheet();
    $("rptLoadBtn")?.addEventListener("click", generate);
    $("rptCsvBtn")?.addEventListener("click", exportCsv);
    $("rptPngBtn")?.addEventListener("click", exportPng);
    $("rptPrintBtn")?.addEventListener("click", printSheet);
  }

  return { init };
})();
