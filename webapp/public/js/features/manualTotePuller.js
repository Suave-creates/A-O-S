const ManualTotePuller = (() => {
  let activeSessionId = null;
  // [{ id, zone, percentage }] - instanceCode is deliberately NOT collected
  // here: it's backend/configuration information (e.g. "LK-069"), not
  // something the operator chooses. The backend route fills in
  // config.quadronInstanceCode whenever it's omitted (see
  // zonePicker.applyDefaultInstanceCode) - PULL_QUADRON_TOTE still always
  // receives a real instanceCode, it's just no longer collected here.
  let zoneRows = [];
  let zoneRowSeq = 0;
  // Captured at confirmation time, sent as-is on Confirm - mirrors the
  // single-tote form's own pattern so what's confirmed is exactly what's sent.
  let pendingSession = null;

  const toteListEl = document.getElementById("mtToteList");
  const toteCountEl = document.getElementById("mtToteCount");
  const multiZoneToggle = document.getElementById("mtMultiZoneEnabled");
  const singleZonePanel = document.getElementById("mtSingleZonePanel");
  const multiZonePanel = document.getElementById("mtMultiZonePanel");
  const zoneEl = document.getElementById("mtZone");
  const zoneRowsBody = document.getElementById("mtZoneRows");
  const addZoneBtn = document.getElementById("mtAddZoneBtn");
  const zoneTotalEl = document.getElementById("mtZoneTotal");
  const zoneTotalStatusEl = document.getElementById("mtZoneTotalStatus");
  const startBtn = document.getElementById("mtStartBtn");
  const errBox = document.getElementById("mtError");

  const purgeEl = document.getElementById("mtPurge");

  const statusPanel = document.getElementById("mtStatusPanel");
  const sessionIdEl = document.getElementById("mtSessionId");
  const statusPillEl = document.getElementById("mtStatusPill");
  const progressEl = document.getElementById("mtProgress");
  const progressLabelEl = document.getElementById("mtProgressLabel");
  const progressFillEl = document.getElementById("mtProgressFill");
  const currentToteEl = document.getElementById("mtCurrentTote");
  const currentZoneEl = document.getElementById("mtCurrentZone");
  const currentAttemptEl = document.getElementById("mtCurrentAttempt");
  const stopBtn = document.getElementById("mtStopBtn");
  // Skip Tote (mtSkipBtn) is a real legacy control with no backend
  // equivalent here (totePullEngine.js has no skip-in-flight-tote
  // capability) - rendered per the legacy layout but permanently disabled
  // via its own `disabled` attribute in the markup, so no JS reference is
  // needed here at all.
  const clearLogBtn = document.getElementById("mtClearLogBtn");
  const resultsBody = document.getElementById("mtResultsBody");
  const resultsEmptyEl = document.getElementById("mtResultsEmpty");

  // Persistent inline status summary, visible in the config card even
  // before any session exists - mirrors the legacy's always-on status bar.
  const inlineStatusDot = document.getElementById("mtInlineStatusDot");
  const inlineStatusLabel = document.getElementById("mtInlineStatusLabel");
  const inlineStatusMeta = document.getElementById("mtInlineStatusMeta");

  // Session Tote Summary (stat tiles) - derived entirely from this
  // session's own `results` array (there is no separate 24-hour
  // cross-session aggregate in this webapp's data model - see the
  // "Session Tote Summary" label, deliberately not "24-Hour", to avoid
  // implying a wider scope than what's actually shown).
  const statTotalEl = document.getElementById("mtStatTotal");
  const statCalledEl = document.getElementById("mtStatCalled");
  const statAlreadyEl = document.getElementById("mtStatAlready");
  const statUnavailEl = document.getElementById("mtStatUnavail");
  const statSkippedEl = document.getElementById("mtStatSkipped");

  // Activity Log - also derived from `results` (no separate timestamped log
  // feed exists for Manual sessions in this webapp - see render()'s own note).
  const logPanel = document.getElementById("mtLog");

  // Pull-Rate Limiter - a live view of the shared, GLOBAL rolling-window
  // cap on real Quadron pulls (server/lib/pullRateLimiter.js), read from
  // this session's own poll (session.pullLimit) - the limiter itself is not
  // per-session, but every session's snapshot reflects the same live state.
  const pullLimitCard = document.getElementById("mtPullLimitCard");
  const pullLimitCountEl = document.getElementById("mtPullLimitCount");
  const pullLimitMaxEl = document.getElementById("mtPullLimitMax");
  const pullLimitRemainingEl = document.getElementById("mtPullLimitRemaining");
  const pullLimitFillEl = document.getElementById("mtPullLimitFill");
  const pullLimitModalOverlay = document.getElementById("mtPullLimitModalOverlay");
  const pullLimitWaitSecEl = document.getElementById("mtPullLimitWaitSec");
  const pullLimitDismissBtn = document.getElementById("mtPullLimitDismissBtn");
  let pullLimitModalDismissed = false; // re-arms once the limit clears and is later hit again


  const TERMINAL = new Set(["COMPLETED", "STOPPED"]);

  const VERDICT_LABEL = {
    INSERTED: "Inserted",
    RELEASED: "Released",
    ALREADY_QUEUED: "Already queued",
    NOT_AVAILABLE: "Not available",
    FAILED: "Failed - nothing was pulled, safe to retry",
    SKIPPED: "Uncertain - verify before retrying", // retries ran out with no confirmed answer; the pull may have gone through
    CANCELLED: "Cancelled",
  };

  // ── Tote list ────────────────────────────────────────────────────────────

  function updateToteCount() {
    const totes = ToteListParser.parseToteList(toteListEl.value);
    toteCountEl.textContent = `${totes.length} queued`;
  }

  // ── Multi-zone configuration ─────────────────────────────────────────────

  function addZoneRow(zone = "", percentage = 0) {
    zoneRowSeq++;
    zoneRows.push({ id: "z" + zoneRowSeq, zone, percentage });
    renderZoneRows();
  }

  function removeZoneRow(id) {
    zoneRows = zoneRows.filter((z) => z.id !== id);
    renderZoneRows();
  }

  function updateZoneRow(id, field, value) {
    const row = zoneRows.find((z) => z.id === id);
    if (!row) return;
    row[field] = field === "percentage" ? Math.max(0, Math.min(100, Number(value) || 0)) : value;
    recomputeZoneTotal();
  }

  function zoneTotal() {
    return zoneRows.reduce((s, z) => s + (Number(z.percentage) || 0), 0);
  }

  function recomputeZoneTotal() {
    const total = zoneTotal();
    zoneTotalEl.textContent = total;
    if (total === 100) {
      zoneTotalEl.className = "mt-total-ok";
      zoneTotalStatusEl.textContent = "Ready";
      zoneTotalStatusEl.className = "mt-total-ok";
    } else if (total > 100) {
      zoneTotalEl.className = "mt-total-err";
      zoneTotalStatusEl.textContent = "Exceeds 100%";
      zoneTotalStatusEl.className = "mt-total-err";
    } else {
      zoneTotalEl.className = "mt-total-warn";
      zoneTotalStatusEl.textContent = `${100 - total}% unassigned`;
      zoneTotalStatusEl.className = "mt-total-warn";
    }
  }

  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderZoneRows() {
    zoneRowsBody.innerHTML = zoneRows
      .map(
        (z) => `<tr data-id="${z.id}">
        <td><input class="mt-zone-input" type="text" data-field="zone" value="${escHtml(z.zone)}" placeholder="e.g. 5" /></td>
        <td><input class="mt-zone-input" type="number" min="0" max="100" data-field="percentage" value="${z.percentage}" /></td>
        <td><button class="link mt-remove-zone">&times;</button></td>
      </tr>`
      )
      .join("");

    zoneRowsBody.querySelectorAll("tr").forEach((tr) => {
      const id = tr.dataset.id;
      tr.querySelectorAll("input").forEach((input) => {
        input.addEventListener("input", () => updateZoneRow(id, input.dataset.field, input.value));
      });
      tr.querySelector(".mt-remove-zone").addEventListener("click", () => removeZoneRow(id));
    });

    recomputeZoneTotal();
  }

  function toggleMultiZone() {
    const enabled = multiZoneToggle.checked;
    singleZonePanel.classList.toggle("hidden", enabled);
    multiZonePanel.classList.toggle("hidden", !enabled);
    if (enabled && zoneRows.length === 0) {
      addZoneRow("", 100); // one starter row, matching the existing extension's own "+ Add Zone" default of filling the remainder
    }
  }

  // ── Session start (validate -> confirm -> submit) ───────────────────────

  function currentZoneConfig() {
    if (!multiZoneToggle.checked) {
      return { multiZone: false, zone: zoneEl.value.trim() };
    }
    return {
      multiZone: true,
      zones: zoneRows.map((z) => ({ id: z.id, zone: z.zone.trim(), percentage: Number(z.percentage) || 0 })),
    };
  }

  async function validateAndConfirm() {
    errBox.classList.add("hidden");
    pendingSession = null;

    const totes = ToteListParser.parseToteList(toteListEl.value);
    if (!totes.length) {
      errBox.textContent = "Add at least one valid tote ID (format: TL0000002607).";
      errBox.classList.remove("hidden");
      return;
    }

    const zc = currentZoneConfig();
    if (!zc.multiZone) {
      if (!zc.zone) {
        errBox.textContent = "Zone / Station is required.";
        errBox.classList.remove("hidden");
        return;
      }
    } else {
      if (!zc.zones.length) {
        errBox.textContent = "Add at least one zone.";
        errBox.classList.remove("hidden");
        return;
      }
      if (zc.zones.some((z) => !z.zone)) {
        errBox.textContent = "All zones need a zone number.";
        errBox.classList.remove("hidden");
        return;
      }
      const total = zc.zones.reduce((s, z) => s + z.percentage, 0);
      if (total !== 100) {
        errBox.textContent = `Zone percentages total ${total}% — must equal exactly 100%.`;
        errBox.classList.remove("hidden");
        return;
      }
    }

    const purge = !!(purgeEl && purgeEl.checked);
    pendingSession = { totes, ...zc, purpose: purge ? "PURGE" : "NORMAL" };
    const zoneSummary = zc.multiZone ? "Zones: " + zc.zones.map((z) => `${z.zone} (${z.percentage}%)`).join(", ") : `Zone ${zc.zone}`;
    const n = totes.length;
    const what = `${n} tote${n === 1 ? "" : "s"}`;
    const go = await MutationFlow.confirm({
      title: `Pull ${what}?`,
      actionLabel: `Pull ${what}`,
      lines: [
        `Quadron: ${what}, pulled one at a time. Each pull is a real request and cannot be undone from here; you can Stop before the next tote.`,
        zoneSummary,
        "Runs on the server. Leaving this tab does not cancel it.",
      ],
      warnings: purge ? [{ label: "Purge pull.", text: "A tote counts as Purged once its cycle count is done and Quadron shows no inventory for it. If Quadron still shows stock, it stays a normal CC." }] : [],
    });
    if (go) await submitSession();
    else pendingSession = null;
  }

  async function submitSession() {
    if (!pendingSession) return;
    startBtn.disabled = true;
    try {
      const session = await Api.post("/tote-engine/sessions", pendingSession);
      activeSessionId = session.sessionId;
      if (purgeEl) purgeEl.checked = false; // never carries over to the next batch by accident
      pendingSession = null;
      statusPanel.style.display = "";
      resultsBody.innerHTML = "";
      render(session);
      poll();
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
      startBtn.disabled = false;
    }
  }

  // ── Polling / rendering ──────────────────────────────────────────────────

  // Follows the session over the live stream (topic "tote-session:<id>") instead of
  // polling: the server pushes every change and stops once the session is
  // terminal. One watcher at a time (resume/restart replace it).
  let stopWatchFn = null;
  function poll() {
    if (stopWatchFn) stopWatchFn();
    const watchedId = activeSessionId;
    if (!watchedId) return;
    stopWatchFn = Live.watch("tote-session:" + watchedId, (evt) => {
      if (watchedId !== activeSessionId) return true;
      if (evt.type === "feed-error") {
        startBtn.disabled = false;
        return true;
      }
      if (evt.type !== "data") return false;
      render(evt.data);
      if (!TERMINAL.has(evt.data.status)) return false;
      startBtn.disabled = false;
      return true;
    });
  }

  function renderPullLimit(pullLimit) {
    if (!pullLimit) return;
    pullLimitCountEl.textContent = pullLimit.count;
    pullLimitMaxEl.textContent = pullLimit.max;
    pullLimitRemainingEl.textContent = pullLimit.remaining;
    pullLimitFillEl.style.width = Math.min(100, (pullLimit.count / pullLimit.max) * 100) + "%";
    pullLimitCard.classList.toggle("limit-warn", pullLimit.count >= pullLimit.max * 0.8 && !pullLimit.limitReached);
    pullLimitCard.classList.toggle("limit-reached", pullLimit.limitReached);

    if (pullLimit.limitReached) {
      if (!pullLimitModalDismissed) pullLimitModalOverlay.classList.remove("hidden");
      pullLimitWaitSecEl.textContent = pullLimit.nextFreeAt ? Math.max(0, Math.ceil((pullLimit.nextFreeAt - Date.now()) / 1000)) : "—";
    } else {
      pullLimitModalOverlay.classList.add("hidden");
      pullLimitModalDismissed = false; // re-arm for the next time the limit is hit
    }
  }

  // Called/Already-Queued/Not-Available/Skipped counts, derived from this
  // session's own result verdicts - the exact same 4 categories the legacy
  // extension's own "24-Hour Tote Summary" uses, just scoped to THIS session
  // (no cross-session rolling window exists in this webapp's data model).
  function classifyOutcome(r) {
    const v = r.verdict || r.terminal;
    if (v === "INSERTED" || v === "RELEASED") return "called";
    if (v === "ALREADY_QUEUED") return "already";
    if (v === "NOT_AVAILABLE") return "unavail";
    return "skipped"; // SKIPPED / CANCELLED / anything else terminal
  }

  function renderSessionSummary(results) {
    const counts = { called: 0, already: 0, unavail: 0, skipped: 0 };
    results.forEach((r) => counts[classifyOutcome(r)]++);
    statTotalEl.textContent = results.length;
    statCalledEl.textContent = counts.called;
    statAlreadyEl.textContent = counts.already;
    statUnavailEl.textContent = counts.unavail;
    statSkippedEl.textContent = counts.skipped;
  }

  // Activity Log - one line per processed tote, derived from `results`
  // (this webapp has no separate timestamped log feed for Manual sessions,
  // so entries have no time prefix - unlike the legacy extension's own
  // chrome.storage-backed log, which does).
  function renderLog(results) {
    logPanel.innerHTML = results
      .map((r) => {
        const kind = classifyOutcome(r);
        const cls = kind === "called" ? "op-ok" : kind === "already" ? "op-warn" : kind === "unavail" ? "op-err" : "op-ignore";
        const label = VERDICT_LABEL[MutationFlow.resultKey(r)] || r.terminal;
        return `<div class="log-entry ${cls}"><span class="log-msg">${escHtml(r.toteId)} → ${escHtml(label)} (zone ${escHtml(r.zone ?? "-")}, attempt ${r.attempt})</span></div>`;
      })
      .join("");
  }

  function render(session) {
    sessionIdEl.textContent = session.sessionId;
    statusPillEl.textContent = session.status;
    statusPillEl.className = "status-pill status-" + session.status;

    progressEl.textContent = `${session.results.length} / ${session.totes.length}`;
    progressLabelEl.textContent = session.status;
    progressFillEl.style.width = session.totes.length ? Math.min(100, (session.results.length / session.totes.length) * 100) + "%" : "0%";
    currentToteEl.textContent = session.currentTote || "—";
    currentZoneEl.textContent = session.currentZone || "—";
    currentAttemptEl.textContent = session.currentAttempt || "—";
    renderPullLimit(session.pullLimit);

    inlineStatusDot.classList.toggle("on", session.status === "RUNNING");
    inlineStatusLabel.textContent = session.status;
    inlineStatusMeta.textContent = session.currentTote ? `Current: ${session.currentTote} → Zone ${session.currentZone || "—"}` : `${session.results.length} / ${session.totes.length} processed`;

    stopBtn.style.display = session.status === "RUNNING" ? "" : "none";

    renderSessionSummary(session.results);
    renderLog(session.results);
    resultsEmptyEl.classList.toggle("hidden", session.results.length > 0);

    resultsBody.innerHTML = session.results
      .map((r) => {
        const label = VERDICT_LABEL[MutationFlow.resultKey(r)] || r.terminal;
        const badgeKey = MutationFlow.resultKey(r);
        return `<tr>
          <td>${escHtml(r.toteId)}</td>
          <td>${escHtml(r.zone ?? "-")}</td>
          <td>${r.attempt}</td>
          <td><span class="status-pill status-${badgeKey}">${escHtml(label)}</span></td>
        </tr>`;
      })
      .join("");
  }

  async function stopSession() {
    if (!activeSessionId) return;
    stopBtn.disabled = true;
    try {
      const session = await Api.post(`/tote-engine/sessions/${activeSessionId}/stop`);
      render(session);
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
    } finally {
      stopBtn.disabled = false;
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  toteListEl.addEventListener("input", updateToteCount);
  multiZoneToggle.addEventListener("change", toggleMultiZone);
  addZoneBtn.addEventListener("click", () => addZoneRow("", Math.max(0, 100 - zoneTotal())));
  startBtn.addEventListener("click", validateAndConfirm);
  stopBtn.addEventListener("click", stopSession);
  clearLogBtn.addEventListener("click", () => {
    logPanel.innerHTML = "";
  });
  pullLimitDismissBtn.addEventListener("click", () => {
    pullLimitModalDismissed = true;
    pullLimitModalOverlay.classList.add("hidden");
  });

  updateToteCount();

  return {};
})();
