// Tote Pull Engine - Manual multi-tote + multi-zone parity (per the
// approved Tote Engine Blueprint). Implements: an engine/session model,
// sequential single-tote execution gated by the global quadronPullLock,
// retry-on-failure up to 5 attempts, the four real Quadron verdicts plus
// the two other states the Blueprint documented (CANCELLED/SKIPPED per
// tote; the session itself uses RUNNING/STOPPED/COMPLETED), and the exact
// smooth-weighted-round-robin zone picker from zonePicker.js.
//
// Explicitly NOT here yet (future phases, per the Blueprint's replication
// matrix): Auto Mode, priority scoring (SD/P0/P1/P2), Supervisor Dump,
// candidate sourcing from Grafana/Quadron/NexS. This file only knows how
// to run an already-decided, ordered list of totes against an already-
// decided zone configuration, one call at a time, exactly as Manual
// Mode's own mTick() does in the existing extension.
//
// PULL_QUADRON_TOTE itself (runtime/background/capabilities.js,
// server/integrations/quadron/pullQuadronTote.js, server/integrations/capabilities/registry.js)
// is not modified by this file - every actual pull goes through the
// existing, unmodified quadronPull.pullOneTote() -> capabilityManager.
// requestCapability() path.

const defaultQueryManager = require("../../platform/queries/queryManager");
const defaultAuditLog = require("../../platform/audit/auditLog");
const { pullOneTote } = require("../../integrations/quadron/quadronPull");
const { validateZoneConfig } = require("./zonePicker");
const { dispatchToteWithRetry } = require("./toteDispatchLoop");
const pullRateLimiter = require("../../integrations/quadron/pullRateLimiter");
const { TOTE_ID_REGEX } = require("../../integrations/quadron/pullQuadronTote");
const defaultPurgeMarks = require("../../platform/storage/purgeMarks");

const DEFAULT_RETRY_DELAY_MS = 5000; // mirrors the existing extension's DEFAULTS.RETRY_DELAY (5s)

class TotePullEngine {
  // dispatchOne/queryManager/auditLog are all injectable so unit tests can
  // exercise the sequencing/retry/verdict/persistence-call logic without a
  // real database or a live runtime - production code passes none of these
  // options and gets the real modules. retryDelayMs is injectable purely so
  // tests don't have to burn 5 real seconds per retry.
  constructor({ dispatchOne = pullOneTote, queryManager = defaultQueryManager, auditLog = defaultAuditLog, retryDelayMs = DEFAULT_RETRY_DELAY_MS, purgeMarks = defaultPurgeMarks } = {}) {
    this.purgeMarks = purgeMarks;
    this.onPurgeSessionDone = null; // wired in live/purgeVerify.js: takes the Quadron baseline of a finished purge session
    this.dispatchOne = dispatchOne;
    this.queryManager = queryManager;
    this.auditLog = auditLog;
    this.retryDelayMs = retryDelayMs;
    this.sessions = new Map(); // sessionId (== the session's own query_id) -> session state
  }

  // Single-zone: pass {zone, instanceCode}. Multi-zone: pass {multiZone:true,
  // zones:[{id,zone,instanceCode,percentage}, ...]} - percentages must sum
  // to exactly 100, matching MultiZone.validate() exactly. One shared zone
  // configuration for the whole session (no per-tote zone assignment, no
  // per-zone queues) - see zonePicker.js for the actual selection algorithm.
  // purpose: "PURGE" = the totes are called to be purged (marked Bermuda to free space); anything else is a normal pull.
  async createAndStart({ user, totes, zone, instanceCode, multiZone, zones, purpose }) {
    const isPurge = String(purpose || "").toUpperCase() === "PURGE";
    if (!Array.isArray(totes) || totes.length === 0) {
      return { ok: false, code: 400, reason: "totes must be a non-empty array" };
    }
    // Deliberately NOT deduplicated here or anywhere downstream - the
    // existing extension's own Manual Mode tote list is never deduplicated
    // either (QTP_UTILS.parseToteList performs no uniqueness check), and
    // replicating that exactly (not "improving" it) is the point of this
    // phase.
    const invalid = totes.filter((t) => typeof t !== "string" || !TOTE_ID_REGEX.test(t));
    if (invalid.length) {
      return { ok: false, code: 400, reason: `Invalid tote id(s): ${invalid.join(", ")}` };
    }

    const zoneConfigInput = { multiZone: !!multiZone, zone, instanceCode, zones };
    const zoneValidation = validateZoneConfig(zoneConfigInput);
    if (!zoneValidation.ok) return { ok: false, code: 400, reason: zoneValidation.reason };

    const resolvedZoneConfig = zoneConfigInput.multiZone
      ? {
          multiZone: true,
          // Mirrors MultiZone.getZoneConfig()'s own fallback shape - only
          // ever used by pickNextZone() in the unreachable-in-practice case
          // where every configured zone has been filtered out as inactive.
          zone: zones[0].zone,
          instanceCode: zones[0].instanceCode,
          zones: zones.map((z) => ({ id: z.id, zone: String(z.zone), instanceCode: String(z.instanceCode), percentage: Number(z.percentage) || 0 })),
        }
      : { multiZone: false, zone: zone.trim(), instanceCode: instanceCode.trim(), zones: [] };

    // The session itself is one more ordinary `queries` row - `operation`
    // is a plain VARCHAR, not an ENUM, so this needs no migration. It
    // inherits the existing reconcileStale() safety net for free: if the
    // backend restarts while this row is QUEUED/RUNNING, the next read of
    // it is automatically reconciled to FAILED, exactly like every other
    // query type already behaves. Per-tote progress detail (below) is
    // intentionally NOT persisted - same convention as queryManager's own
    // in-memory job registry and capabilityManager's own result cache.
    const query = await this.queryManager.createQuery({
      userId: user.id,
      operation: "PULL_QUADRON_TOTE_MANUAL_SESSION",
      parameters: { totes, zoneConfig: resolvedZoneConfig, purpose: isPurge ? "PURGE" : "NORMAL" },
    });
    await this.queryManager.markRunning(query.query_id);

    // The purge intent must be on record BEFORE the first pull: the CC metrics use it to tell this purge from a
    // tote whose stock really went missing. If it cannot be saved, nothing is pulled.
    if (isPurge) {
      try {
        await this.purgeMarks.record(totes, { sessionId: query.query_id, userId: user.id });
      } catch (e) {
        await this.queryManager.finalizeCancelled(query.query_id);
        return { ok: false, code: 500, reason: "Could not record the purge, so nothing was pulled. Try again." };
      }
    }

    const session = {
      sessionId: query.query_id,
      userId: user.id,
      totes,
      purpose: isPurge ? "PURGE" : "NORMAL",
      zoneConfig: resolvedZoneConfig,
      zoneCredits: {}, // reset fresh at the start of every session, per spec
      status: "RUNNING", // RUNNING | STOPPED | COMPLETED - the session's own lifecycle; per-tote outcomes remain exactly the Blueprint's vocabulary (see runSession())
      currentIndex: 0,
      currentZone: null,
      currentInstanceCode: null,
      currentAttempt: null,
      results: [], // one entry per tote that reached a real terminal outcome - see runSession()
      stopRequested: false,
      createdAt: query.created_at,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.sessions.set(session.sessionId, session);

    await this.auditLog.record(user.id, "TOTE_ENGINE_SESSION_STARTED", {
      sessionId: session.sessionId,
      toteCount: totes.length,
      purpose: session.purpose,
      multiZone: resolvedZoneConfig.multiZone,
    });

    // Fire-and-forget, matching capabilityManager's own convention for
    // long-running work: the HTTP layer returns immediately with the
    // created session; progress is polled separately.
    this.runSession(user, session).catch(() => {
      /* runSession persists its own terminal status in every path - nothing further needed here */
    });

    return { ok: true, session: this.snapshot(session) };
  }

  // The actual sequential engine. Never dispatches tote N+1 until tote N's
  // dispatchOne() promise has fully resolved - single-flight in TIME is
  // guaranteed by this await discipline; single-flight ACROSS other callers
  // (the standalone route, or a second session) is guaranteed by
  // dispatchOne() itself acquiring the shared global lock.
  async runSession(user, session) {
    for (let i = 0; i < session.totes.length; i++) {
      session.currentIndex = i;
      if (session.stopRequested) break;
      const toteId = session.totes[i];

      const outcome = await dispatchToteWithRetry({
        dispatchOne: this.dispatchOne,
        retryDelayMs: this.retryDelayMs,
        user,
        toteId,
        sessionId: session.sessionId,
        zoneConfig: session.zoneConfig,
        zoneCredits: session.zoneCredits,
        isStopRequested: () => session.stopRequested,
        onAttempt: ({ zone, instanceCode, attempt }) => {
          session.currentZone = zone;
          session.currentInstanceCode = instanceCode;
          session.currentAttempt = attempt;
        },
      });

      if (outcome && outcome.stopSession) session.stopRequested = true;
      if (outcome) session.results.push(outcome);
      if (session.stopRequested) break;
    }

    session.currentZone = null;
    session.currentInstanceCode = null;
    session.currentAttempt = null;
    session.completedAt = new Date().toISOString();
    if (session.stopRequested) {
      session.status = "STOPPED";
      // The underlying `queries` row still uses the existing CANCELLED
      // enum value - no migration was introduced to add a "STOPPED" value
      // to the shared schema. The Engine's own reported session.status
      // ("STOPPED") is the user-facing vocabulary; this is a deliberate,
      // documented distinction, not an inconsistency.
      await this.queryManager.finalizeCancelled(session.sessionId);
      // The full per-tote results array is embedded directly in the audit
      // detail JSON (additive only - no new table, reuses the existing
      // audit_logs.detail column) so the grouped operation log (see
      // server/platform/audit/operationLog.js) is a completely self-contained,
      // durable record of WHO/WHEN/WHAT/RESULT - it never depends on the
      // Engine's in-memory session state, which does not survive a
      // restart. No token/JWT/cookie is ever present in `results` (see
      // pullQuadronTote.js's own result contract).
      await this.auditLog.record(user.id, "TOTE_ENGINE_SESSION_STOPPED", {
        sessionId: session.sessionId,
        completedTotes: session.results.length,
        totalTotes: session.totes.length,
        purpose: session.purpose,
        zoneConfig: session.zoneConfig,
        results: session.results,
      });
    } else {
      session.status = "COMPLETED";
      await this.queryManager.completeQuery(session.sessionId);
      await this.auditLog.record(user.id, "TOTE_ENGINE_SESSION_COMPLETED", {
        sessionId: session.sessionId,
        completedTotes: session.results.length,
        totalTotes: session.totes.length,
        purpose: session.purpose,
        zoneConfig: session.zoneConfig,
        results: session.results,
      });
    }

    // Calling finished: baseline the purge totes now (best effort - the tracker's timer retries anything missed).
    if (session.purpose === "PURGE" && this.onPurgeSessionDone) {
      try {
        await this.onPurgeSessionDone(session.sessionId);
      } catch (err) {
        console.warn("[purge] baseline after session failed:", err.message || String(err));
      }
    }
  }

  // Clean stop: never aborts a pull that's already been dispatched (no
  // AbortController reaches into an in-flight PULL_QUADRON_TOTE query, by
  // design - the same honest limitation the existing extension's own STOP
  // has always had). Only prevents the NEXT attempt/tote from starting.
  stop(sessionId, requestingUser) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, code: 404, reason: "Session not found (it may predate a backend restart)" };
    if (requestingUser.role !== "ADMIN" && session.userId !== requestingUser.id) {
      return { ok: false, code: 403, reason: "You may not stop another user's session" };
    }
    if (session.status !== "RUNNING") {
      return { ok: false, code: 409, reason: `Session already ${session.status}` };
    }
    session.stopRequested = true;
    return { ok: true, session: this.snapshot(session) };
  }

  get(sessionId, requestingUser) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, code: 404, reason: "Session not found (it may predate a backend restart)" };
    // Watching is open to everyone (site data); stop/pause/resume stay owner-or-ADMIN.
    return { ok: true, session: this.snapshot(session) };
  }

  snapshot(session) {
    return {
      sessionId: session.sessionId,
      status: session.status,
      purpose: session.purpose,
      totes: session.totes,
      zoneConfig: session.zoneConfig,
      currentIndex: session.currentIndex,
      currentTote: session.status === "RUNNING" ? session.totes[session.currentIndex] : null,
      currentZone: session.currentZone,
      currentInstanceCode: session.currentInstanceCode,
      currentAttempt: session.currentAttempt,
      results: session.results,
      // Global rolling-window pull-rate limiter state (server/lib/
      // pullRateLimiter.js) - shared across every Manual/Auto session at
      // once, not per-session, so it's read fresh here rather than stored
      // on the session itself.
      pullLimit: pullRateLimiter.snapshot(),
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
    };
  }
}

module.exports = { TotePullEngine, defaultEngine: new TotePullEngine() };
