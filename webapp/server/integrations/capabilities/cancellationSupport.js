// isCancellationSupported(operation) - whether a Cancel button for this
// query operation would actually stop real work, not just flip a DB status.
//
// True for the 6 capability-backed operations in
// server/integrations/capabilities/registry.js. Their cancel path is fully verified,
// end-to-end and race-safe: queryManager.cancelQuery() -> registry entry's
// AbortController.abort() -> capabilityManager's onAbort sends
// CAPABILITY_CANCEL to the runtime -> runtime/background/capabilities.js's
// handleCapabilityCancel() aborts the in-flight fetch -> the pending result
// promise rejects (AbortError) -> capabilityManager distinguishes
// job.wasCancelledByUser() and calls queryManager.finalizeCancelled().
//
// Also true for AUTO_ENGINE_SESSION (Phase 7, Issue 1/2 fix) - the SAME
// pattern, applied to the session-level query: AutoEngine.start()
// (server/features/tote-puller/autoEngine.js) now calls queryManager.registerJob() with a
// real AbortController and adds an abort listener that calls the SAME
// _finalize()/stop() path the operator's own Stop button uses - no new,
// second interruption mechanism. queryManager.cancelQuery() -> that
// controller's abort() -> the session's callTimer/fetchTimer are cleared,
// session.status becomes STOPPED, and the query row is finalized CANCELLED,
// all through _finalize(), which is idempotent against being reached twice
// (stop() vs this abort listener vs an in-flight tote's own cancellation -
// see _finalize()'s own guard). The one honestly-documented limitation
// (identical to the pre-existing Stop button's own limitation): a tote pull
// already dispatched to a runtime when cancellation is requested is not
// itself aborted mid-flight - only the NEXT tote/batch is prevented from
// starting. See autoEngine.js's own module comment and stop()'s comment.
//
// Also true for CNG_VALIDATOR_RUN (operator-reported: a run stuck on a slow
// GET_NEXS_DISCREPANCY_REPORT_BATCH batch, Q-001900, had no way to cancel -
// this operation wasn't a capability name and wasn't in this list, so
// isCancellationSupported() correctly reported it as unsupported and the UI
// correctly hid the button, but that was masking a real gap rather than a
// deliberate limitation). cngValidator.js's run() now tracks whichever
// inner capability quer(ies) are currently in flight and cascades a real
// queryManager.cancelQuery() to each of them on abort - the same
// capability-cancellation path a direct capability query's own Cancel
// button already uses, not a second mechanism.
//
// Backend-only, non-capability, non-session operations (TOTE_UTILISATION,
// NEXS_ASRS_DUMP_REFRESH, TOTE_PURGE_GENERATE, and the Manual session-level
// query) are still deliberately reported as NOT cancellation-supported,
// even though some of them call queryManager.registerJob():
//   - TOTE_PURGE_GENERATE and TOTE_ENGINE_SESSION (Manual) never call
//     registerJob() at all (confirmed by inspection) - queryManager.
//     cancelQuery() would find no live registry entry and immediately
//     finalize the query as CANCELLED while the real background work (e.g.
//     purgeEngine.generate()'s PID loop) keeps running unaware and later
//     overwrites that with COMPLETED/FAILED.
//   - toteUtilisationJob.js DOES call registerJob(), but only so
//     reconcileStale() doesn't treat the query as abandoned - its
//     AbortController's signal is never checked anywhere in the job body
//     (documented in that file). The same race applies: cancel flips status,
//     the job finishes anyway a moment later and overwrites it.
//   - nexsAsrsDumpEngine.js's refresh() DOES thread its signal into the
//     provider call, but runtimeAsrsDumpProvider.js (the production path)
//     explicitly documents ignoring that signal - the real network work is
//     an independent, separately-cancellable inner GET_NEXS_ASRS_DUMP
//     capability query, so aborting the OUTER refresh's controller does not
//     stop it either.
//
// This is intentionally the same "small, explicit, hand-maintained" style
// as capabilities/registry.js itself - not a generic heuristic. Fixing the
// remaining backend-only jobs' cancellation wiring (Purge/Utilisation/
// NEXS-refresh/Manual) is a real, worthwhile follow-up, but out of scope
// here: it requires touching those modules' internals, and Manual's own
// cancellation is not what this phase's Issue 1/2 asked for (Auto only).

const capabilityRegistry = require("./registry");

// Session-level (non-capability) operations individually verified to wire
// queryManager.registerJob()'s AbortController through to a real stop of
// the underlying work - see the module comment above for each one's exact
// mechanism. Do NOT add an operation here unless its abort signal is
// actually checked somewhere that stops real work - that is precisely the
// mistake documented above for toteUtilisationJob.js/purgeEngine.js.
const CANCELLABLE_SESSION_OPERATIONS = new Set(["AUTO_ENGINE_SESSION", "CNG_VALIDATOR_RUN"]);

function isCancellationSupported(operation) {
  if (CANCELLABLE_SESSION_OPERATIONS.has(operation)) return true;
  const capability = capabilityRegistry.getCapability(operation);
  return !!(capability && capability.cancellationSupported);
}

module.exports = { isCancellationSupported, CANCELLABLE_SESSION_OPERATIONS };
