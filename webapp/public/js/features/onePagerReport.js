// One Pager Report (2026-09-07) - every section of the legacy extension's
// own ASRS Daily Report one-pager, built from sources this webapp already
// has (never a second implementation) - see server/features/one-pager-report/onePagerReportEngine.js's
// own header comment for the exact section -> source mapping. All fetched
// fresh on every Generate click - never dependent on another tab having
// already been refreshed.
//
// Two modes on one screen: the Daily report and the Day-range (bulk) report. Both render as a light
// "sheet" scoped under .opr-sheet - always light, whatever the app theme - because the PNG export
// snapshots exactly that DOM with html2canvas. So the sheet uses plain hex / rgba colours only (no
// color-mix(), no CSS-mask icons, no rowspan): html2canvas cannot draw those.
const OnePagerReport = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const nf = (n) => (n == null ? "No data" : Fmt.num(n));
  const pct = (fraction) => (fraction == null ? "—" : (Number(fraction) * 100).toFixed(1) + "%");
  // aisleOccupancy's own average/values are already 0-100 (see
  // dashboardEngine.js's combineAisleOccupancy()) - NOT a 0-1 fraction like
  // utilisation.totals.util, so this stays a separate formatter from pct().
  const alreadyPct = (v) => (v == null ? "—" : Number(v).toFixed(1) + "%");

  // section accents (hex: see the header note on html2canvas)
  const K = { lock: "#d6313a", out: "#b4720b", asrs: "#2563eb", util: "#1d9a5a", comp: "#6d4fe0", cc: "#0e8a8a", prod: "#d36a1a", aisle: "#2563eb" };
  // utilisation colour scale, the same bands as the Tote Utilisation screen
  const utilColour = (f) => (f == null ? "#8a97a8" : f < 0.3 ? "#d6313a" : f < 0.5 ? "#c99a06" : "#1d9a5a");

  let _report = null;
  let _generating = false;

  // ── Bulk (day-range) report (2026-09-14) ─────────────────────────────
  let _bulkReport = null;
  let _bulkStop = null;
  let _bulkQueryId = null;
  const BULK_TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);

  function capsFromInputs() {
    const caps = {};
    for (const key of ["largeLens", "largeFrame", "smallLens", "smallFrame"]) {
      const el = $("oprCap" + key.charAt(0).toUpperCase() + key.slice(1));
      const n = el ? parseInt(el.value, 10) : NaN;
      if (Number.isFinite(n) && n > 0) caps[key] = n;
    }
    return caps;
  }

  // IST "today" as YYYY-MM-DD (Intl-based, right whatever the browser's own timezone)
  function todayIST() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  }
  // YYYY-MM-DD minus n days, plain calendar arithmetic (only feeds a date input)
  function minusDaysIST(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
  }
  const prettyDate = (dateStr) => {
    if (!dateStr) return "";
    const d = new Date(dateStr + "T00:00:00Z");
    return Number.isNaN(d.getTime()) ? dateStr : d.toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  };

  // ── sheet building blocks ────────────────────────────────────────────
  function card(key, title, hint, body, wide) {
    return `<section class="opr-card${wide ? " wide" : ""}" style="--k:${K[key]}">
      <header class="opr-card-h"><span class="opr-dot"></span><span class="opr-card-t">${title}</span>${hint ? `<span class="opr-hint">${hint}</span>` : ""}</header>
      ${body}
    </section>`;
  }
  // one breakdown figure in a headline tile; `alert` marks the one that needs attention (P0, over 24 h)
  function chip(label, value, alert) {
    return `<div class="opr-split-c${alert ? " alert" : ""}"><span>${label}</span><b>${nf(value)}</b></div>`;
  }
  // a headline tile: label (and a short hint), the big figure (coloured only when the colour means
  // something, as for utilisation), an optional extra (the utilisation bar), then the breakdown as an even
  // row of columns pinned to the bottom so the three tiles line up
  function hero(key, label, value, chips, note, hint, extra, valueColour) {
    return `<div class="opr-hero" style="--k:${valueColour || K[key]}">
      <div class="opr-hero-top"><span class="opr-hero-k">${label}</span>${hint ? `<span class="opr-hero-hint">${hint}</span>` : ""}</div>
      <b class="opr-hero-v"${valueColour ? ` style="color:${valueColour}"` : ""}>${value}</b>
      ${extra || ""}
      ${note}
      <div class="opr-split" style="grid-template-columns:repeat(${chips.length}, minmax(0, 1fr))">${chips.join("")}</div>
    </div>`;
  }
  function sheetHead(title, generatedAt) {
    return `<div class="opr-title-row">
      <div><span class="opr-title-sub">AOS &middot; One Pager Report</span><div class="opr-title">${title}</div></div>
      <div class="opr-gen-note">Generated ${esc(Fmt.when(generatedAt))}</div>
    </div>`;
  }

  function shiftRowHtml(label, row) {
    const r = row || {};
    const cell = (v, cls = "") => `<td class="${cls}${v === 0 ? " opr-zero" : ""}">${nf(v)}</td>`;
    return `<tr><td class="opr-label">${esc(label)}</td>${cell(r.A)}${cell(r.B)}${cell(r.C)}${cell(r.Total, "opr-total")}</tr>`;
  }
  const SHIFT_HEAD = `<thead><tr><th class="opr-label">Shift</th><th>A</th><th>B</th><th>C</th><th>Total</th></tr></thead>`;

  // ASRS Production: Department / Shift / Hour 1-8 / Total, the legacy one-pager's layout. The Department
  // label is REPEATED on each of its 3 shift rows, not rowspan-merged: html2canvas (the PNG export) draws
  // a rowspan cell blank. The Excel export (onePagerReportExcel.js) is a separate path and still merges.
  // hour cells; a zero is drawn faint so the hours that actually ran stand out
  function asrsHourCellsHtml(hours) {
    const arr = hours || [];
    return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (arr[i] === 0 ? '<td class="opr-zero">0</td>' : `<td>${nf(arr[i])}</td>`)).join("");
  }
  // One department as a group: its total row first (the department name, per-hour sums of the shifts that
  // have data - an hour with no data in any shift stays "No data", never a made-up zero), then its three
  // shift rows indented under it. No rowspan: html2canvas (PNG export) draws a rowspan cell blank.
  function asrsProductionDeptRowsHtml(label, hoursByShift, unit) {
    const sumHours = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
      const vals = ["A", "B", "C"].map((c) => hoursByShift && hoursByShift[c] && hoursByShift[c][i]).filter((v) => v != null);
      return vals.length ? vals.reduce((a, v) => a + v, 0) : null;
    });
    const deptTotal = sumHours.some((v) => v != null) ? sumHours.reduce((a, v) => a + (v || 0), 0) : null;
    const shiftRows = ["A", "B", "C"]
      .map((code) => {
        const hours = hoursByShift && hoursByShift[code];
        const total = hours && hours.length === 8 ? hours.reduce((s, v) => s + v, 0) : null;
        return `<tr class="opr-shiftrow"><td class="opr-label">Shift ${code}</td>${asrsHourCellsHtml(hours)}<td class="opr-total${total === 0 ? " opr-zero" : ""}">${nf(total)}</td></tr>`;
      })
      .join("");
    return `<tr class="opr-grouprow"><td class="opr-label">${esc(label)}${unit ? ` <span class="opr-unit">${esc(unit)}</span>` : ""}</td>${asrsHourCellsHtml(sumHours)}<td class="opr-total">${nf(deptTotal)}</td></tr>${shiftRows}`;
  }
  // The grand total - ONE row: the sum of the six department/shift rows per hour
  // (server: onePagerReportEngine.js's pickingOverallRow()).
  // ...followed by every department added together per shift (A / B / C), hour by hour - the departments
  // that failed (null) are left out, as in the Total row above
  function asrsPickingOverallRowHtml(pickingOverall, hoursByDept) {
    const hours = (pickingOverall && pickingOverall.hours) || [];
    const total = pickingOverall ? pickingOverall.total : null;
    const depts = Object.values(hoursByDept || {}).filter(Boolean);
    const shiftRows = ["A", "B", "C"].map((code) => {
      const per = depts.length ? [0, 1, 2, 3, 4, 5, 6, 7].map((i) => depts.reduce((a, d) => a + ((d[code] && d[code][i]) || 0), 0)) : [];
      const sum = per.length ? per.reduce((a, v) => a + v, 0) : null;
      return `<tr class="opr-shiftrow opr-totalshift"><td class="opr-label">Shift ${code}</td>${asrsHourCellsHtml(per)}<td class="opr-total${sum === 0 ? " opr-zero" : ""}">${nf(sum)}</td></tr>`;
    }).join("");
    return `<tr class="opr-grandrow"><td class="opr-label">Total</td>${asrsHourCellsHtml(hours)}<td class="opr-total">${nf(total)}</td></tr>${shiftRows}`;
  }
  // the server's department labels ("ASRS-JIT", "ASRS-FR1 (NJIT)") shown short
  const deptName = (label) => (/njit/i.test(label) ? "NJIT" : /\bjit/i.test(label) ? "JIT" : label);
  const HOURS_HEAD = [1, 2, 3, 4, 5, 6, 7, 8].map((h) => `<th>H${h}</th>`).join("");

  // A section that failed on its own shows the reason inline, never silent dashes that read like a real zero.
  function unavailableNote(report, key) {
    const reason = report.sectionErrors && report.sectionErrors[key];
    if (reason) return `<p class="opr-unavailable opr-nodata">&#9888; Data unavailable — ${esc(reason)}</p>`;
    // Fresh fetch failed but a last good value exists: shown, and flagged, never silently reused.
    const stale = report.sectionStale && report.sectionStale[key];
    return stale ? `<p class="opr-unavailable">&#9888; Showing the last good data (since ${esc(Fmt.time(stale.since))}) - the latest refresh failed: ${esc(String(stale.reason).slice(0, 120))}</p>` : "";
  }

  function sheetHtml(report) {
    const lt = (report.lockedTotes && report.lockedTotes.summary) || {};
    const ut = (report.utilisation && report.utilisation.totals) || {};
    const tia = report.totesInAsrs || {};
    const ot = report.outsideTote || {};
    const cc = (report.ccMetrics && report.ccMetrics.shifts) || {};
    const cp = (report.compaction && report.compaction.shifts) || {};
    const apHours = (report.asrsProduction && report.asrsProduction.hours) || {};
    const apPickingOverall = report.asrsProduction && report.asrsProduction.pickingOverall;
    const ao = report.aisleOccupancy;
    const caps = report.utilisationCaps || {};

    // occupancy cells tinted by value (rgba, so html2canvas can draw it)
    const aisleRow = (label, row) => {
      const r = row || { values: [], average: null };
      const cells = (r.values || []).map((v) => (v == null ? "<td>—</td>" : `<td style="background:rgba(37,99,235,${(0.06 + Math.min(Math.max(v, 0), 100) / 100 * 0.32).toFixed(3)})">${Number(v).toFixed(1)}%</td>`)).join("");
      return `<tr><td class="opr-label">${esc(label)}</td>${cells}<td class="opr-total">${alreadyPct(r.average)}</td></tr>`;
    };
    const utilPctNum = ut.util == null ? 0 : Math.min(Math.max(Number(ut.util) * 100, 0), 100);

    // Each number appears once. The three right-now snapshots that are a single row of numbers (locked,
    // outside, utilisation) are the headline tiles, with their breakdown inside; everything with shifts,
    // aisles or frame / lens splits is a table card below.
    const locked = hero("lock", "Locked totes", nf(lt.total), [
      chip("Supervisor", lt.sdCount), chip("P0 Critical", lt.p0Count, true), chip("P1 High", lt.p1Count), chip("P2 Standard", lt.p2Count),
    ], unavailableNote(report, "lockedTotes"));
    const outside = hero("out", "Outside totes", nf(ot.total), [
      chip("12 – 24 hours", ot.h12to24), chip("Over 24 hours", ot.h24plus, true),
    ], unavailableNote(report, "outsideTote"), "not Bad Tracker");
    const util = hero(null, "Tote utilisation", pct(ut.util), [
      chip("Totes", ut.totes), chip("Quantity", ut.qty), chip("Capacity", ut.cap),
    ], unavailableNote(report, "utilisation"), `caps lens / frame: TL ${nf(caps.largeLens)} / ${nf(caps.largeFrame)} &middot; TS ${nf(caps.smallLens)} / ${nf(caps.smallFrame)}`,
      `<div class="opr-util-bar"><i style="width:${utilPctNum.toFixed(1)}%;background:${utilColour(ut.util)}"></i></div>`, utilColour(ut.util));

    const asrs = card("asrs", "Totes In ASRS", "", `${unavailableNote(report, "utilisation")}
      <table class="opr-table">
        <thead><tr><th class="opr-label">Tote</th><th>Frame</th><th>Lens</th><th>Total</th></tr></thead>
        <tbody>
          <tr><td class="opr-label">Large Tote</td><td>${nf(tia.large && tia.large.frame)}</td><td>${nf(tia.large && tia.large.lens)}</td><td class="opr-total">${nf(tia.large && tia.large.total)}</td></tr>
          <tr><td class="opr-label">Small Tote</td><td>${nf(tia.small && tia.small.frame)}</td><td>${nf(tia.small && tia.small.lens)}</td><td class="opr-total">${nf(tia.small && tia.small.total)}</td></tr>
          <tr class="opr-sumrow"><td class="opr-label">Total</td><td>${nf(tia.total && tia.total.frame)}</td><td>${nf(tia.total && tia.total.lens)}</td><td class="opr-total">${nf(tia.total && tia.total.total)}</td></tr>
        </tbody>
      </table>`);

    const aisle = card("aisle", "Aisle Occupancy", "darker = fuller", `${unavailableNote(report, "aisleOccupancy")}
      <table class="opr-table">
        <thead><tr><th class="opr-label">Aisle</th><th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>Avg</th></tr></thead>
        <tbody>
          ${aisleRow("Occupancy", ao && ao.occupancy)}
          ${aisleRow("Large", ao && ao.large)}
          ${aisleRow("Short", ao && ao.short)}
        </tbody>
      </table>`);

    // Cycle Count (5 rows) on the left; Compaction and Station Coverage (2 rows each) stacked on the right,
    // so the two columns end level instead of one short card beside a tall one.
    const cycleCount = card("cc", "Cycle Count", "CC done and discrepancies", `${unavailableNote(report, "ccMetrics")}
      <table class="opr-table">${SHIFT_HEAD}<tbody>
        ${shiftRowHtml("CC Done", cc.ccDone)}
        ${cc.bermudaTotes ? shiftRowHtml("Bermuda Totes", cc.bermudaTotes) : ""}
        ${cc.purgedTotes ? shiftRowHtml("Purged Totes", cc.purgedTotes) : ""}
        ${cc.shortQty ? shiftRowHtml("Quantity Marked Short", cc.shortQty) : ""}
        ${shiftRowHtml("Discrepancies Marked", cc.discrepancies)}
      </tbody></table>`);

    const coverage = card("cc", "Station Coverage", "", `${unavailableNote(report, "ccMetrics")}
      <table class="opr-table">${SHIFT_HEAD}<tbody>
        ${shiftRowHtml("CC Stations Ran", cc.ccStationsRan)}
        ${shiftRowHtml("Stations Flagged", cc.discrepancyStations)}
      </tbody></table>`);

    const compaction = card("comp", "Compaction", "", `${unavailableNote(report, "compaction")}
      <table class="opr-table">${SHIFT_HEAD}<tbody>
        ${shiftRowHtml("Compaction", cp.compaction)}
        ${shiftRowHtml("Tote Freed", cp.toteFreed)}
      </tbody></table>`);

    const production = card("prod", "ASRS Production", `Completed orders per hour - FR0-Bulk in items picked${report.asrsProduction && report.asrsProduction.incomplete ? ` · ${esc(report.asrsProduction.incomplete.join(", "))} unavailable` : ""}`, `${unavailableNote(report, "asrsProduction")}
      <div class="opr-table-wide-wrap">
        <table class="opr-table opr-table-wide">
          <thead><tr><th class="opr-label">Department / shift</th>${HOURS_HEAD}<th>Total</th></tr></thead>
          <tbody>
            ${asrsProductionDeptRowsHtml("JIT", apHours.jit)}
            ${asrsProductionDeptRowsHtml("NJIT", apHours.njit)}
            ${asrsProductionDeptRowsHtml("FR0", apHours.fr0)}
            ${asrsProductionDeptRowsHtml("FR0-Bulk", apHours.bulk, "items")}
            ${asrsPickingOverallRowHtml(apPickingOverall, apHours)}
          </tbody>
        </table>
      </div>`, true);

    return `<div class="opr-sheet">
        ${sheetHead(`ASRS Snapshot &mdash; ${esc(prettyDate(report.reportDate))}`, report.generatedAt)}
        <div class="opr-heroes">${locked}${outside}${util}</div>
        <div class="opr-grid">${asrs}${aisle}${cycleCount}<div class="opr-stack">${compaction}${coverage}</div>${production}</div>
      </div>`;
  }

  function setDailyButtons(on) {
    for (const id of ["oprCsvBtn", "oprPngBtn"]) $(id).disabled = !on;
  }

  function render() {
    const container = $("oprResult");
    if (!_report) {
      container.innerHTML = `<div class="panel dd-empty-state"><i class="ico" data-i="report"></i><h4>No report yet</h4><p>Pick the report date, adjust the capacities if needed, and press Generate report. The latest report anyone generated also shows up here.</p></div>`;
      setDailyButtons(false);
      return;
    }
    container.innerHTML = sheetHtml(_report);
    setDailyButtons(true);
  }

  // ── Bulk (day-range) report rendering ────────────────────────────────
  // Same {days, total, average} shape onePagerReportBulkEngine.js builds - rendered as-is, never re-derived.
  function bulkShiftTableHtml(key, title, table) {
    const dayRows = table.days
      .map((d) => `<tr><td class="opr-label">${esc(d.dateStr)}</td><td>${nf(d.A)}</td><td>${nf(d.B)}</td><td>${nf(d.C)}</td><td class="opr-total">${nf(d.Total)}</td></tr>`)
      .join("");
    const summaryRow = (r) => `<tr class="opr-bulk-summary"><td class="opr-label">${esc(r.dateStr)}</td><td>${nf(r.A)}</td><td>${nf(r.B)}</td><td>${nf(r.C)}</td><td class="opr-total">${nf(r.Total)}</td></tr>`;
    return card(key, esc(title), "", `<table class="opr-table">
        <thead><tr><th class="opr-label">Date</th><th>A</th><th>B</th><th>C</th><th>Total</th></tr></thead>
        <tbody>${dayRows}${summaryRow(table.total)}${summaryRow(table.average)}</tbody>
      </table>`);
  }

  function bulkHoursTableHtml(title, table) {
    const dayRows = table.days
      .map((d) => `<tr><td class="opr-label">${esc(d.dateStr)}</td>${asrsHourCellsHtml(d.hours)}<td class="opr-total">${nf(d.total)}</td></tr>`)
      .join("");
    const summaryRow = (r) => `<tr class="opr-bulk-summary"><td class="opr-label">${esc(r.dateStr)}</td>${r.hours.map((v) => `<td>${nf(v)}</td>`).join("")}<td class="opr-total">${nf(r.total)}</td></tr>`;
    return card("prod", title, "", `<div class="opr-table-wide-wrap">
        <table class="opr-table opr-table-wide">
          <thead><tr><th class="opr-label">Date</th>${HOURS_HEAD}<th>Total</th></tr></thead>
          <tbody>${dayRows}${summaryRow(table.total)}${summaryRow(table.average)}</tbody>
        </table>
      </div>`, true);
  }

  function bulkSheetHtml(report) {
    const ap = report.asrsProductionBulk || { groups: [], pickingOverall: null };
    const cc = report.ccMetricsBulk || [];
    const cp = report.compactionBulk || [];
    const daysWithIssues = (report.days || []).filter((d) => d.sectionErrors && (d.sectionErrors.ccMetrics || d.sectionErrors.compaction || d.sectionErrors.asrsProduction));
    const issuesNote = daysWithIssues.length
      ? `<p class="opr-unavailable">&#9888; ${daysWithIssues.length} of ${report.dayCount} day(s) had a section fail — those days are excluded from that section's TOTAL/AVERAGE, not counted as zero. Affected: ${daysWithIssues.map((d) => esc(d.dateStr)).join(", ")}</p>`
      : "";

    return `<div class="opr-sheet">
        ${sheetHead(`Day-range Report &mdash; ${esc(prettyDate(report.startDate))} to ${esc(prettyDate(report.endDate))} &middot; ${nf(report.dayCount)} days`, report.generatedAt)}
        ${issuesNote}
        <p class="opr-section">ASRS Production &mdash; day-wise</p>
        <div class="opr-grid">
          ${ap.groups.map((g) => bulkHoursTableHtml(`${esc(deptName(g.label))} &mdash; Shift ${esc(g.shift)}`, g.table)).join("")}
          ${ap.pickingOverall ? bulkHoursTableHtml("Total — JIT + NJIT + FR0 + FR0-Bulk", ap.pickingOverall) : ""}
        </div>
        <p class="opr-section">CC Metrics / Station Coverage &mdash; day-wise</p>
        <div class="opr-grid">${cc.map((m) => bulkShiftTableHtml("cc", m.label.replace(/\s*\([^)]*\)/g, ""), m.table)).join("")}</div>
        <p class="opr-section">Compaction / Tote Freed &mdash; day-wise</p>
        <div class="opr-grid">${cp.map((m) => bulkShiftTableHtml("comp", m.label, m.table)).join("")}</div>
      </div>`;
  }

  function renderBulk() {
    const container = $("oprBulkResult");
    if (!_bulkReport) {
      container.innerHTML = `<div class="panel dd-empty-state"><i class="ico" data-i="clock"></i><h4>No range report yet</h4><p>Pick a range (or a quick pick) and press Generate range report. Every day in the range is fetched, so it can take a little while.</p></div>`;
      $("oprBulkXlsxBtn").disabled = true;
      return;
    }
    container.innerHTML = bulkSheetHtml(_bulkReport);
    $("oprBulkXlsxBtn").disabled = false;
  }

  function fail(errId, statusId, message) {
    $(errId).textContent = message;
    $(errId).classList.remove("hidden");
    $(statusId).textContent = "";
  }

  async function generateBulk() {
    const btn = $("oprBulkGenerateBtn");
    $("oprBulkError").classList.add("hidden");
    btn.disabled = true;
    $("oprBulkStatus").textContent = "Starting the range report…";
    try {
      const startDate = $("oprBulkStartDate").value;
      const endDate = $("oprBulkEndDate").value;
      if (!startDate || !endDate) throw new Error("Pick both a start date and an end date.");
      const query = await Api.post("/one-pager-report/bulk/generate", { startDate, endDate });
      _bulkQueryId = query.queryId;
      $("oprBulkStatus").textContent = "Fetching CC Metrics, Compaction and ASRS Production for every day in the range — this can take a little while…";
      watchBulk();
    } catch (e) {
      btn.disabled = false;
      fail("oprBulkError", "oprBulkStatus", e.message);
    }
  }

  // Follows the bulk run over the live stream ("query:<id>") instead of polling.
  function watchBulk() {
    if (_bulkStop) _bulkStop();
    const watchedId = _bulkQueryId;
    _bulkStop = Live.watch("query:" + watchedId, (evt) => {
      if (watchedId !== _bulkQueryId) return true;
      const btn = $("oprBulkGenerateBtn");
      if (evt.type === "feed-error") {
        btn.disabled = false;
        fail("oprBulkError", "oprBulkStatus", evt.message);
        return true;
      }
      if (evt.type !== "data") return false;
      const query = evt.data;
      if (!BULK_TERMINAL.has(query.status)) return false;
      btn.disabled = false;
      if (query.status !== "COMPLETED") {
        fail("oprBulkError", "oprBulkStatus", query.error || `Range report ended: ${query.status}`);
        return true;
      }
      Api.get("/one-pager-report/bulk/current").then((report) => {
        _bulkReport = report;
        $("oprBulkStatus").textContent = `Done — ${Fmt.when(_bulkReport.generatedAt)}`;
        renderBulk();
      }).catch((e) => fail("oprBulkError", "oprBulkStatus", e.message));
      return true;
    });
  }

  async function generate() {
    if (_generating) return;
    _generating = true;
    const btn = $("oprGenerateBtn");
    $("oprError").classList.add("hidden");
    btn.disabled = true;
    $("oprStatus").textContent = "Fetching Locked Totes, Compaction, CC Metrics, Utilisation, Outside Totes, Production and Aisle Occupancy — this can take a little while…";
    try {
      const reportDate = $("oprReportDate").value || undefined;
      _report = await Api.post("/one-pager-report/generate", { utilisationCaps: capsFromInputs(), reportDate });
      $("oprStatus").textContent = `Done — ${Fmt.when(_report.generatedAt)}`;
      render();
    } catch (e) {
      fail("oprError", "oprStatus", e.message);
    } finally {
      btn.disabled = false;
      _generating = false;
    }
  }

  // PNG export - snapshots the rendered .opr-sheet (exactly what is on screen) with html2canvas, so it
  // never drifts from sheetHtml(). Client-side only.
  async function downloadPng() {
    const btn = $("oprPngBtn");
    $("oprError").classList.add("hidden");
    if (!window.html2canvas) {
      fail("oprError", "oprStatus", "PNG export failed to load (html2canvas.min.js) - try refreshing the page.");
      return;
    }
    const sheetEl = document.querySelector("#oprResult .opr-sheet");
    if (!_report || !sheetEl) return;
    btn.disabled = true;
    $("oprStatus").textContent = "Rendering PNG…";
    try {
      // scale 2 so the text stays sharp once shared and zoomed; white behind the light sheet
      const canvas = await window.html2canvas(sheetEl, { backgroundColor: "#ffffff", scale: 2, useCORS: true });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("Canvas produced no image data");
      const date = _report.reportDate || (_report.generatedAt || "").slice(0, 10);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `asrs-daily-report-${date}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1500);
      $("oprStatus").textContent = "PNG downloaded.";
    } catch (e) {
      fail("oprError", "oprStatus", e.message);
    } finally {
      btn.disabled = false;
    }
  }

  // The latest report is pushed by the server ("one-pager.current") so a report generated by someone else
  // shows up here too; subscribed only while this tab is open. Never overwrites while this user is generating.
  let currentOff = null;
  function start() {
    if (currentOff) return;
    currentOff = Live.subscribe("one-pager.current", (evt) => {
      if (evt.type !== "data" || _generating || !evt.data || evt.data.empty) return;
      if (_report && _report.generatedAt === evt.data.generatedAt) return;
      _report = evt.data;
      render();
    });
  }
  function stop() {
    if (currentOff) { currentOff(); currentOff = null; }
  }

  // ── mode and range controls ──────────────────────────────────────────
  function setMode(mode) {
    $("oprDaily").hidden = mode !== "daily";
    $("oprRange").hidden = mode !== "range";
    $("oprModeSeg").querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  }
  function rangeDaysNote() {
    const s = $("oprBulkStartDate").value;
    const e = $("oprBulkEndDate").value;
    const n = s && e ? Math.round((Date.parse(e) - Date.parse(s)) / 86400000) + 1 : 0;
    $("oprRangeDays").textContent = n > 0 ? `${n} day${n === 1 ? "" : "s"}` : "pick a valid range";
  }
  function pickPreset(days) {
    const today = todayIST();
    $("oprBulkEndDate").value = today;
    $("oprBulkStartDate").value = minusDaysIST(today, days - 1);
    $("oprRangePresets").querySelectorAll("[data-days]").forEach((b) => b.classList.toggle("active", Number(b.dataset.days) === days));
    rangeDaysNote();
  }

  function mount() {
    $("oprReportDate").value = todayIST();
    $("oprGenerateBtn").addEventListener("click", generate);
    $("oprCsvBtn").addEventListener("click", () => { window.location.href = "/api/v1/one-pager-report/xlsx"; });
    $("oprPngBtn").addEventListener("click", downloadPng);
    render();

    $("oprModeSeg").addEventListener("click", (ev) => { const b = ev.target.closest("[data-mode]"); if (b) setMode(b.dataset.mode); });
    $("oprRangePresets").addEventListener("click", (ev) => { const b = ev.target.closest("[data-days]"); if (b) pickPreset(Number(b.dataset.days)); });
    for (const id of ["oprBulkStartDate", "oprBulkEndDate"]) {
      $(id).addEventListener("input", () => {
        $("oprRangePresets").querySelectorAll("[data-days]").forEach((b) => b.classList.remove("active"));
        rangeDaysNote();
      });
    }
    pickPreset(15); // the operators' usual 15-day review
    $("oprBulkGenerateBtn").addEventListener("click", generateBulk);
    $("oprBulkXlsxBtn").addEventListener("click", () => { window.location.href = "/api/v1/one-pager-report/bulk/xlsx"; });
    renderBulk();
  }

  return { mount, start, stop };
})();
