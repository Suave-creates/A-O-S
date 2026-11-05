// The ONE place PULL_QUADRON_TOTE per-tote dispatch/retry/verdict logic
// lives. Extracted out of totePullEngine.js's runSession() so Auto Mode
// (server/features/tote-puller/autoEngine.js) can reuse it exactly rather than duplicating
// it - Manual and Auto must never have two copies of retry/zone-selection
// behavior that could drift apart. This is a pure extraction: the control
// flow is identical to what totePullEngine.js's runSession() already did
// before this file existed (proven by the full, unmodified
// totePullEngine.test.js suite still passing after the extraction).
//
// Zone selection happens once per ATTEMPT (not once per tote) - a retried
// tote can land on a different zone than its previous attempt. This
// mirrors the existing extension's own mTick()/callNextInBatch(), which
// call pickNextZone() on every tick including retries.

const { pickNextZone } = require("./zonePicker");
const pullRateLimiter = require("../../integrations/quadron/pullRateLimiter");

const MAX_RETRIES = 5; // mirrors the existing extension's LIMITS.MAX_RETRIES
const RATE_LIMIT_POLL_MS = 1000; // how often to re-check the rolling window while waiting

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// dispatchToteWithRetry({
//   dispatchOne, retryDelayMs, user, toteId, sessionId, zoneConfig, zoneCredits,
//   isStopRequested, onAttempt,
// }) -> outcome | null
//
// outcome shapes (exactly what runSession()/autoEngine.js persist):
//   { toteId, terminal:"COMPLETED", verdict, rawMessage, queryId, attempt, zone, instanceCode }
//   { toteId, terminal:"CANCELLED", queryId, attempt, zone, instanceCode, stopSession:true }
//   { toteId, terminal:"SKIPPED", reason, resolution, queryId, attempt, zone, instanceCode }
//     resolution: "failed" - every attempt was refused or reported FAILED, so nothing was pulled (safe to retry);
//                 "uncertain" - at least one attempt timed out or ended ambiguously, so a pull may have gone
//                 through and must be reconciled before retrying (STRUCTURE.md query lifecycle).
// Returns null only if isStopRequested() became true between attempts (the
// caller's loop is responsible for stopping; this function never itself
// decides to abandon a tote for any other reason).
// rateLimited: false for the Auto Puller - the rolling-window limit is the Manual Puller's, shared by all its users
// together (operator decision 2026-11-04); Auto pulls neither wait for it nor count toward it.
async function dispatchToteWithRetry({ dispatchOne, retryDelayMs, user, toteId, sessionId, zoneConfig, zoneCredits, isStopRequested, onAttempt, rateLimited = true }) {
  let attempt = 1;
  let sawUncertain = false;
  while (attempt <= MAX_RETRIES) {
    if (isStopRequested && isStopRequested()) return null;

    // Rolling-window pull-rate limiter (server/integrations/quadron/pullRateLimiter.js) - a
    // real cap on total pull THROUGHPUT, shared globally across every
    // Manual/Auto session at once. When the window is full, WAIT (checking
    // for a stop request every tick) rather than erroring the tote out -
    // this mirrors the reference extension's own safety-limiter modal,
    // which pauses pulling and auto-dismisses the instant a slot frees,
    // never fails a tote outright over pacing.
    while (rateLimited && pullRateLimiter.snapshot().limitReached) {
      if (isStopRequested && isStopRequested()) return null;
      await sleep(RATE_LIMIT_POLL_MS);
    }

    // Called once per ATTEMPT - see module comment above.
    const picked = pickNextZone(zoneConfig, zoneCredits);
    if (onAttempt) onAttempt({ zone: picked.zone, instanceCode: picked.instanceCode, attempt });

    const dispatch = await dispatchOne({ user, toteId, zone: picked.zone, instanceCode: picked.instanceCode, sessionId });
    // Every real dispatchOne() call is one actual request against Quadron,
    // regardless of its outcome (success, failure, or retry-triggering) -
    // it must count toward the cap.
    if (rateLimited) pullRateLimiter.record();

    if (dispatch.ok && dispatch.query && dispatch.query.status === "COMPLETED" && dispatch.result) {
      return {
        toteId,
        terminal: "COMPLETED",
        verdict: dispatch.result.verdict,
        rawMessage: dispatch.result.rawMessage,
        queryId: dispatch.query.query_id,
        attempt,
        zone: picked.zone,
        instanceCode: picked.instanceCode,
      };
    }

    if (dispatch.ok && dispatch.query && dispatch.query.status === "CANCELLED") {
      // An operator explicitly cancelling one of this tote's child pulls
      // (via the existing generic cancel route) is treated as a deliberate
      // stop signal for the whole session, not just this tote - the caller
      // is responsible for acting on stopSession.
      return { toteId, terminal: "CANCELLED", queryId: dispatch.query.query_id, attempt, zone: picked.zone, instanceCode: picked.instanceCode, stopSession: true };
    }

    // Everything else - a dispatch-level failure (no online/approved
    // runtime, role denied, a transient duplicate-in-flight race) or a
    // FAILED/TIMEOUT terminal query status - is the existing extension's
    // single RETRY bucket. NOT_AVAILABLE and ALREADY_QUEUED are never
    // routed through this branch - they are real business outcomes
    // classified as COMPLETED above, and always advance without retrying.
    const lastReason = dispatch.ok ? dispatch.query.error || dispatch.query.status : dispatch.reason;
    const lastQueryId = dispatch.ok && dispatch.query ? dispatch.query.query_id : null;
    // A dispatch-level refusal never reached Quadron and FAILED is a definite error; anything else (TIMEOUT...)
    // may have been executed upstream, and a later clean failure does not undo that.
    if (dispatch.ok && !(dispatch.query && dispatch.query.status === "FAILED")) sawUncertain = true;
    if (attempt >= MAX_RETRIES) {
      return { toteId, terminal: "SKIPPED", reason: lastReason, resolution: sawUncertain ? "uncertain" : "failed", queryId: lastQueryId, attempt, zone: picked.zone, instanceCode: picked.instanceCode };
    }
    attempt++;
    await sleep(retryDelayMs);
  }
  return null;
}

module.exports = { dispatchToteWithRetry, MAX_RETRIES };
