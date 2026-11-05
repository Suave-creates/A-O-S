// Auto Mode scheduler - faithful port of the existing extension's Auto
// state machine (background/index.js:1225-1259: A/runBatch/callNextInBatch),
// WITHOUT the heartbeat/operator-confirmation interlock (explicit product
// decision - see the approved Auto Mode Replication Blueprint).
//
// Reuses, rather than duplicates:
//   - server/features/tote-puller/autoQueue.js       - the SD/P0/P1/P2 priority queue
//   - server/features/tote-puller/autoDiff.js        - the differential merge
//   - server/features/locked-tote-info/classification.js  - the SAME classifyLockedTotes() pure
//                                      function Classification's own panel
//                                      uses. Auto calls it itself, on its
//                                      own freshly-fetched rows - it does
//                                      NOT read Classification's snapshot
//                                      or classification_tote_state. A
//                                      tote classified P0 by the
//                                      Classification panel has no
//                                      relationship to Auto's own queue.
//   - server/integrations/capabilities/capabilitySource.js - the same capability-fetch-and-wait
//                                      helper classificationEngine.js uses
//   - server/features/tote-puller/toteDispatchLoop.js - the SAME per-tote dispatch/retry/
//                                      verdict loop totePullEngine.js
//                                      (Manual) uses - no second execution
//                                      or retry implementation.
//   - server/integrations/quadron/quadronPull.js     - pullOneTote(), which acquires the
//                                      SAME global quadronPullLock every
//                                      other caller uses - no second lock.
//
// State machine: IDLE -> RUNNING <-> PAUSED -> {WAITING <-> RUNNING} ->
// COMPLETED | STOPPED. PAUSED is real, non-heartbeat legacy behavior
// (autoPause()/autoResume() message handlers) - included per the explicit
// condition that only heartbeat itself was to be omitted.
//
// Because this backend's Auto Mode always operates against live Grafana/
// Quadron capabilities (there is no manual-paste queue mode, unlike the
// existing extension's optional sheet-only path), a live feed is by
// definition ALWAYS configured - so, exactly matching the existing
// extension's own behavior when grafanaAuto=true, the "queue empty AND no
// live feed -> COMPLETED" branch is structurally present (for state-model
// fidelity) but practically unreachable. Documented here rather than
// silently diverging from the approved blueprint's state model.

const defaultQueryManager = require("../../platform/queries/queryManager");
const defaultAuditLog = require("../../platform/audit/auditLog");
const { pullOneTote } = require("../../integrations/quadron/quadronPull");
const { validateZoneConfig } = require("./zonePicker");
const { dispatchToteWithRetry } = require("./toteDispatchLoop");
const { fetchCapabilitySource } = require("../../integrations/capabilities/capabilitySource");
const { classifyLockedTotes } = require("../../platform/domain/classification");
const { AutoQueue } = require("./autoQueue");
const { diffAndMerge } = require("./autoDiff");

const DEFAULTS = {
  batchSize: 5,
  callIntervalMs: 5000,
  batchIntervalMs: 60000,
  retryDelayMs: 5000,
  cooldownMs: 60 * 60000, // 1 hour, mirrors DEFAULTS.COOLDOWN_HOURS:1
  lockedDumpRefreshMs: 30 * 60000,
  // Legacy quirk, faithfully preserved rather than silently "fixed": the
  // existing extension's GRAFANA_SUPER alarm handler is an empty no-op -
  // Supervisor Dump is actually always fetched bundled into the SAME
  // cycle as Locked Dump (background/index.js:1614: "supervisor fetch is
  // bundled into GRAFANA_LOCKED cycle"). This config value is kept (per
  // the required Auto configuration UI) for fidelity/operator expectation,
  // but does not drive a second, independent fetch schedule - both
  // sources refresh together on lockedDumpRefreshMs.
  supervisorDumpRefreshMs: 60 * 60000,
  // "Is anyone watching?" (operator decision 2026-11-04): every reminderMs a pop-up asks everyone with the Auto
  // Puller panel to acknowledge; if nobody does within reminderAckMs the session stops itself.
  reminderMs: 30 * 60000,
  reminderAckMs: 60 * 1000,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const whoOf = (u) => (u && (u.employeeId || u.employee_id)) || (u && u.id != null ? `user ${u.id}` : "someone");

class AutoEngine {
  constructor({
    dispatchOne = pullOneTote,
    requestCapability,
    wait,
    getResult,
    queryManager = defaultQueryManager,
    auditLog = defaultAuditLog,
    classify = classifyLockedTotes,
    diff = diffAndMerge,
  } = {}) {
    this.dispatchOne = dispatchOne;
    this.requestCapability = requestCapability;
    this.wait = wait;
    this.getResult = getResult;
    this.queryManager = queryManager;
    this.auditLog = auditLog;
    this.classify = classify;
    this.diff = diff;
    this.sessions = new Map(); // sessionId -> session state
  }

  // Phase 7, Issue 6/7: the session already lives entirely in this
  // in-process Map, independent of any browser tab (see the module comment
  // and start()'s own AbortController registration) - a page refresh never
  // touches it. The bug was that nothing let the frontend find its way back
  // to an already-running session, so an operator who refreshed and clicked
  // "Start" again had no way to know one already existed. Scoped to the
  // user's OWN session only (not ADMIN-wide) - this is a reconnect for the
  // person who started it, not a monitoring view of someone else's.
  // Every running Auto session, as a summary that is safe for anyone who may open the Dashboard / Auto Puller to
  // see: who is running it and how far it has got - never the tote list, results or log (those stay per-user).
  // The Dashboard tile reads this, so an admin sees a session an operator started.
  activeSummaries() {
    const out = [];
    for (const s of this.sessions.values()) {
      if (s.status === "STOPPED" || s.status === "COMPLETED") continue;
      out.push({
        sessionId: s.sessionId,
        by: (s.user && s.user.employeeId) || null,
        status: s.status,
        startedAt: s.startedAt,
        called: s.stats.called,
        queued: s.queue.totalSize(),
        reminder: this._reminderView(s),
      });
    }
    return out;
  }

  // Auto Puller is ONE shared line for the whole site (operator decision 2026-11-04): anyone with the Auto Puller
  // panel can start it, and anyone can pause, resume or stop it - there is never a second Auto session.
  findActive() {
    for (const session of this.sessions.values()) {
      if (session.status !== "STOPPED" && session.status !== "COMPLETED") return session;
    }
    return null;
  }

  findActiveForUser(userId) {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.status !== "STOPPED" && session.status !== "COMPLETED") {
        return session;
      }
    }
    return null;
  }

  // start({ user, zone, instanceCode, multiZone, zones, config }) - config
  // is a partial override of DEFAULTS. P0/P1 thresholds are NOT part of
  // this config (Phase 7, Issue 5) - classifyLockedTotes() enforces the
  // fixed 1/2-3/4+ rule itself, unconditionally.
  //
  // Phase 7, Issue 6/7: idempotent against an operator who refreshed and
  // clicked Start again while their own session from before the refresh is
  // still running - returns the EXISTING session (ok:true, started:false)
  // rather than creating a second, independent engine/queue/timer pair that
  // would double-dispatch against the same zone. A genuinely new session
  // still requires the old one to be stopped/completed first, exactly as
  // before.
  async start({ user, zone, instanceCode, multiZone, zones, config: configOverride }) {
    // One shared session: Start while it runs (whoever started it) joins it instead of starting a second line.
    const existing = this.findActive();
    if (existing) return { ok: true, started: false, session: this.snapshot(existing) };

    const zoneConfigInput = { multiZone: !!multiZone, zone, instanceCode, zones };
    const zoneValidation = validateZoneConfig(zoneConfigInput);
    if (!zoneValidation.ok) return { ok: false, code: 400, reason: zoneValidation.reason };

    const resolvedZoneConfig = zoneConfigInput.multiZone
      ? {
          multiZone: true,
          zone: zones[0].zone,
          instanceCode: zones[0].instanceCode,
          zones: zones.map((z) => ({ id: z.id, zone: String(z.zone), instanceCode: String(z.instanceCode), percentage: Number(z.percentage) || 0 })),
        }
      : { multiZone: false, zone: zone.trim(), instanceCode: instanceCode.trim(), zones: [] };

    const config = { ...DEFAULTS, ...(configOverride || {}) };

    const query = await this.queryManager.createQuery({
      userId: user.id,
      operation: "AUTO_ENGINE_SESSION",
      parameters: { zoneConfig: resolvedZoneConfig, config },
    });
    await this.queryManager.markRunning(query.query_id);

    // Phase 7, Issue 1/2: register this session as a real, abortable Query
    // Manager job - the SAME mechanism capabilityManager.js uses for every
    // capability call, not a second cancellation scheme. This does two
    // things at once: (1) queryManager.cancelQuery() (the existing generic
    // POST /admin/queries/:id/cancel and POST /queries/:id/cancel routes)
    // can now actually reach and stop this session instead of silently
    // finalizing the DB row to CANCELLED while the engine keeps running
    // (see cancellationSupport.js), and (2) it stops reconcileStale() from
    // treating a genuinely-running Auto session as an abandoned job the
    // instant anyone calls GET /admin/queries while it's active.
    const abortController = new AbortController();
    const cancelJob = this.queryManager.registerJob(query.query_id, abortController);

    const session = {
      sessionId: query.query_id,
      userId: user.id,
      startedBy: whoOf(user),
      user,
      status: "RUNNING", // RUNNING | PAUSED | WAITING | COMPLETED | STOPPED
      config,
      zoneConfig: resolvedZoneConfig,
      zoneCredits: {}, // reset fresh at start, never reset between batches - persists for the whole session
      queue: new AutoQueue(),
      callHistory: new Map(), // toteId -> lastCalledAtMs, for the per-tote cooldown gate
      currentBatch: [],
      batchIndex: 0,
      currentZone: null,
      currentInstanceCode: null,
      currentAttempt: null,
      stats: { called: 0, alreadyQueued: 0, notAvailable: 0, skipped: 0, ignored: 0, batchesRun: 0 },
      results: [],
      log: [],
      stopRequested: false,
      cancelledByUser: false,
      abortController,
      cancelJob,
      callTimer: null,
      fetchTimer: null,
      reminderTimer: null,
      reminder: { nextAt: null, askedAt: null, deadline: null, lastAckBy: null, lastAckAt: null },
      createdAt: query.created_at,
      startedAt: new Date().toISOString(),
      completedAt: null,
      lastFetch: null,
    };
    this.sessions.set(session.sessionId, session);

    // The actual stop mechanism: reuses stop()'s own finalize path rather
    // than a second implementation. { once: true } plus _finalize()'s own
    // already-terminal guard (below) together make this race-safe against
    // an operator's explicit Stop button firing at the same time.
    abortController.signal.addEventListener(
      "abort",
      () => {
        session.stopRequested = true;
        session.cancelledByUser = cancelJob.wasCancelledByUser();
        this._finalize(session, "STOPPED").catch((e) => this._log(session, "warn", `Cancellation finalize error: ${e.message || e}`));
      },
      { once: true }
    );

    await this.auditLog.record(user.id, "AUTO_ENGINE_SESSION_STARTED", { sessionId: session.sessionId, multiZone: resolvedZoneConfig.multiZone });

    // Matches AUTO_START's own synchronous initial fetch before the first
    // batch - Auto never begins with an empty, unpopulated queue.
    this._scheduleReminder(session);
    await this.runFetchCycle(session);
    this._scheduleFetchLoop(session);
    await this.runBatch(session);

    return { ok: true, session: this.snapshot(session) };
  }

  // ── "Is anyone watching?" reminder ─────────────────────────────────────────
  // The session's own timer (like its fetch/call timers): runs while the session runs, paused or not, and is
  // cleared when it ends. unref(): a pending reminder never keeps the process alive on shutdown.
  _scheduleReminder(session) {
    if (session.reminderTimer) clearTimeout(session.reminderTimer);
    session.reminderTimer = null;
    if (session.status === "STOPPED" || session.status === "COMPLETED") return;
    const every = session.config.reminderMs;
    session.reminder.askedAt = null;
    session.reminder.deadline = null;
    session.reminder.nextAt = Date.now() + every;
    session.reminderTimer = setTimeout(() => this._askReminder(session), every);
    if (session.reminderTimer.unref) session.reminderTimer.unref();
  }

  _askReminder(session) {
    if (session.status === "STOPPED" || session.status === "COMPLETED") return;
    const ackMs = session.config.reminderAckMs;
    session.reminder.askedAt = Date.now();
    session.reminder.deadline = Date.now() + ackMs;
    session.reminder.nextAt = null;
    this._log(session, "warn", `Reminder: is anyone watching? Auto stops in ${Math.round(ackMs / 1000)} s unless someone acknowledges.`);
    session.reminderTimer = setTimeout(() => {
      this._reminderExpired(session).catch((e) => this._log(session, "warn", `Reminder stop error: ${e.message || e}`));
    }, ackMs);
    if (session.reminderTimer.unref) session.reminderTimer.unref();
  }

  async _reminderExpired(session) {
    if (session.status === "STOPPED" || session.status === "COMPLETED" || !session.reminder.askedAt) return;
    session.stopRequested = true;
    session.stoppedBy = "no one acknowledged the reminder";
    this._log(session, "warn", "Stopped automatically - no one acknowledged the reminder.");
    await this._finalize(session, "STOPPED");
  }

  // Anyone with the Auto Puller panel may acknowledge; it starts the next reminder interval.
  acknowledge(sessionId, requestingUser) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, code: 404, reason: "Session not found (it may predate a backend restart)" };
    if (session.status === "STOPPED" || session.status === "COMPLETED") {
      return { ok: false, code: 409, reason: `Session already ${session.status}` };
    }
    const who = whoOf(requestingUser);
    const wasAsked = !!session.reminder.askedAt;
    session.reminder.lastAckBy = who;
    session.reminder.lastAckAt = Date.now();
    this._scheduleReminder(session);
    if (wasAsked) this._log(session, "info", `Reminder acknowledged by ${who}.`);
    return { ok: true, session: this.snapshot(session) };
  }

  _scheduleFetchLoop(session) {
    if (session.fetchTimer) clearTimeout(session.fetchTimer);
    if (session.status === "STOPPED" || session.status === "COMPLETED") return;
    session.fetchTimer = setTimeout(async () => {
      if (session.status === "STOPPED" || session.status === "COMPLETED") return;
      await this.runFetchCycle(session);
      this._scheduleFetchLoop(session);
    }, session.config.lockedDumpRefreshMs);
  }

  // One fetch+classify+merge cycle - Locked Dump + Supervisor Dump (∩
  // Locked Dump, inside classify()) + Quadron Inventory, then the same
  // classifyLockedTotes() Classification uses, then diffAndMerge() into
  // this session's OWN queue. Never throws - a source failure degrades
  // gracefully (matches classificationEngine.js's own policy) rather than
  // stopping the Auto session; the next scheduled cycle tries again.
  async runFetchCycle(session) {
    const fetchOpts = { user: session.user, requestCapability: this.requestCapability, wait: this.wait, getResult: this.getResult };
    const [locked, supervisor, inventory] = await Promise.all([
      fetchCapabilitySource({ ...fetchOpts, capabilityName: "GET_GRAFANA_LOCKED_TOTES" }),
      fetchCapabilitySource({ ...fetchOpts, capabilityName: "GET_GRAFANA_SUPERVISOR_DUMP" }),
      fetchCapabilitySource({ ...fetchOpts, capabilityName: "GET_QUADRON_INVENTORY" }),
    ]);

    if (!locked.ok) {
      this._log(session, "net_err", `Fetch cycle failed - Locked Tote Dump unavailable: ${locked.reason}`);
      return { ok: false, reason: locked.reason };
    }

    const { totes } = this.classify({
      lockedRows: locked.rows,
      supervisorRows: supervisor.ok ? supervisor.rows : [],
      inventoryRows: inventory.ok ? inventory.rows : [],
    });

    const { removed, inserted, reprioritized } = this.diff(session.queue, totes);
    session.lastFetch = new Date().toISOString();
    this._log(session, "info", `Fetch cycle - +${inserted.length} inserted, ~${reprioritized.length} reprioritized, -${removed.length} cleared. Queue: ${session.queue.totalSize()}`);

    // Wake a WAITING session the instant new totes arrive - matches
    // _resumeIfWaiting()'s own "resume automatically instead of just
    // avoiding the stop" behavior.
    if (session.status === "WAITING" && !session.queue.isEmpty()) {
      session.status = "RUNNING";
      this._log(session, "info", "New totes arrived - resuming Auto session.");
      await this.runBatch(session);
    }

    return { ok: true, inserted, removed, reprioritized };
  }

  async runBatch(session) {
    if (session.status !== "RUNNING") return;
    if (session.callTimer) {
      clearTimeout(session.callTimer);
      session.callTimer = null;
    }

    if (session.queue.isEmpty()) {
      session.status = "WAITING";
      session.currentBatch = [];
      session.batchIndex = 0;
      this._log(session, "info", "Queue empty - waiting for the next fetch cycle to bring in more totes.");
      return;
    }

    const batch = session.queue.next(session.config.batchSize);
    if (!batch.length) {
      session.status = "WAITING";
      session.currentBatch = [];
      session.batchIndex = 0;
      return;
    }

    session.currentBatch = batch;
    session.batchIndex = 0;
    session.stats.batchesRun++;
    const priorities = [...new Set(batch.map((e) => e.priority))].join("+");
    this._log(session, "info", `Batch ${session.stats.batchesRun} - ${batch.length} totes [${priorities}] | ${session.queue.totalSize()} remaining`);

    session.callTimer = setTimeout(() => this.callNextInBatch(session), 0);
  }

  async callNextInBatch(session) {
    session.callTimer = null;
    if (session.status !== "RUNNING") return;

    if (session.batchIndex >= session.currentBatch.length) {
      session.currentBatch = [];
      session.batchIndex = 0;
      this._log(session, "info", `Batch ${session.stats.batchesRun} complete - waiting ${session.config.batchIntervalMs}ms.`);
      session.callTimer = setTimeout(() => this.runBatch(session), session.config.batchIntervalMs);
      return;
    }

    // Preemption: checked at the top of every attempt boundary, never
    // mid-flight of an actual Quadron request. The first tote of an
    // active batch always completes - only checked when batchIndex > 0.
    if (session.queue.shouldPreempt() && session.batchIndex > 0) {
      const remainder = session.currentBatch.slice(session.batchIndex);
      session.queue.requeue(remainder);
      this._log(session, "warn", `SD/P0 preemption - requeued ${remainder.length} unused tote(s), rebuilding batch.`);
      session.currentBatch = [];
      session.batchIndex = 0;
      await this.runBatch(session);
      return;
    }

    const entry = session.currentBatch[session.batchIndex];

    // Cooldown gate - call-time only (never at merge/insert time), exactly
    // matching the existing extension's own callNextInBatch(). A recently-
    // called tote still occupies its batch slot; it's just ignored, not
    // pre-filtered upstream.
    const lastCalledAt = session.callHistory.get(entry.toteId);
    if (lastCalledAt != null && Date.now() - lastCalledAt < session.config.cooldownMs) {
      this._log(session, "ignored", `${entry.toteId} ignored - cooldown active`);
      session.stats.ignored++;
      session.batchIndex++;
      session.callTimer = setTimeout(() => this.callNextInBatch(session), 500);
      return;
    }

    const t0 = Date.now();
    const outcome = await dispatchToteWithRetry({
      dispatchOne: this.dispatchOne,
      retryDelayMs: session.config.retryDelayMs,
      user: session.user,
      toteId: entry.toteId,
      sessionId: session.sessionId,
      zoneConfig: session.zoneConfig,
      zoneCredits: session.zoneCredits,
      isStopRequested: () => session.stopRequested,
      rateLimited: false, // the pull-rate limit is the Manual Puller's
      onAttempt: ({ zone, instanceCode, attempt }) => {
        session.currentZone = zone;
        session.currentInstanceCode = instanceCode;
        session.currentAttempt = attempt;
      },
    });

    if (outcome) {
      session.callHistory.set(entry.toteId, Date.now());
      if (outcome.terminal === "SKIPPED") session.stats.skipped++;
      else if (outcome.verdict === "INSERTED" || outcome.verdict === "RELEASED") session.stats.called++;
      else if (outcome.verdict === "ALREADY_QUEUED") session.stats.alreadyQueued++;
      else if (outcome.verdict === "NOT_AVAILABLE") session.stats.notAvailable++;

      session.results.push({ ...outcome, priorityAtSelection: entry.priority, source: entry.source });
      this._log(session, "info", `[${entry.toteId}] [${entry.priority}] ${outcome.verdict || outcome.terminal}`);

      if (outcome.stopSession) {
        session.stopRequested = true;
        await this._finalize(session, "STOPPED");
        return;
      }
    }

    // Phase 7, Issue 2: re-check after the await, not just at function
    // entry - the session may have been cancelled/stopped WHILE this tote's
    // dispatch was in flight. The dispatch itself is never aborted mid-
    // flight (same documented limitation as stop() above it), but once it
    // resolves, do not dispatch the next tote or schedule any further work.
    if (session.status !== "RUNNING") return;

    session.batchIndex++;
    const elapsed = Date.now() - t0;
    const delay = Math.max(0, session.config.callIntervalMs - elapsed);
    session.callTimer = setTimeout(() => this.callNextInBatch(session), delay);
  }

  // Clean stop: never aborts a pull already dispatched, only prevents the
  // NEXT attempt/tote from starting - same honest limitation as Manual's
  // stop(). Auto never naturally reaches COMPLETED in this architecture
  // (see module comment) - an operator-triggered stop is the real way an
  // Auto session ends, and is what produces the ONE grouped operation-log
  // entry for the whole session.
  async stop(sessionId, requestingUser) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, code: 404, reason: "Session not found (it may predate a backend restart)" };
    // shared line: anyone may stop it (the panel check on the route decides who can reach this at all)
    if (session.status === "STOPPED" || session.status === "COMPLETED") {
      return { ok: false, code: 409, reason: `Session already ${session.status}` };
    }
    session.stopRequested = true;
    session.stoppedBy = whoOf(requestingUser);
    this._log(session, "warn", `Stopped by ${session.stoppedBy}.`);
    await this._finalize(session, "STOPPED");
    return { ok: true, session: this.snapshot(session) };
  }

  // Pause halts EXECUTION only - matches the existing extension's own
  // autoPause(), which clears only the CALL alarm, never the fetch alarm.
  // The queue keeps refreshing (diffAndMerge still runs on schedule) while
  // paused; no tote is dispatched until resume().
  pause(sessionId, requestingUser) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, code: 404, reason: "Session not found (it may predate a backend restart)" };
    if (session.status !== "RUNNING" && session.status !== "WAITING") {
      return { ok: false, code: 409, reason: `Cannot pause a session that is ${session.status}` };
    }
    if (session.callTimer) {
      clearTimeout(session.callTimer);
      session.callTimer = null;
    }
    session.pausedFromStatus = session.status;
    session.status = "PAUSED";
    this._log(session, "warn", `Paused by ${whoOf(requestingUser)}.`);
    return { ok: true, session: this.snapshot(session) };
  }

  async resume(sessionId, requestingUser) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, code: 404, reason: "Session not found (it may predate a backend restart)" };
    if (session.status !== "PAUSED") {
      return { ok: false, code: 409, reason: "Session is not paused" };
    }
    session.status = "RUNNING";
    this._log(session, "info", `Resumed by ${whoOf(requestingUser)}.`);
    if (session.currentBatch.length > 0 && session.batchIndex < session.currentBatch.length) {
      session.callTimer = setTimeout(() => this.callNextInBatch(session), 0);
    } else {
      await this.runBatch(session);
    }
    return { ok: true, session: this.snapshot(session) };
  }

  get(sessionId, requestingUser) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, code: 404, reason: "Session not found (it may predate a backend restart)" };
    // Watching is open to everyone (site data); stop/pause/resume stay owner-or-ADMIN.
    return { ok: true, session: this.snapshot(session) };
  }

  async _finalize(session, finalStatus) {
    // Idempotent: STOPPED/COMPLETED are both terminal, and this can now be
    // reached from three independent triggers - stop(), the abort listener
    // registered in start() (an operator cancelling via Active Queries),
    // and callNextInBatch()'s own outcome.stopSession branch (a child
    // PULL_QUADRON_TOTE query being cancelled directly). Whichever fires
    // first wins; the others become no-ops instead of double-finalizing
    // (double audit-log entry, CANCELLED being overwritten by a later
    // COMPLETED, etc).
    if (session.status === "STOPPED" || session.status === "COMPLETED") return;
    if (session.reminderTimer) {
      clearTimeout(session.reminderTimer);
      session.reminderTimer = null;
    }
    session.reminder.askedAt = null;
    session.reminder.deadline = null;
    session.reminder.nextAt = null;
    if (session.callTimer) {
      clearTimeout(session.callTimer);
      session.callTimer = null;
    }
    if (session.fetchTimer) {
      clearTimeout(session.fetchTimer);
      session.fetchTimer = null;
    }
    session.currentZone = null;
    session.currentInstanceCode = null;
    session.currentAttempt = null;
    session.status = finalStatus;
    session.completedAt = new Date().toISOString();

    // Single grouped audit record for the WHOLE session, exactly like
    // Manual's own TOTE_ENGINE_SESSION_STOPPED/COMPLETED - never one entry
    // per fetch cycle, batch, or tote. The full per-tote results array is
    // embedded directly (additive reuse of the existing audit_logs.detail
    // JSON column, same as Manual - no new table).
    const action = finalStatus === "COMPLETED" ? "AUTO_ENGINE_SESSION_COMPLETED" : "AUTO_ENGINE_SESSION_STOPPED";
    if (finalStatus === "COMPLETED") await this.queryManager.completeQuery(session.sessionId);
    else await this.queryManager.finalizeCancelled(session.sessionId);
    // Mirrors capabilityManager.js's own cleanup after every capability call
    // finishes - without this the registry entry (and its AbortController
    // closure) would never be released for the life of the process. Safe to
    // call unconditionally: cancelQuery() already checks the query's DB
    // status before ever touching the registry (see queryManagerMemory.js/
    // queryManagerMysql.js's ACTIVE_STATUSES guard), so an already-stale
    // entry here was never a correctness risk - only a leak.
    this.queryManager.unregisterJob(session.sessionId);

    await this.auditLog.record(session.userId, action, {
      sessionId: session.sessionId,
      completedTotes: session.results.length,
      zoneConfig: session.zoneConfig,
      results: session.results,
      totalTotes: session.results.length,
      startedBy: session.startedBy || null,
      stoppedBy: session.stoppedBy || null,
    });
  }

  _log(session, level, message) {
    session.log.push({ t: Date.now(), level, message });
    if (session.log.length > 300) session.log = session.log.slice(-300);
  }

  _reminderView(session) {
    const r = session.reminder || {};
    const cfg = session.config || {};
    return { everyMs: cfg.reminderMs, ackMs: cfg.reminderAckMs, nextAt: r.nextAt, askedAt: r.askedAt, deadline: r.deadline, lastAckBy: r.lastAckBy, lastAckAt: r.lastAckAt };
  }

  snapshot(session) {
    return {
      sessionId: session.sessionId,
      status: session.status,
      startedBy: session.startedBy || null, // shared line: who started it / who stopped it
      stoppedBy: session.stoppedBy || null,
      // True only once an operator's Cancel (via Active Queries or the
      // generic query-cancel route) actually reached this session's
      // AbortController - lets the UI show "CANCELLED" for that case and
      // "STOPPED" for an explicit Stop button click, without inventing a
      // second session.status enum value (see start()'s abort listener).
      cancelledByUser: session.cancelledByUser,
      config: session.config,
      zoneConfig: session.zoneConfig,
      queue: session.queue.snapshot(),
      // worstPid: genuinely carried by every AutoQueue entry already (see
      // autoQueue.js's insert()/updatePriority()) - mapping it through here
      // (Phase 7, Issue 4) is not a new computation, just exposing existing
      // state so the UI can show "Current PID" without inventing one.
      currentBatch: session.currentBatch.map((e) => ({ toteId: e.toteId, priority: e.priority, worstPid: e.worstPid ?? null })),
      currentIndex: session.batchIndex,
      currentTote: session.status === "RUNNING" && session.currentBatch[session.batchIndex] ? session.currentBatch[session.batchIndex].toteId : null,
      currentZone: session.currentZone,
      currentInstanceCode: session.currentInstanceCode,
      currentAttempt: session.currentAttempt,
      stats: { ...session.stats },
      results: session.results,
      // Auto is not under the Manual Puller's pull-rate limit; its safety is the reminder instead.
      reminder: this._reminderView(session),
      log: session.log,
      lastFetch: session.lastFetch,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
    };
  }
}

module.exports = { AutoEngine, defaultEngine: new AutoEngine(), DEFAULTS };
