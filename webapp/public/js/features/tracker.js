// Outside Tote Analysis (Tracker) - 100% READ-ONLY bulk tote lookup. Never
// calls PULL_QUADRON_TOTE, never touches Manual/Auto Tote Puller state.
const TrackerPanel = (() => {
  const toteListEl = document.getElementById("trTotes");
  const toteCountEl = document.getElementById("trToteCount");
  const modeSeg = document.getElementById("trModeSeg");
  const modeNoteEl = document.getElementById("trModeNote");
  const statusBar = document.getElementById("trStatusBar");
  const emptyEl = document.getElementById("trEmpty");
  const resultsPanel = document.getElementById("trResultsPanel");
  const resultsNoteEl = document.getElementById("trResultsNote");
  const searchEl = document.getElementById("trSearch");
  const runBtn = document.getElementById("trRunBtn");
  const csvBtn = document.getElementById("trCsvBtn");
  const statusEl = document.getElementById("trStatus");
  const progressBar = document.getElementById("trProgressBar");
  const errBox = document.getElementById("trError");
  const summaryPanel = document.getElementById("trSummaryPanel");
  const resultsBody = document.getElementById("trResultsBody");
  const resultsTableEl = document.getElementById("trResultsTable");

  const manualFieldsEl = document.getElementById("trManualFields");
  const autoStatsEl = document.getElementById("trAutoStats");
  const updatedHeaderEl = document.getElementById("trUpdatedHeader");
  const updatedSortArrowEl = document.getElementById("trUpdatedSortArrow");

  // Updated-column sort (operator-requested toggle, oldest<->newest) - 0 =
  // the API's own row order (unsorted, the default until the header is
  // clicked), 1 = oldest first, -1 = newest first. Display-only: lastRows
  // itself (and CSV export, which reads it) always stays in the original
  // order the run actually returned.
  let _updatedSortDir = 0;

  let mode = "manual"; // the "Which totes" choice: "auto" (every OUT tote > 12 h) | "manual" (a pasted list)
  const facility = "NXS1"; // the site's only facility; the API still takes it, so it is sent as before
  // display-only filters over the last run's rows; CSV export always has every row
  const _filters = { q: "", status: "ALL", age: "ALL" };
  let lastMode = "manual"; // "manual" | "auto" - which endpoint the last completed run actually used (CSV export and the Auto-Mode-only columns key off this, not the checkbox's current, possibly-since-changed state)

  const sumOutEl = document.getElementById("trSumOut");
  const sumBadEl = document.getElementById("trSumBad");
  const sumVirtualEl = document.getElementById("trSumVirtual");
  const sumTotalEl = document.getElementById("trSumTotal");
  const sum12El = document.getElementById("trSum12");
  const sum24El = document.getElementById("trSum24");

  let lastRows = [];

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  // Grafana's MSSQL datasource marshals location_tracker.updated_timestamp -
  // a naive, no-timezone SQL Server column - by treating its raw digits AS
  // IF they were already UTC (a well-documented Grafana+MSSQL driver quirk:
  // any datetime column with no offset gets epoch-converted assuming UTC).
  // This facility's DB actually stores those digits in IST wall-clock time -
  // see server/lib/shiftWindows.js's own `Date.UTC(...) - 5.5 * 3600000`
  // compensation for the exact same quirk, on a different table through the
  // same datasource (uid rerQ11pVk). Re-parsing the value through plain
  // `new Date(v).toLocaleString()` would silently shift it +5:30 in an IST
  // browser (or by whatever offset a non-IST browser happens to be in).
  //
  // Fix: never let the runtime's own timezone re-interpret the value.
  // Recover the ORIGINAL raw digits directly - for a number (epoch ms, the
  // shape this field actually arrives as under Grafana's "table" format),
  // read its UTC calendar fields (never IST-converted - Grafana computed
  // epoch = Date.UTC(rawDigits), so reading the UTC fields back out IS the
  // original digits); for a string, read the same Y-M-D h:m:s digits
  // directly via regex, ignoring any "Z"/offset Grafana may have appended.
  // Shared by fmtDate() (display) and parseIstMs() (a genuine comparable
  // epoch, for sorting/age) - both must parse identically or the displayed
  // date and the age/sort order could silently disagree.
  function parseDateDigits(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number" || /^-?\d+$/.test(String(v))) {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      }).formatToParts(new Date(Number(v)));
      const get = (t) => parts.find((p) => p.type === t).value;
      return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
    }
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null; // unrecognized shape - fmtDate shows it verbatim rather than guess; parseIstMs treats it as unparseable
    const [, y, mo, d, h, mi, s] = m;
    return { y, mo, d, h, mi, s };
  }

  // Display only - shows the raw wall-clock digits AS-IS (this facility's
  // own clock reading), not a converted value. The former trailing " IST"
  // label was dropped (operator-requested) - every timestamp in this table
  // is this facility's own clock by construction, so the label was never
  // disambiguating anything for the people actually reading this screen.
  function fmtDate(v) {
    const p = parseDateDigits(v);
    if (!p) return v == null || v === "" ? "—" : String(v);
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${p.d}-${MONTHS[Number(p.mo) - 1]}-${p.y}, ${p.h}:${p.mi}:${p.s}`;
  }

  // A genuine, comparable UTC epoch-ms value (unlike fmtDate's raw digits,
  // which are deliberately NOT timezone-converted for display) - needed for
  // sort ordering and for hoursBucketLabel()'s real elapsed-time math. IST
  // is UTC+5:30, so a wall-clock reading of Y-M-D h:m:s IST corresponds to
  // that same instant minus 5.5h in true UTC - the same correction
  // server/lib/shiftWindows.js's istToParamMs() applies to already-known
  // calendar components; this applies it to a raw Grafana value instead.
  function parseIstMs(v) {
    const p = parseDateDigits(v);
    if (!p) return null;
    return Date.UTC(Number(p.y), Number(p.mo) - 1, Number(p.d), Number(p.h), Number(p.mi), Number(p.s)) - 5.5 * 3600000;
  }

  // Age bucket (operator-requested) - same concept as the Dashboard's own
  // existing "12–24 Hours" / "Above 24 Hours" wording (see
  // dashOutsideTotesBody's table in index.html), but spelled here with a
  // plain ASCII hyphen rather than an en-dash: this label also flows into
  // CSV export (exportCsv() below), and a CSV with no UTF-8 BOM opened in
  // Excel misreads a non-ASCII en-dash via the system codepage instead of
  // UTF-8 - confirmed live (operator-reported: "12ae"24 hours" in the
  // exported dump). Plain ASCII sidesteps the whole encoding question
  // rather than adding a BOM to fix it. Anything under 12h (or
  // unparseable) shows "—" - not every row is stale (a Manual Mode paste
  // can be perfectly fresh), and there's no third bucket requested for
  // that case; that placeholder never leaves this app's existing "—" =
  // empty convention, used the same way in dozens of other modules.
  function hoursBucketLabel(v) {
    const ms = parseIstMs(v);
    if (ms == null) return "—";
    const ageHours = (Date.now() - ms) / 3600000;
    if (ageHours < 12) return "—";
    return ageHours < 24 ? "12-24 Hours" : "Above 24 Hours";
  }

  // the age bucket as a coloured chip (amber 12-24 h, red over 24 h); the CSV keeps the plain label
  function ageCell(v) {
    const label = hoursBucketLabel(v);
    if (label === "—") return label;
    return `<span class="tr-age ${label === "Above 24 Hours" ? "old" : "mid"}">${label === "Above 24 Hours" ? "Over 24 h" : "12–24 h"}</span>`;
  }

  function updateToteCount() {
    const totes = ToteListParser.parseToteList(toteListEl.value);
    toteCountEl.textContent = `${totes.length} valid tote${totes.length === 1 ? "" : "s"}`;
  }

  // Auto Mode just swaps the input method (paste a list vs. discover
  // automatically) - toggled live off the checkbox. Which columns/CSV shape
  // the RESULTS actually get is decided separately, in run(), from which
  // endpoint that specific run used (lastMode) - not from this live toggle,
  // so switching the checkbox after a run never relabels stale results.
  function updateModeUI() {
    const auto = mode === "auto";
    manualFieldsEl.classList.toggle("hidden", auto);
    modeNoteEl.textContent = auto
      ? "Finds every tote with Location = OUT for more than 12 hours by itself - no list needed."
      : "Looks up only the totes you paste below.";
  }

  // One handler per segmented control: mark the pressed button, report its value.
  function wireSeg(seg, onPick) {
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-v]");
      if (!b) return;
      seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      onPick(b.dataset.v);
    });
  }

  // On Location / Buffer tiles dropped (operator-requested) - this module
  // works directly with OUTSIDE totes, so those two other statuses aren't
  // relevant summary-level numbers here (a row with either status - rare in
  // practice, since Manual paste and Auto discovery both center on outside/
  // stale totes - still shows its real status badge in the results table
  // below, this is only about what the top-line tiles surface). Virtual
  // Tote replaces them - the operator's own exception list (see
  // trackerReconcile.js's VIRTUAL_TOTE_IDS), always counted separately from
  // "Outside Tote" even though most of those totes ARE genuinely
  // Location=OUT under the hood.
  function renderSummary(rows) {
    const n = (s) => rows.filter((r) => !r.error && r.status === s).length;
    sumOutEl.textContent = n("Outside Tote");
    sumBadEl.textContent = n("Bad Tracker");
    sumVirtualEl.textContent = n("Virtual Tote");
    sumTotalEl.textContent = rows.length;
    const age = (label) => rows.filter((r) => !r.error && hoursBucketLabel(r.updated) === label).length;
    sum12El.textContent = age("12-24 Hours");
    sum24El.textContent = age("Above 24 Hours");
  }

  function filtered(rows) {
    const q = _filters.q.trim().toUpperCase();
    return rows.filter((r) =>
      (!q || String(r.tote || "").toUpperCase().includes(q)) &&
      (_filters.status === "ALL" || (!r.error && r.status === _filters.status)) &&
      (_filters.age === "ALL" || (!r.error && hoursBucketLabel(r.updated) === _filters.age))
    );
  }

  // Auto-Mode-only fields (Zone/Shuttle/Shuttle Health/Stock Check Blocked/
  // Bin Blocked) come from GET_GRAFANA_CONTAINER_TRACKING and are only ever
  // present on rows from an Auto Mode run - a Manual Mode row simply has no
  // such field, which renders as "—" here exactly like any other missing
  // value elsewhere in this table.
  function autoPillCell(v) {
    if (v == null || v === "") return "—";
    return `<span class="status-pill status-tr-${String(v).replace(/\s+/g, "_").toUpperCase()}">${escHtml(v)}</span>`;
  }

  // A scan cell shows the scanner name (bold) with its decision reason
  // below in smaller muted text - two-line cell, matching the reference's
  // own .sc/.rs breakdown (not just a single latest-scan date).
  function scanCell(scan) {
    if (!scan) return "";
    const reason = scan.reason == null ? "—" : escHtml(scan.reason);
    return `<div class="tr-scan-name">${escHtml(scan.scanner)}</div><div class="tr-scan-why" title="decision: ${escHtml(scan.decision)}">${reason}</div>`;
  }

  // Sorts a COPY for display only - lastRows (and CSV export) keep the
  // original API order regardless of the current column sort. A row whose
  // Updated timestamp can't be parsed sorts last in either direction, never
  // guessed into a position.
  function sortedForDisplay(rows) {
    if (_updatedSortDir === 0) return rows;
    return [...rows].sort((a, b) => {
      const ma = a.error ? null : parseIstMs(a.updated);
      const mb = b.error ? null : parseIstMs(b.updated);
      if (ma == null && mb == null) return 0;
      if (ma == null) return 1;
      if (mb == null) return -1;
      return (ma - mb) * _updatedSortDir;
    });
  }

  function updateSortArrow() {
    updatedHeaderEl.classList.toggle("tr-sorted", _updatedSortDir !== 0);
    updatedSortArrowEl.innerHTML = _updatedSortDir === 1 ? '<i class="ico" data-i="chevup"></i>' : _updatedSortDir === -1 ? '<i class="ico" data-i="chevdown"></i>' : "";
  }

  function renderRows(rows) {
    lastRows = rows;
    renderSummary(rows);
    const shown = filtered(rows);
    resultsNoteEl.textContent = shown.length === rows.length ? `${rows.length} tote${rows.length === 1 ? "" : "s"}` : `showing ${shown.length} of ${rows.length}`;
    if (!shown.length) {
      resultsBody.innerHTML = `<tr><td colspan="20" class="purge-empty">${rows.length ? "No totes match these filters." : "No results."}</td></tr>`;
      return;
    }
    resultsBody.innerHTML = sortedForDisplay(shown)
      .map((r) => {
        if (r.error) return `<tr><td>${escHtml(r.tote)}</td><td colspan="19" class="tr-row-error">${escHtml(r.error)}</td></tr>`;
        const isCand = r.status === "Outside Tote" || r.status === "Bad Tracker";
        const blkCell = isCand ? (r.blocked == null ? "—" : `<b${r.blocked > 0 ? ' class="tr-blocked"' : ""}>${r.blocked}</b>`) : "";
        let pgCell = "";
        if (isCand) {
          if (r.purgeSafe == null) pgCell = "—";
          else pgCell = `<span class="status-pill status-tr-${r.purgeSafe ? "SAFE" : "UNSAFE"}">${r.purgeSafe ? "Safe" : "Unsafe"}</span>`;
        }
        const statusBadge = r.status ? `<span class="status-pill status-tr-${r.status.replace(/\s+/g, "_").toUpperCase()}">${escHtml(r.status)}</span>` : "—";
        const scans = r.scans || [];
        let scanCells = "";
        for (let i = 0; i < 5; i++) scanCells += `<td${i === 0 ? ' class="tr-seg"' : ""}>${scanCell(scans[i])}</td>`;
        return `<tr>
          <td>${escHtml(r.tote)}</td>
          <td>${escHtml(r.tracker) || "—"}</td>
          <td>${escHtml(r.location) || "—"}</td>
          <td>${statusBadge}</td>
          <td>${escHtml(r.lastGood) || "—"}</td>
          <td>${blkCell}</td>
          <td>${pgCell}</td>
          <td>${escHtml(r.lane) || "—"}</td>
          <td>${fmtDate(r.updated)}</td>
          <td>${ageCell(r.updated)}</td>
          <td class="tr-auto-col">${escHtml(r.zone) || "—"}</td>
          <td class="tr-auto-col">${escHtml(r.shuttle) || "—"}</td>
          <td class="tr-auto-col">${autoPillCell(r.shuttleHealthStatus)}</td>
          <td class="tr-auto-col">${autoPillCell(r.stockCheckBlocked)}</td>
          <td class="tr-auto-col">${autoPillCell(r.binBlocked)}</td>
          ${scanCells}
        </tr>`;
      })
      .join("");
  }

  async function run() {
    errBox.classList.add("hidden");
    const auto = mode === "auto";

    let totes = [];
    if (!auto) {
      totes = ToteListParser.parseToteList(toteListEl.value);
      if (!totes.length) {
        errBox.textContent = "Add at least one valid tote ID (format: TL0000002607).";
        errBox.classList.remove("hidden");
        return;
      }
    }
    runBtn.disabled = true;
    statusBar.hidden = false;
    progressBar.classList.remove("hidden");
    autoStatsEl.classList.add("hidden");
    statusEl.textContent = auto ? "Discovering stale Outside totes…" : `Running ${totes.length} tote(s)…`;
    try {
      const result = await NexsConnect.run({ owner: "tracker", reason: "Outside Totes" }, () => (auto ? Api.post("/tracker/run-auto", { facility }) : Api.post("/tracker/run", { totes, facility })));
      showResult(result, auto, "Done");
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
  function showResult(result, auto, lead) {
    lastMode = auto ? "auto" : "manual";
    resultsTableEl.classList.toggle("tr-auto-mode", auto);
    emptyEl.hidden = true;
    summaryPanel.hidden = false;
    resultsPanel.hidden = false;
    statusBar.hidden = false;
    csvBtn.disabled = !(result.rows || []).length;
    renderRows(result.rows || []);
    const outs = (result.rows || []).filter((r) => r.status === "Outside Tote").length;
    if (auto) {
      autoStatsEl.textContent = `${result.discovered || 0} Location=OUT tote(s) system-wide · ${result.stale || 0} stale >12h · ${(result.rows || []).length} analyzed`;
      autoStatsEl.classList.remove("hidden");
    } else autoStatsEl.classList.add("hidden");
    statusEl.textContent = `${lead} — ${(result.rows || []).length} tote(s) · ${outs} outside`;
  }

  let offShared = null;
  function start() {
    if (offShared) return;
    offShared = SharedRun.follow("tracker", "/tracker", (last) => {
      showResult(last.result || {}, !!(last.meta && last.meta.mode === "auto"), `Last ${last.meta && last.meta.mode === "auto" ? "auto" : "manual"} run ${SharedRun.byLine(last)}`);
    }, () => runBtn.disabled);
  }
  function stop() { if (offShared) { offShared(); offShared = null; } }

  function exportCsv() {
    if (!lastRows.length) return;
    const auto = lastMode === "auto";
    const head = ["Tote", "Tracker", "Location", "Status", "LastGoodLocation", "BlockedOnPIDs", "PurgeSafe", "Lane", "Updated", "AgeBucket"];
    if (auto) head.push("Zone", "Shuttle", "ShuttleHealth", "StockCheckBlocked", "BinBlocked");
    for (let i = 1; i <= 5; i++) head.push(`Scanner ${i}`, `Reason ${i}`);
    const cell = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head.join(",")];
    lastRows.forEach((r) => {
      if (r.error) {
        lines.push([r.tote || "", r.error].map(cell).join(","));
        return;
      }
      const row = [r.tote, r.tracker, r.location, r.status, r.lastGood, r.blocked ?? "", r.purgeSafe == null ? "" : r.purgeSafe ? "Safe" : "Unsafe", r.lane, fmtDate(r.updated), hoursBucketLabel(r.updated)];
      if (auto) row.push(r.zone ?? "", r.shuttle ?? "", r.shuttleHealthStatus ?? "", r.stockCheckBlocked ?? "", r.binBlocked ?? "");
      const scans = r.scans || [];
      for (let i = 0; i < 5; i++) {
        const s = scans[i];
        row.push(s ? s.scanner : "", s ? s.reason ?? "" : "");
      }
      lines.push(row.map(cell).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `outside-tote-analysis-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  toteListEl.addEventListener("input", updateToteCount);
  wireSeg(modeSeg, (v) => { mode = v; updateModeUI(); });
  wireSeg(document.getElementById("trStatusSeg"), (v) => { _filters.status = v; renderRows(lastRows); });
  wireSeg(document.getElementById("trAgeSeg"), (v) => { _filters.age = v; renderRows(lastRows); });
  searchEl.addEventListener("input", () => { _filters.q = searchEl.value; renderRows(lastRows); });
  runBtn.addEventListener("click", run);
  csvBtn.addEventListener("click", exportCsv);
  updatedHeaderEl.addEventListener("click", () => {
    _updatedSortDir = _updatedSortDir === 1 ? -1 : 1; // first click = oldest first, toggles thereafter
    updateSortArrow();
    renderRows(lastRows);
  });
  updateToteCount();
  updateModeUI();
  updateSortArrow();

  return { start, stop };
})();
