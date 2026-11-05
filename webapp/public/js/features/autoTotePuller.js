const AutoTotePuller = (() => {
  let activeSessionId = null;
  // [{ id, zone, percentage }] - instanceCode is deliberately NOT collected
  // here, same reasoning as manualTotePuller.js: it's backend/configuration
  // information the route layer fills in from config.quadronInstanceCode.
  let zoneRows = [];
  let zoneRowSeq = 0;
  let pendingSession = null;

  const multiZoneToggle = document.getElementById("atMultiZoneEnabled");
  const singleZonePanel = document.getElementById("atSingleZonePanel");
  const multiZonePanel = document.getElementById("atMultiZonePanel");
  const zoneEl = document.getElementById("atZone");
  const zoneRowsBody = document.getElementById("atZoneRows");
  const addZoneBtn = document.getElementById("atAddZoneBtn");
  const zoneTotalEl = document.getElementById("atZoneTotal");
  const zoneTotalStatusEl = document.getElementById("atZoneTotalStatus");

  // Both dump rows show the SAME session.lastFetch value - this webapp's
  // snapshot only tracks one combined last-refresh timestamp, not a
  // separate one per dump type (unlike the legacy extension's own two
  // independent fetch trackers) - shown honestly rather than inventing a
  // second data source that doesn't exist.
  const lockedLastFetchEl = document.getElementById("atLockedLastFetch");
  const superLastFetchEl = document.getElementById("atSuperLastFetch");
  const cfgBatchSize = document.getElementById("atBatchSize");
  const cfgCallInterval = document.getElementById("atCallInterval");
  const cfgBatchInterval = document.getElementById("atBatchInterval");
  const cfgRetryDelay = document.getElementById("atRetryDelay");
  const cfgCooldown = document.getElementById("atCooldown");
  const cfgReminder = document.getElementById("atReminder");
  const cfgLockedRefresh = document.getElementById("atLockedRefresh");
  const cfgSupervisorRefresh = document.getElementById("atSupervisorRefresh");

  const startBtn = document.getElementById("atStartBtn");
  const errBox = document.getElementById("atError");

  // ── Auto Preview / Dry-Run - read-only, never touches a real session ────
  const previewBtn = document.getElementById("atPreviewBtn");
  const previewPanel = document.getElementById("atPreviewPanel");
  const apGeneratedAt = document.getElementById("apGeneratedAt");
  const apCallingStation = document.getElementById("apCallingStation");
  const apBatchSize = document.getElementById("apBatchSize");
  const apTotalLocked = document.getElementById("apTotalLocked");
  const apSd = document.getElementById("apSd");
  const apP0 = document.getElementById("apP0");
  const apP1 = document.getElementById("apP1");
  const apP2 = document.getElementById("apP2");
  const apTotalQueued = document.getElementById("apTotalQueued");
  const apDegradedNote = document.getElementById("apDegradedNote");
  const apDiffNew = document.getElementById("apDiffNew");
  const apDiffRemoved = document.getElementById("apDiffRemoved");
  const apDiffReprioritized = document.getElementById("apDiffReprioritized");
  const apFirstBatchBody = document.getElementById("apFirstBatchBody");
  const apQueueBody = document.getElementById("apQueueBody");


  const statusPanel = document.getElementById("atStatusPanel");
  const sessionIdEl = document.getElementById("atSessionId");
  const statusPillEl = document.getElementById("atStatusPill");
  const currentToteEl = document.getElementById("atCurrentTote");
  const currentPriorityEl = document.getElementById("atCurrentPriority");
  const currentZoneEl = document.getElementById("atCurrentZone");
  const currentAttemptEl = document.getElementById("atCurrentAttempt");
  const queueSdEl = document.getElementById("atQueueSd");
  const queueP0El = document.getElementById("atQueueP0");
  const queueP1El = document.getElementById("atQueueP1");
  const queueP2El = document.getElementById("atQueueP2");
  const queueTotalEl = document.getElementById("atQueueTotal");
  const statCalledEl = document.getElementById("atStatCalled");
  const statAlreadyQueuedEl = document.getElementById("atStatAlreadyQueued");
  const statNotAvailableEl = document.getElementById("atStatNotAvailable");
  const statSkippedEl = document.getElementById("atStatSkipped");
  const statIgnoredEl = document.getElementById("atStatIgnored");
  const statBatchesEl = document.getElementById("atStatBatches");
  const statCompletedEl = document.getElementById("atStatCompleted");
  const overallStatusEl = document.getElementById("atOverallStatus");
  const startTimeEl = document.getElementById("atStartTime");
  const elapsedEl = document.getElementById("atElapsed");
  const lastFetchEl = document.getElementById("atLastFetch");
  const batchesRunRuntimeEl = document.getElementById("atBatchesRunRuntime");
  const batchSizeLiveEl = document.getElementById("atBatchSizeLive");
  const batchPositionEl = document.getElementById("atBatchPosition");
  const currentPidEl = document.getElementById("atCurrentPid");
  const batchStatusEl = document.getElementById("atBatchStatus");
  const pauseBtn = document.getElementById("atPauseBtn");
  const resumeBtn = document.getElementById("atResumeBtn");
  const stopBtn = document.getElementById("atStopBtn");
  const resultsBody = document.getElementById("atResultsBody");

  // Persistent inline status summary, visible in the config card even
  // before any session exists.
  const inlineStatusDot = document.getElementById("atInlineStatusDot");
  const inlineStatusLabel = document.getElementById("atInlineStatusLabel");
  const inlineStatusMeta = document.getElementById("atInlineStatusMeta");

  // Queue table - one row per queued tote, from the SAME sd/p0/p1/p2 arrays
  // the summary counts above already come from (session.queue.snapshot()
  // already returns full entry arrays, not just counts - this was
  // previously fetched but never rendered as a table).
  const queueBody = document.getElementById("atQueueBody");
  const queueEmptyEl = document.getElementById("atQueueEmpty");

  // Auto Mode Log - from session.log (autoEngine.js's own per-tick log
  // array, already returned by snapshot() but previously never rendered).
  const logPanel = document.getElementById("atLog");

  // Pull-Rate Limiter - same shared, GLOBAL rolling-window cap as Manual
  // (server/lib/pullRateLimiter.js) - see manualTotePuller.js's own comment.
  // The "is anyone watching?" reminder (the Auto Puller is not under the Manual Puller's pull-rate limit)
  const reminderEveryEl = document.getElementById("atReminderEvery");
  const reminderNextEl = document.getElementById("atReminderNext");
  const reminderLastEl = document.getElementById("atReminderLast");
  const reminderAckBtn = document.getElementById("atReminderAckBtn");

  const TERMINAL = new Set(["STOPPED", "COMPLETED"]);

  const VERDICT_LABEL = {
    INSERTED: "Inserted",
    RELEASED: "Released",
    ALREADY_QUEUED: "Already queued",
    NOT_AVAILABLE: "Not available",
    FAILED: "Failed - nothing was pulled, safe to retry",
    SKIPPED: "Uncertain - verify before retrying", // retries ran out with no confirmed answer; the pull may have gone through
    CANCELLED: "Cancelled",
  };

  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── Multi-zone configuration (same pattern as manualTotePuller.js) ──────

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
  function renderZoneRows() {
    zoneRowsBody.innerHTML = zoneRows
      .map(
        (z) => `<tr data-id="${z.id}">
        <td><input class="mt-zone-input" type="text" data-field="zone" value="${escHtml(z.zone)}" placeholder="e.g. 5" /></td>
        <td><input class="mt-zone-input" type="number" min="0" max="100" data-field="percentage" value="${z.percentage}" /></td>
        <td><button class="link at-remove-zone">&times;</button></td>
      </tr>`
      )
      .join("");
    zoneRowsBody.querySelectorAll("tr").forEach((tr) => {
      const id = tr.dataset.id;
      tr.querySelectorAll("input").forEach((input) => {
        input.addEventListener("input", () => updateZoneRow(id, input.dataset.field, input.value));
      });
      tr.querySelector(".at-remove-zone").addEventListener("click", () => removeZoneRow(id));
    });
    recomputeZoneTotal();
  }
  function toggleMultiZone() {
    const enabled = multiZoneToggle.checked;
    singleZonePanel.classList.toggle("hidden", enabled);
    multiZonePanel.classList.toggle("hidden", !enabled);
    if (enabled && zoneRows.length === 0) addZoneRow("", 100);
  }

  function currentZoneConfig() {
    if (!multiZoneToggle.checked) {
      return { multiZone: false, zone: zoneEl.value.trim() };
    }
    return { multiZone: true, zones: zoneRows.map((z) => ({ id: z.id, zone: z.zone.trim(), percentage: Number(z.percentage) || 0 })) };
  }

  // ── Config (blank = server default) ──────────────────────────────────────

  function numOrUndefined(el) {
    const v = el.value.trim();
    return v === "" ? undefined : Number(v);
  }
  function currentConfig() {
    const cfg = {
      batchSize: numOrUndefined(cfgBatchSize),
      callIntervalMs: numOrUndefined(cfgCallInterval) != null ? numOrUndefined(cfgCallInterval) * 1000 : undefined,
      batchIntervalMs: numOrUndefined(cfgBatchInterval) != null ? numOrUndefined(cfgBatchInterval) * 60000 : undefined,
      retryDelayMs: numOrUndefined(cfgRetryDelay) != null ? numOrUndefined(cfgRetryDelay) * 1000 : undefined,
      cooldownMs: numOrUndefined(cfgCooldown) != null ? numOrUndefined(cfgCooldown) * 60000 : undefined,
      reminderMs: numOrUndefined(cfgReminder) != null ? numOrUndefined(cfgReminder) * 60000 : undefined,
      lockedDumpRefreshMs: numOrUndefined(cfgLockedRefresh) != null ? numOrUndefined(cfgLockedRefresh) * 60000 : undefined,
      supervisorDumpRefreshMs: numOrUndefined(cfgSupervisorRefresh) != null ? numOrUndefined(cfgSupervisorRefresh) * 60000 : undefined,
    };
    // Strip undefined keys so the route's own `?? config.auto*` defaulting applies cleanly.
    Object.keys(cfg).forEach((k) => cfg[k] === undefined && delete cfg[k]);
    return cfg;
  }

  // ── Start (validate -> confirm -> submit) ────────────────────────────────

  async function validateAndConfirm() {
    errBox.classList.add("hidden");
    pendingSession = null;

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

    pendingSession = { ...zc, config: currentConfig() };
    const zoneSummary = zc.multiZone ? "Zones: " + zc.zones.map((z) => `${z.zone} (${z.percentage}%)`).join(", ") : `Zone ${zc.zone}`;
    const go = await MutationFlow.confirm({
      title: "Start Auto Tote Puller?",
      actionLabel: "Start auto pulling",
      lines: [
        "Quadron: totes are chosen from the live priority queue and pulled one at a time. Each pull is a real request and cannot be undone from here.",
        zoneSummary,
        "The session keeps running, waiting for new totes when the queue is empty, until you Stop it. Leaving this tab does not cancel it.",
      ],
    });
    if (go) await submitSession();
    else pendingSession = null;
  }

  async function submitSession() {
    if (!pendingSession) return;
    startBtn.disabled = true;
    try {
      const session = await Api.post("/auto-engine/start", pendingSession);
      activeSessionId = session.sessionId;
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

  // Follows the session over the live stream (topic "auto-session:<id>") instead of
  // polling: the server pushes every change and stops once the session is
  // terminal. One watcher at a time (resume/restart replace it).
  let stopWatchFn = null;
  function poll() {
    if (stopWatchFn) stopWatchFn();
    const watchedId = activeSessionId;
    if (!watchedId) return;
    stopWatchFn = Live.watch("auto-session:" + watchedId, (evt) => {
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

  // mm:ss or h:mm:ss - never fabricated: always derived from the session's
  // own real startedAt/completedAt timestamps (see autoEngine.js's
  // snapshot()), just formatted for display.
  function formatElapsed(ms) {
    if (ms == null || ms < 0) return "—";
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  const mmss = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
  function renderReminder(session) {
    const r = session.reminder;
    if (!r) return;
    reminderEveryEl.textContent = `every ${Math.round(r.everyMs / 60000)} min`;
    const live = !TERMINAL.has(session.status);
    if (!live) reminderNextEl.textContent = session.stoppedBy === "no one acknowledged the reminder" ? "Stopped - no one acknowledged the reminder" : "Off - session ended";
    else if (r.deadline) reminderNextEl.textContent = `Asking now - stops in ${mmss(r.deadline - Date.now())} unless someone keeps it running`;
    else if (r.nextAt) reminderNextEl.textContent = `Next reminder in ${mmss(r.nextAt - Date.now())}`;
    reminderNextEl.classList.toggle("asking", live && !!r.deadline);
    reminderLastEl.textContent = r.lastAckBy ? `Last kept running by ${r.lastAckBy} at ${Fmt.time(new Date(r.lastAckAt).toISOString())}` : "Not acknowledged yet";
    reminderAckBtn.style.display = live ? "" : "none";
  }

  async function acknowledgeReminder() {
    if (!activeSessionId) return;
    reminderAckBtn.disabled = true;
    try {
      render(await Api.post(`/auto-engine/sessions/${activeSessionId}/ack`));
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
    } finally {
      reminderAckBtn.disabled = false;
    }
  }

  // Queue table - flattens session.queue's own sd/p0/p1/p2 arrays (already
  // returned by autoQueue.js's snapshot(), just never rendered before now)
  // into one table, ordered by priority tier.
  function renderQueueTable(queue) {
    const q = queue || {};
    const rows = [
      ...(q.sd || []).map((e) => ({ ...e, priority: "SD" })),
      ...(q.p0 || []).map((e) => ({ ...e, priority: "P0" })),
      ...(q.p1 || []).map((e) => ({ ...e, priority: "P1" })),
      ...(q.p2 || []).map((e) => ({ ...e, priority: "P2" })),
    ];
    queueEmptyEl.classList.toggle("hidden", rows.length > 0);
    queueBody.innerHTML = rows
      .map(
        (e) => `<tr>
          <td>${escHtml(e.toteId)}</td>
          <td><span class="status-pill status-${e.priority}">${e.priority}</span></td>
          <td>${escHtml(e.worstPid ?? "—")}</td>
          <td>${e.addedAt ? new Date(e.addedAt).toLocaleTimeString() : "—"}</td>
        </tr>`
      )
      .join("");
  }

  // Auto Mode Log - session.log entries are {t, level, message}
  // (autoEngine.js's own _log()) - level is one of info/warn/net_err/ignored,
  // the real classification the backend already assigns, not invented here.
  const LOG_LEVEL_CLASS = { info: "op-ok", warn: "op-warn", net_err: "net-err", ignored: "op-ignore" };
  function renderAutoLog(log) {
    logPanel.innerHTML = (log || [])
      .map((entry) => {
        const cls = LOG_LEVEL_CLASS[entry.level] || "op-ok";
        return `<div class="log-entry ${cls}"><span class="log-time">${new Date(entry.t).toLocaleTimeString()}</span><span class="log-msg">${escHtml(entry.message)}</span></div>`;
      })
      .join("");
  }

  function render(session) {
    sessionIdEl.textContent = session.sessionId;
    statusPillEl.textContent = session.status;
    statusPillEl.className = "status-pill status-" + session.status;
    overallStatusEl.textContent = session.status;
    renderReminder(session);

    inlineStatusDot.classList.toggle("on", session.status === "RUNNING" || session.status === "WAITING");
    inlineStatusLabel.textContent = session.status;
    inlineStatusMeta.textContent = session.currentTote ? `Current: ${session.currentTote} → Zone ${session.currentZone || "—"}` : `Queue: ${(session.queue && session.queue.total) || 0} pending`;

    const currentBatchEntry = session.currentBatch && session.currentBatch[session.currentIndex];
    currentToteEl.textContent = session.currentTote || "—";
    currentPriorityEl.textContent = (currentBatchEntry && currentBatchEntry.priority) || "—";
    currentZoneEl.textContent = session.currentZone || "—";
    currentAttemptEl.textContent = session.currentAttempt || "—";
    currentPidEl.textContent = (currentBatchEntry && currentBatchEntry.worstPid) || "—";

    const batchSize = (session.currentBatch || []).length;
    batchSizeLiveEl.textContent = batchSize || "—";
    batchPositionEl.textContent = batchSize ? `${Math.min(session.currentIndex + 1, batchSize)} / ${batchSize}` : "—";
    batchStatusEl.textContent = session.status;

    startTimeEl.textContent = session.startedAt ? Fmt.time(session.startedAt) : "Not started";
    const elapsedMs = session.startedAt ? new Date(session.completedAt || Date.now()) - new Date(session.startedAt) : null;
    elapsedEl.textContent = formatElapsed(elapsedMs);
    const lastFetchStr = session.lastFetch ? Fmt.time(session.lastFetch) : "No fetch yet";
    lastFetchEl.textContent = lastFetchStr;
    lockedLastFetchEl.textContent = session.lastFetch ? `Last fetch: ${lastFetchStr}` : "Last fetch: never";
    superLastFetchEl.textContent = session.lastFetch ? `Last fetch: ${lastFetchStr}` : "Last fetch: never";

    const q = session.queue || { sdCount: 0, p0Count: 0, p1Count: 0, p2Count: 0, total: 0 };
    queueSdEl.textContent = q.sdCount;
    queueP0El.textContent = q.p0Count;
    queueP1El.textContent = q.p1Count;
    queueP2El.textContent = q.p2Count;
    queueTotalEl.textContent = q.total;
    renderQueueTable(q);
    renderAutoLog(session.log);

    const st = session.stats || {};
    statCalledEl.textContent = st.called ?? 0;
    statAlreadyQueuedEl.textContent = st.alreadyQueued ?? 0;
    statNotAvailableEl.textContent = st.notAvailable ?? 0;
    statSkippedEl.textContent = st.skipped ?? 0;
    statIgnoredEl.textContent = st.ignored ?? 0;
    statBatchesEl.textContent = st.batchesRun ?? 0;
    batchesRunRuntimeEl.textContent = st.batchesRun ?? 0;
    statCompletedEl.textContent = (st.called ?? 0) + (st.alreadyQueued ?? 0);

    const running = session.status === "RUNNING" || session.status === "WAITING";
    pauseBtn.style.display = running ? "" : "none";
    resumeBtn.style.display = session.status === "PAUSED" ? "" : "none";
    stopBtn.style.display = TERMINAL.has(session.status) ? "none" : "";

    resultsBody.innerHTML = (session.results || [])
      .slice()
      .reverse()
      .map((r) => {
        const label = VERDICT_LABEL[MutationFlow.resultKey(r)] || r.terminal;
        const badgeKey = MutationFlow.resultKey(r);
        return `<tr>
          <td>${escHtml(r.toteId)}</td>
          <td><span class="status-pill status-${r.priorityAtSelection}">${escHtml(r.priorityAtSelection || "-")}</span></td>
          <td>${escHtml(r.zone ?? "-")}</td>
          <td>${escHtml(r.instanceCode ?? "-")}</td>
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
      const session = await Api.post(`/auto-engine/sessions/${activeSessionId}/stop`);
      render(session);
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
    } finally {
      stopBtn.disabled = false;
    }
  }

  async function pauseSession() {
    if (!activeSessionId) return;
    try {
      const session = await Api.post(`/auto-engine/sessions/${activeSessionId}/pause`);
      render(session);
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
    }
  }

  async function resumeSession() {
    if (!activeSessionId) return;
    try {
      const session = await Api.post(`/auto-engine/sessions/${activeSessionId}/resume`);
      render(session);
      poll();
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
    }
  }

  // ── Auto Preview / Dry-Run ────────────────────────────────────────────────
  // POST /auto-engine/preview is read-only: it fetches live Locked/
  // Supervisor/Quadron data, runs it through Auto's own classification/diff/
  // queue-ordering logic, and returns the result - it never creates a
  // session, never dispatches, never invokes PULL_QUADRON_TOTE. Zone/
  // station is REQUIRED here, exactly like Start - the server validates via
  // the SAME validateZoneConfig() /start uses and returns the same 400 for
  // a missing/invalid config, surfaced below via the existing error box.

  function previewRowHtml(r) {
    return `<tr>
      <td>${escHtml(r.toteId)}</td>
      <td><span class="status-pill status-${r.priority}">${escHtml(r.priority)}</span></td>
      <td>${escHtml(r.location ?? "-")}</td>
      <td>${r.totalToteInv ?? "-"}</td>
      <td>${escHtml(r.lockedSince ?? "-")}</td>
      <td>${escHtml(r.reason ?? "-")}</td>
    </tr>`;
  }

  async function runPreview() {
    errBox.classList.add("hidden");
    previewBtn.disabled = true;
    previewBtn.textContent = "Previewing…";
    try {
      const zc = currentZoneConfig();
      const body = { ...zc, batchSize: numOrUndefined(cfgBatchSize) };
      Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

      const preview = await Api.post("/auto-engine/preview", body);
      renderPreview(preview);
      previewPanel.style.display = "";
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = "Preview Auto Queue";
    }
  }

  function renderPreview(p) {
    apGeneratedAt.textContent = Fmt.time(p.generatedAt);
    apCallingStation.textContent = `${p.callingStation.zone} (${p.callingStation.instanceCode})`;
    apBatchSize.textContent = p.batchSize;

    apTotalLocked.textContent = p.totalLockedTotes;
    apSd.textContent = p.sdCount;
    apP0.textContent = p.p0Count;
    apP1.textContent = p.p1Count;
    apP2.textContent = p.p2Count;
    apTotalQueued.textContent = p.totalQueueCount;

    if (p.degraded && (p.degraded.supervisor || p.degraded.inventory)) {
      const parts = [];
      if (p.degraded.supervisor) parts.push(`Supervisor Dump unavailable (${p.degradedReasons.supervisor})`);
      if (p.degraded.inventory) parts.push(`Quadron Inventory unavailable (${p.degradedReasons.inventory})`);
      apDegradedNote.textContent = "Degraded: " + parts.join("; ");
      apDegradedNote.classList.remove("hidden");
    } else {
      apDegradedNote.classList.add("hidden");
    }

    const diff = p.diff || { inserted: [], removed: [], reprioritized: [] };
    apDiffNew.textContent = diff.inserted.length;
    apDiffRemoved.textContent = diff.removed.length;
    apDiffReprioritized.textContent = diff.reprioritized.length;

    apFirstBatchBody.innerHTML = (p.firstBatch || []).map(previewRowHtml).join("") || `<tr><td colspan="6">Queue is empty.</td></tr>`;
    apQueueBody.innerHTML = (p.queue || []).map(previewRowHtml).join("") || `<tr><td colspan="6">Queue is empty.</td></tr>`;
  }

  // ── Reconnect after a browser refresh (Phase 7, Issue 6/7) ───────────────
  // The Auto engine is entirely backend-resident (its setTimeout-driven
  // batch/fetch loops keep running in the Node process regardless of any
  // browser tab - see server/lib/autoEngine.js's module comment); the bug
  // was purely that this page's own activeSessionId is a plain JS variable
  // that a refresh wipes, so poll() silently no-ops forever after and the
  // page shows an idle Start form for a session that is still running
  // server-side. This asks the backend "is there already a session I
  // started?" on load and reattaches to it exactly like submitSession()
  // does for a brand-new one - it never creates a session itself. A 404 (no
  // active session) or any other failure is silently ignored: that's the
  // normal, expected state on a fresh page load with nothing running.
  // id: open that session directly (the shared line from the "auto.active" summary - readable by anyone);
  // without one, ask the server for the running session.
  let attaching = false;
  async function reconnectIfActive(id) {
    if (attaching) return;
    attaching = true;
    try {
      const session = await Api.get(id ? `/auto-engine/sessions/${encodeURIComponent(id)}` : "/auto-engine/sessions/active");
      activeSessionId = session.sessionId;
      statusPanel.style.display = "";
      resultsBody.innerHTML = "";
      render(session);
      if (!TERMINAL.has(session.status)) poll();
    } catch (e) {
      // No shared Auto session running (404) or a transient error - the
      // idle Start form underneath is already the correct thing to show.
    } finally {
      attaching = false;
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  multiZoneToggle.addEventListener("change", toggleMultiZone);
  addZoneBtn.addEventListener("click", () => addZoneRow("", Math.max(0, 100 - zoneTotal())));
  startBtn.addEventListener("click", validateAndConfirm);
  stopBtn.addEventListener("click", stopSession);
  pauseBtn.addEventListener("click", pauseSession);
  reminderAckBtn.addEventListener("click", acknowledgeReminder);
  resumeBtn.addEventListener("click", resumeSession);
  previewBtn.addEventListener("click", runPreview);

  reconnectIfActive();

  // Auto Puller is ONE shared line (operator decision 2026-11-04): whoever opens this tab sees the same session,
  // and anyone can pause, resume or stop it. The note says who started it; when a session appears that this page
  // is not showing yet (someone else pressed Start), the page attaches to it.
  const othersNoteEl = document.getElementById("atOthersNote");
  let offActive = null;
  function renderActive(d) {
    const s = ((d && d.sessions) || [])[0];
    if (!s) {
      othersNoteEl.classList.add("hidden");
      othersNoteEl.textContent = "";
      return;
    }
    othersNoteEl.innerHTML = "<b>Shared Auto session running</b>" + (s.by ? " - started by <b>" + escHtml(s.by) + "</b>" : "") + " &middot; " + (s.called || 0) + " called, " + (s.queued || 0) + " queued &middot; anyone can pause or stop it";
    othersNoteEl.classList.remove("hidden");
    if (s.sessionId && s.sessionId !== activeSessionId) reconnectIfActive(s.sessionId);
  }
  function start() {
    if (offActive) return;
    offActive = Live.subscribe("auto.active", (evt) => { if (evt.type === "data") renderActive(evt.data); });
  }
  function stop() {
    if (offActive) { offActive(); offActive = null; }
  }

  return { start, stop };
})();
