// Tote Purge - ANALYSIS ONLY. Triggers POST /tote-purge/generate (which
// itself reads ONLY the already-fetched canonical NEXS ASRS Tote Dump
// snapshot, the NexS Blocked Inventory capability, and the existing
// Quadron Inventory capability - no second ASRS/Sheet fetch), polls the
// existing generic query endpoint, then reads the canonical report from
// GET /tote-purge/current. There is no "Call Tote"/"Execute"/"Dispatch"
// control anywhere in this file or the HTML it drives - the output is a
// report only; the operations team decides what to do with it elsewhere.
const TotePurge = (() => {
  let activeQueryId = null;
  let _last = null; // the full canonical report from /current

  const FACILITY_KEY = "tp_purge_facility";
  const FILTERS_KEY = "tp_purge_filters";
  const DEFAULT_FILTERS = { toteBarcodeMax: 7, partitionMax: 1, pidInvMin: 100, pidToteMin: 3, blockedMode: "both" };

  const $ = (id) => document.getElementById(id);
  const generateBtn = $("tpGenerateBtn");
  const resetBtn = $("tpResetFiltersBtn");
  const statusPill = $("tpStatusPill");
  const statusLine = $("tpStatusLine");
  const errBox = $("tpError");
  const resultsPanel = $("tpResultsPanel");

  const fToteBarcode = $("tpToteBarcode");
  const fPartition = $("tpPartition");
  const fPidInv = $("tpPidInv");
  const fPidTote = $("tpPidTote");
  const fBlockedMode = $("tpBlockedMode");
  const fFacility = $("tpFacility");

  const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── Filters (persisted, same localStorage pattern as every other
  // client-side-only preference in this app) ────────────────────────────
  function loadFilters() {
    try {
      return { ...DEFAULT_FILTERS, ...(JSON.parse(localStorage.getItem(FILTERS_KEY)) || {}) };
    } catch (e) {
      return { ...DEFAULT_FILTERS };
    }
  }
  function saveFilters(f) {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(f));
    } catch (e) {
      /* ignore */
    }
  }
  function readFiltersFromUI() {
    const intOr = (el, d, min) => {
      const v = parseInt(el && el.value, 10);
      return isNaN(v) ? d : Math.max(min, v);
    };
    return {
      toteBarcodeMax: intOr(fToteBarcode, DEFAULT_FILTERS.toteBarcodeMax, 1),
      partitionMax: intOr(fPartition, DEFAULT_FILTERS.partitionMax, 1),
      pidInvMin: intOr(fPidInv, DEFAULT_FILTERS.pidInvMin, 0),
      pidToteMin: intOr(fPidTote, DEFAULT_FILTERS.pidToteMin, 1),
      blockedMode: (fBlockedMode && fBlockedMode.value) || DEFAULT_FILTERS.blockedMode,
    };
  }
  function applyFiltersToUI(f) {
    fToteBarcode.value = f.toteBarcodeMax;
    fPartition.value = f.partitionMax;
    fPidInv.value = f.pidInvMin;
    fPidTote.value = f.pidToteMin;
    fBlockedMode.value = f.blockedMode;
  }
  function fmtFilters(f) {
    if (!f) return "";
    const label = { both: "Both", blocked: "Blocked only", non_blocked: "Non-Blocked (0)" }[f.blockedMode] || f.blockedMode;
    return (
      `Total Tote Barcode ≤ ${f.toteBarcodeMax} · Tote Partition ≤ ${f.partitionMax} · ` +
      `Total PID Inv > ${f.pidInvMin} (blocked only) · Total PID Tote ≥ ${f.pidToteMin} · Blocked: ${label}`
    );
  }

  function initFiltersUI() {
    applyFiltersToUI(loadFilters());
    fFacility.value = localStorage.getItem(FACILITY_KEY) || "NXS1";
  }

  // ── Generate (fetch cycle) ─────────────────────────────────────────────

  function status(msg, kind) {
    statusLine.textContent = msg || "";
    statusLine.className = "note" + (kind ? " " + kind : "");
  }

  async function generate() {
    errBox.classList.add("hidden");
    generateBtn.disabled = true;
    statusPill.textContent = "GENERATING";
    statusPill.className = "status-pill status-RUNNING";

    const filters = readFiltersFromUI();
    saveFilters(filters);
    const facility = (fFacility.value || "NXS1").trim() || "NXS1";
    localStorage.setItem(FACILITY_KEY, facility);

    status(`Filters → ${fmtFilters(filters)} · reading canonical NEXS ASRS Tote Dump…`, "");

    try {
      const query = await NexsConnect.run({ owner: "totePurge", reason: "Tote Purge" }, () => Api.post("/tote-purge/generate", { filters, facilityCode: facility }));
      activeQueryId = query.queryId;
      poll();
    } catch (e) {
      generateBtn.disabled = false;
      statusPill.textContent = "";
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
    }
  }

  // Follows the run over the live stream ("query:<id>"), then the shared
  // "tote-purge.current" topic delivers the finished report to every viewer.
  let stopWatchFn = null;
  function poll() {
    if (stopWatchFn) stopWatchFn();
    const watchedId = activeQueryId;
    stopWatchFn = Live.watch("query:" + watchedId, (evt) => {
      if (watchedId !== activeQueryId) return true;
      if (evt.type === "feed-error") {
        generateBtn.disabled = false;
        errBox.textContent = evt.message;
        errBox.classList.remove("hidden");
        return true;
      }
      if (evt.type !== "data") return false;
      const query = evt.data;
      if (!TERMINAL.has(query.status)) return false;
      stopCountdown();
      generateBtn.disabled = false;
      if (query.status !== "COMPLETED") {
        errBox.textContent = query.error || `Purge generation ended: ${query.status}`;
        errBox.classList.remove("hidden");
      }
      Live.refresh("tote-purge.current");
      return true;
    });
  }

  // The canonical report: pushed by the server whenever anyone's generation
  // finishes (404-equivalent arrives as {empty:true}). Subscribed only while
  // this tab is open.
  // A run in progress (this user's or anyone's): the step, how far, and about how long is left.
  const nf = (n) => Number(n || 0).toLocaleString();
  const mmss = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  // Countdown: the server re-estimates every few seconds; the page ticks it down each second in between. Only a
  // display timer - it never calls the server. A new estimate within 3 s of the running one is ignored so the
  // clock doesn't jitter back up.
  let progressNow = null;
  let deadline = null;
  let tickTimer = null;
  function stopCountdown() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    progressNow = null;
    deadline = null;
  }
  function drawProgress() {
    const p = progressNow;
    if (!p) return;
    const who = p.by ? `started by ${p.by} · ` : "";
    const step = p.phase === "dump" ? "Reading the NEXS ASRS Tote Dump…"
      : p.phase === "blocked" ? `Checking blocked inventory in NexS — ${nf(p.done)} / ${nf(p.total)} PIDs`
      : p.phase === "retry" ? `Retrying ${nf(p.total)} PID(s) that failed — ${nf(p.done)} / ${nf(p.total)}`
      : "Validating against Quadron and building the report…";
    const elapsed = p.startedAt ? ` · running ${mmss(Date.now() - Date.parse(p.startedAt))}` : "";
    const left = deadline == null ? ""
      : deadline > Date.now() ? ` · ${mmss(deadline - Date.now())} left (estimate)`
      : " · finishing — taking a little longer than estimated";
    status(`${who}${step}${left}${elapsed}`, "");
  }
  function renderProgress(p) {
    statusPill.textContent = "GENERATING";
    statusPill.className = "status-pill status-RUNNING";
    progressNow = p;
    if (p.etaMs == null) deadline = null;
    else {
      const next = Date.now() + p.etaMs;
      if (deadline == null || Math.abs(next - deadline) > 3000) deadline = next;
    }
    drawProgress();
    if (!tickTimer) tickTimer = setInterval(drawProgress, 1000);
  }

  function applyCurrent(data) {
    if (data.progress) { renderProgress(data.progress); return; } // a run is going - the finished report follows
    stopCountdown();
    if (generateBtn.disabled) return; // a run is in progress: keep the GENERATING pill; the finished report is applied when it ends
    if (data.empty) {
      _last = null;
      renderStatusPill("NO_SNAPSHOT", data.lastAttempt);
      return;
    }
    _last = data;
    renderStatusPill(_last.status, _last.lastAttempt);
    renderResults(_last);
  }

  let currentOff = null;
  function start() {
    if (currentOff) return;
    currentOff = Live.subscribe("tote-purge.current", (evt) => {
      if (evt.type === "data") applyCurrent(evt.data);
      else if (evt.type === "feed-error" && !_last) {
        statusPill.textContent = "ERROR";
        statusPill.className = "status-pill status-FAILED";
        errBox.textContent = evt.message;
        errBox.classList.remove("hidden");
      }
    });
  }
  function stop() {
    stopCountdown();
    if (currentOff) { currentOff(); currentOff = null; }
  }

  function renderStatusPill(purgeStatus, lastAttempt) {
    if (purgeStatus === "CURRENT") {
      statusPill.textContent = "CURRENT";
      statusPill.className = "status-pill status-COMPLETED";
      status(`Report generated ${escHtml(Fmt.when(_last.generatedAt))} · ASRS Dump snapshot from ${escHtml(Fmt.when(_last.asrsSnapshotRefreshedAt) || "unknown")}`, "");
      return;
    }
    if (purgeStatus === "STALE_PREVIOUS") {
      statusPill.textContent = "STALE - GENERATE FAILED";
      statusPill.className = "status-pill status-FAILED";
      status(`Showing a PREVIOUS successful report (${escHtml(Fmt.when(_last.generatedAt))}) - the most recent attempt (${escHtml(lastAttempt ? Fmt.when(lastAttempt.at) : "")}) FAILED: ${escHtml(lastAttempt && lastAttempt.reason)}`, "err");
      return;
    }
    statusPill.textContent = "NOT GENERATED";
    statusPill.className = "status-pill status-PENDING";
    status(
      lastAttempt && !lastAttempt.ok
        ? `No successful report yet - the last attempt (${escHtml(lastAttempt.at)}) FAILED: ${escHtml(lastAttempt.reason)}`
        : "Not generated yet this session - click Generate Purge Candidates.",
      lastAttempt && !lastAttempt.ok ? "err" : ""
    );
  }

  // ── Render results ──────────────────────────────────────────────────────

  function renderResults(r) {
    const s = r.summary;
    resultsPanel.style.display = "";
    $("tpStTotes").textContent = s.totalTotes;
    $("tpStInv").textContent = s.totalInventory;
    $("tpStPids").textContent = s.uniquePids;
    $("tpStValid").textContent = s.validatedCount;
    $("tpStBlocked").textContent = s.blockedCount;
    $("tpStNonBlocked").textContent = s.nonBlockedCount;
    $("tpStMismatch").textContent = s.mismatchCount;
    $("tpStApiFail").textContent = s.blockedApiFails;

    const lines = s.candidateLines != null ? s.candidateLines : s.totalTotes;
    const distinct = s.distinctTotes != null ? s.distinctTotes : s.totalTotes;
    const reconciles = s.blockedCount + s.nonBlockedCount === lines;
    const validReconciles = s.validatedCount + s.mismatchCount === lines;
    $("tpIntegrity").innerHTML =
      `<strong>${lines}</strong> candidate line${lines === 1 ? "" : "s"} across <strong>${distinct}</strong> distinct tote${distinct === 1 ? "" : "s"} ` +
      `· Large <strong>${s.largeTotes || 0}</strong> / Small <strong>${s.smallTotes || 0}</strong> ` +
      `· Blocked ${s.blockedCount} + Non-Blocked ${s.nonBlockedCount} ${reconciles ? '<i class="ico" data-i="check"></i> reconciles' : '<i class="ico" data-i="alert"></i> mismatch'} ` +
      `· Validated ${s.validatedCount} + Mismatches ${s.mismatchCount} ${validReconciles ? '<i class="ico" data-i="check"></i>' : '<i class="ico" data-i="alert"></i>'}` +
      (s.apiSkippedTotes ? ` · <span class="error" style="display:inline"><i class="ico" data-i="alert"></i> ${s.apiSkippedTotes} tote(s) NOT evaluated — blocked API failed for ${s.blockedApiFails} PID(s) (review separately)${(s.apiFailReasons || []).length ? "<br>Top reasons: " + s.apiFailReasons.map((x) => `${escHtml(x.reason)} (${x.pids} PID${x.pids === 1 ? "" : "s"})`).join("; ") : ""}</span>` : "") +
      (!s.quadronAvailable ? ` · <span class="error" style="display:inline"><i class="ico" data-i="alert"></i> Quadron unavailable — every candidate is VALIDATION_UNAVAILABLE${s.quadronReason ? ` (${escHtml(s.quadronReason)})` : ""}. Generate again to retry.</span>` : "");

    const pidHead = `<tr><th>PID</th><th>Totes</th><th>Inv Sel.</th><th>Blocked</th><th>PID Total</th><th>Purge Available</th></tr>`;
    const pidRows = (r.pidBreakdown || [])
      .map(
        (p) =>
          `<tr><td>${escHtml(p.pid)}</td><td>${p.totesSelected}</td><td>${p.inventorySelected}</td><td>${p.blockedInventory}</td><td>${p.totalPidInventory}</td><td>${p.purgeAvailableInventory}</td></tr>`
      )
      .join("");
    $("tpPidTable").innerHTML = pidHead + (pidRows || `<tr><td colspan="6" class="purge-empty">No PIDs</td></tr>`);

    $("tpMismatchTitle").textContent = `Mismatch Report (${(r.mismatches || []).length})`;
    const mmHead = `<tr><th>Tote ID</th><th>PID</th><th>Issue</th><th>ASRS</th><th>Quadron</th><th>Action</th></tr>`;
    const mmRows = (r.mismatches || [])
      .map(
        (m) =>
          `<tr><td>${escHtml(m.toteId)}</td><td>${escHtml(m.pid)}</td><td>${escHtml(m.issueType)}</td><td>${escHtml(m.asrsValue)}</td><td>${escHtml(m.quadronValue)}</td><td>${escHtml(m.recommendedAction)}</td></tr>`
      )
      .join("");
    $("tpMismatchTable").innerHTML = mmHead + (mmRows || `<tr><td colspan="6" class="purge-empty">No mismatches — all candidates validated <i class="ico" data-i="check"></i></td></tr>`);

    // Tote Purge Dump - the primary, dense Tote x PID operational table.
    // Every column below reads an EXISTING field already produced by
    // purgeEngine/purgeClassify/purgeQuadronValidate - nothing here is
    // recalculated or fabricated in the frontend. The UI only ever renders
    // a capped number of rows for performance; CSV/JSON export (dumpCsv()/
    // the JSON download handler below) always use the full, uncapped
    // `cand` array, never `.slice(0, CAP)`.
    const CAP = 1000;
    const cand = r.candidates || [];
    const filterNote = r.filters ? ` · filters: ${fmtFilters(r.filters)}` : "";
    $("tpDumpNote").textContent =
      (cand.length > CAP ? `Showing first ${CAP} of ${cand.length} rows. Export CSV for the complete dump.` : `${cand.length} row${cand.length === 1 ? "" : "s"}.`) + filterNote;
    const dumpHead =
      `<tr><th>Tote ID</th><th>Tote Type</th><th>PID</th><th>Partition</th>` +
      `<th class="num">ASRS Inventory</th><th class="num">Quadron Inventory</th><th class="num">Blocked Inventory</th>` +
      `<th class="num">Available (PID Total - Blocked)</th><th class="num">Overall PID Inventory</th><th class="num">PID Tote Count</th>` +
      `<th>Purge Type</th><th>Validation Status</th></tr>`;
    const dumpRows = cand
      .slice(0, CAP)
      .map((c) => {
        // quadronQty is null (not 0) when Quadron never reported a figure
        // for this tote at all - distinct from a real, reported 0 - the
        // existing validation model's own distinction, preserved as-is.
        const qInv = c.quadronQty == null ? "—" : c.quadronQty;
        return (
          `<tr><td>${escHtml(c.toteId)}</td><td>${escHtml(c.toteType)}</td><td>${escHtml(c.pid)}</td><td>${escHtml(c.partition || "—")}</td>` +
          `<td class="num">${c.inventoryCount}</td><td class="num">${qInv}</td><td class="num">${c.blockedInventory}</td>` +
          `<td class="num">${c.purgeAvailableInventory}</td><td class="num">${c.totalPidInventory}</td><td class="num">${c.totalPidTotes}</td>` +
          `<td><span class="status-pill status-${c.purgeType}">${escHtml(c.purgeType)}</span></td>` +
          `<td><span class="status-pill status-${c.validationStatus}">${escHtml(c.validationStatus)}</span></td></tr>`
        );
      })
      .join("");
    $("tpDumpTable").innerHTML = dumpHead + (dumpRows || `<tr><td colspan="12" class="purge-empty">No candidates</td></tr>`);
  }

  // ── Exports ───────────────────────────────────────────────────────────

  function csvCell(v) {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCsv(headers, rows) {
    return [headers.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
  }
  function stamp() {
    return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  }
  function dl(content, filename, mime) {
    const blob = new Blob([content], { type: mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function dumpCsv() {
    if (!_last) return "";
    const headers = ["Tote ID", "Tote Type", "PID", "Partition", "ASRS Inventory", "Quadron Inventory", "Quadron Partition", "Blocked Inventory", "Purge Available Inventory", "Overall PID Inventory", "PID Tote Count", "Purge Type", "Validation Status"];
    const rows = (_last.candidates || []).map((c) => {
      const qPart = c.quadronPartition == null ? "" : "PR" + c.quadronPartition;
      const qInv = c.quadronQty == null ? "" : c.quadronQty;
      return [c.toteId, c.toteType, c.pid, c.partition || "", c.inventoryCount, qInv, qPart, c.blockedInventory, c.purgeAvailableInventory, c.totalPidInventory, c.totalPidTotes, c.purgeType, c.validationStatus];
    });
    const comments = [`# Purge Dump — generated ${escHtml(_last.generatedAt)}`, `# Filters applied: ${fmtFilters(_last.filters)}`, ``].join("\n");
    return comments + "\n" + toCsv(headers, rows);
  }
  function mismatchCsv() {
    if (!_last) return "";
    const headers = ["Tote ID", "PID", "Issue Type", "ASRS Value", "Quadron Value", "Recommended Action"];
    const rows = (_last.mismatches || []).map((m) => [m.toteId, m.pid, m.issueType, m.asrsValue, m.quadronValue, m.recommendedAction]);
    return toCsv(headers, rows);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────

  generateBtn.addEventListener("click", generate);
  resetBtn.addEventListener("click", () => {
    applyFiltersToUI(DEFAULT_FILTERS);
    saveFilters({ ...DEFAULT_FILTERS });
    status("Filters reset to defaults.", "");
  });
  $("tpDlCsvBtn").addEventListener("click", () => {
    if (_last) dl(dumpCsv(), `purge-dump-${stamp()}.csv`, "text/csv");
  });
  $("tpDlJsonBtn").addEventListener("click", () => {
    if (_last) dl(JSON.stringify({ filters: _last.filters, summary: _last.summary, candidates: _last.candidates, mismatches: _last.mismatches, pidBreakdown: _last.pidBreakdown, apiSkipped: _last.apiSkipped }, null, 2), `purge-dump-${stamp()}.json`, "application/json");
  });
  $("tpDlMismatchBtn").addEventListener("click", () => {
    if (_last) dl(mismatchCsv(), `purge-mismatch-${stamp()}.csv`, "text/csv");
  });

  initFiltersUI();

  // No fetch on script load: the live subscription starts when the tab opens
  // (start()), and the operator explicitly clicks Generate.

  return { start, stop };
})();
