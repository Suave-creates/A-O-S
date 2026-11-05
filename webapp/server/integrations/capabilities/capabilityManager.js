// Orchestrates capability execution, using the existing, UNMODIFIED Query
// Manager exactly as it already works for Tote Utilisation (same createQuery/
// markRunning/registerJob/completeQuery/failQuery/timeoutQuery/
// finalizeCancelled/unregisterJob functions - see server/features/tote-utilisation/toteUtilisationJob.js
// for the pattern this mirrors).
//
// Every capability executes server-side: registry.js gives each one an
// authService ("grafana" | "concinity" | "nexs") and a directExecute() that
// performs the real request using that service's shared login
// (server/integrations/logins/). There is no remote worker, so no dispatch,
// heartbeat, or per-workstation concurrency gate.
//
// commandId === query.query_id, always - no second ID scheme, no separate
// command/query mapping table.
//
// Role check enforced here: capability.allowedRoles.
//
// EFFICIENCY (operator request, 2026-09-04: "don't burden the servers we're
// fetching data from... extract data effectively and efficiently"). Every
// caller (20+ call sites - trackerEngine, dashboardEngine, autoEngine,
// cngValidator, classificationEngine, ...) still gets back its own real,
// unique query_id from requestCapability() and can poll/cancel it exactly
// as before - see server/integrations/capabilities/capabilitySource.js's own fetchCapabilitySource(),
// the shared "request+wait+unwrap" helper most callers use, which only ever
// depends on that contract. What changes is invisible to every caller:
//   - Read-only capabilities (registry.js's readOnly:true - everything
//     except PULL_QUADRON_TOTE) get coalesced: if an identical
//     capability+params request is already in flight, a new caller's own
//     query still gets created and tracked individually, but no second real
//     request is ever made - it "follows" the one already running and
//     finalizes with the same outcome. Cancelling a follower's own query
//     only detaches that follower; only cancelling the LEADER (the query that
//     actually triggered the request) aborts the real request, which then
//     correctly fails every follower still waiting on it too - an honest
//     reflection of shared work that didn't complete, never a fabricated
//     success.
//   - A short-TTL cache (config.capabilityResultCacheTtlMs) serves a
//     brand-new, non-overlapping request for the same capability+params
//     with no request at all, if a result completed that recently.
// See requestCoalescer.js for the actual mechanics - a pure, independently
// unit-tested, dependency-free module.
//
// Every internal function below threads a `deps` bundle (defaulting to the
// real modules) rather than reaching for the module-level requires
// directly - the same dependency-injection convention already used
// throughout this codebase - so this file can be unit-tested against fakes
// with zero real MySQL/network - see server/test/capabilityManager.test.js.

const defaultQueryManager = require("../../platform/queries/queryManager");
const defaultAuditLog = require("../../platform/audit/auditLog");
const defaultRegistry = require("./registry");
const defaultCoalescer = require("./requestCoalescer");
const defaultConfig = require("../../config");

const defaultDeps = {
  queryManager: defaultQueryManager,
  auditLog: defaultAuditLog,
  registry: defaultRegistry,
  coalescer: defaultCoalescer,
  config: defaultConfig,
};

// commandId -> normalized capability result (in-memory only, per the
// decision not to add a new DB table - lost on restart). Populated for EVERY completed query -
// leader, follower, and cache-served alike - so getResult(commandId)
// behaves identically for all three from every existing caller's
// perspective.
const capabilityResults = new Map();

// `params` is optional and new (added for PULL_QUADRON_TOTE, the first
// capability that needs caller-supplied input - which tote, which station).
// Every existing capability's buildPayload() takes zero arguments and
// simply ignores whatever is passed to it, so passing `params: undefined`
// (the default, from every pre-existing call site) is unchanged behavior.
async function requestCapability({ user, capabilityName, params, deps = defaultDeps }) {
  const { queryManager, registry } = deps;

  const capability = registry.getCapability(capabilityName);
  if (!capability) {
    return { ok: false, code: 400, reason: `Unsupported capability: ${capabilityName}` };
  }

  if (!capability.allowedRoles.includes(user.role)) {
    return { ok: false, code: 403, reason: "Your role is not permitted to use this capability" };
  }

  const query = await queryManager.createQuery({
    userId: user.id,
    operation: capabilityName,
    parameters: params || {},
  });

  runQuery(query.query_id, capability, params, deps, { user }).catch(() => {
    /* runQuery persists its own terminal status on every path - nothing further needed here */
  });

  return { ok: true, query: await queryManager.getQuery(query.query_id) };
}

// Top-level per-query orchestration - decides cache/follow/lead for
// read-only capabilities; write capabilities always dispatch fresh,
// unchanged from before this file's coalescing/caching support existed.
async function runQuery(commandId, capability, params, deps, ctx = {}) {
  const { queryManager, coalescer } = deps;

  if (!capability.readOnly) {
    return dispatchAsLeader(commandId, capability, params, deps, ctx);
  }

  const key = coalescer.buildKey(capability.name, params);

  const cached = coalescer.getCached(key);
  if (cached) {
    await queryManager.markRunning(commandId);
    return finalizeWithResult(commandId, capability, cached, deps);
  }

  const leaderPromise = coalescer.getInFlight(key);
  if (leaderPromise) {
    return followLeader(commandId, capability, leaderPromise, deps);
  }

  return leadDispatch(commandId, capability, params, key, deps, ctx);
}

// This commandId's own query WAS the one that triggers the real
// dispatch - either because the capability is a write (never coalesced) or
// because no identical read-only request was already in flight. Registers
// its own cancellable job exactly as before - cancelling THIS commandId is
// what actually aborts the real dispatch (and, for a coalesced read, every
// follower currently waiting on it).
async function dispatchAsLeader(commandId, capability, params, deps, ctx = {}) {
  const { queryManager } = deps;
  const controller = new AbortController();
  const job = queryManager.registerJob(commandId, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(capability.timeoutMs)]);

  try {
    const result = await dispatchDirectly(commandId, capability, params, signal, ctx.user, deps);
    // Awaited (not `return`ed) deliberately - a `try { return somePromise() } finally {...}`
    // runs the finally block as soon as somePromise() is CALLED, not once it
    // settles, so `unregisterJob` below would fire before the terminal
    // status (completeQuery/failQuery/etc.) actually finished writing -
    // exactly the race that produced spurious "Backend restarted before
    // this query finished" failures (reconcileStale() sees the query still
    // RUNNING with no registered job, mid-write, and wrongly force-fails
    // it). Awaiting here first keeps unregisterJob strictly after.
    await finalizeWithResult(commandId, capability, result, deps);
  } catch (e) {
    await finalizeWithError(commandId, capability, e, job, deps);
  } finally {
    queryManager.unregisterJob(commandId);
  }
}

// Wraps dispatchAsLeader's own dispatch in the coalescer's in-flight
// tracking (so concurrent identical requests can find and join it) and, on
// success, the short-TTL result cache (so a later non-overlapping request
// can skip the real request entirely). Always clears the in-flight
// entry when done, success or failure - a settled dispatch is never "in
// flight". `job` is kept in this outer scope (not just inside the inner
// dispatch) specifically so the catch block below can ask the REAL
// registered job whether THIS commandId was the one cancelled, rather than
// guessing from the error alone.
async function leadDispatch(commandId, capability, params, key, deps, ctx = {}) {
  const { queryManager, coalescer } = deps;
  const controller = new AbortController();
  const job = queryManager.registerJob(commandId, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(capability.timeoutMs)]);

  const dispatchPromise = dispatchDirectly(commandId, capability, params, signal, ctx.user, deps);
  const promise = dispatchPromise.then((result) => {
    coalescer.setCached(key, result);
    return result;
  });
  coalescer.setInFlight(key, promise);

  try {
    const result = await promise;
    // Awaited, not returned - see dispatchAsLeader's comment on the exact
    // same finally-runs-before-the-promise-settles race this avoids.
    await finalizeWithResult(commandId, capability, result, deps);
  } catch (e) {
    await finalizeWithError(commandId, capability, e, job, deps);
  } finally {
    coalescer.clearInFlight(key);
    queryManager.unregisterJob(commandId);
  }
}

// This commandId's own query did NOT trigger a dispatch - it is waiting on
// someone else's (the leader's) in-flight request for the exact same
// capability+params. Still gets its own cancellable job so an operator can
// cancel THIS query specifically without affecting the leader or any other
// follower - cancelling here only detaches this one query (finalizes it as
// CANCELLED) and never aborts the shared request, since the
// shared work may still be wanted elsewhere. If the LEADER's own dispatch
// fails/times out/gets cancelled instead, every follower honestly reflects
// that same real outcome - never a fabricated success.
async function followLeader(commandId, capability, leaderPromise, deps) {
  const { queryManager } = deps;
  const controller = new AbortController();
  const job = queryManager.registerJob(commandId, controller);
  await queryManager.markRunning(commandId); // genuinely in progress - being served by the coalesced leader, not queued for a slot of its own

  const detachSignal = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(Object.assign(new Error("Detached"), { name: "AbortError" })), { once: true });
  });

  try {
    const result = await Promise.race([leaderPromise, detachSignal]);
    // Awaited, not returned - see dispatchAsLeader's comment on the exact
    // same finally-runs-before-the-promise-settles race this avoids.
    await finalizeWithResult(commandId, capability, result, deps);
  } catch (e) {
    if (controller.signal.aborted) {
      // This follower was individually cancelled - finalize only itself.
      await finalizeWithError(commandId, capability, Object.assign(new Error("Cancelled"), { name: "AbortError" }), job, deps);
    } else {
      // The leader's own dispatch failed/timed out/was cancelled by ITS
      // caller - reflect that SAME real outcome here too: CANCELLED if the
      // leader was genuinely cancelled (an AbortError - regardless of who
      // triggered it, since this follower's own job was never itself
      // aborted, only the shared work it depended on), TIMEOUT only if the
      // leader genuinely timed out (a TimeoutError), FAILED for anything
      // else (handled by finalizeWithError's own final else branch) - never
      // a fabricated success.
      await finalizeWithError(commandId, capability, e, { wasCancelledByUser: () => e.name === "AbortError" }, deps);
    }
  } finally {
    queryManager.unregisterJob(commandId);
    leaderPromise.catch(() => {}); // this follower is done with it either way - never leave a second unhandled rejection listener behind
  }
}

// Performs the real request in this process via capability.directExecute()
// (the service's shared login is handled inside directAuth/). Honors
// `signal`: it is passed into directExecute() so a genuinely in-flight HTTP
// request is aborted for real on cancellation/timeout, not just abandoned,
// and the TIMEOUT-vs-CANCELLED distinction (signal.reason.name ===
// "TimeoutError") feeds finalizeWithError.
async function dispatchDirectly(commandId, capability, params, signal, user, deps) {
  if (typeof capability.directExecute !== "function") {
    throw new Error(`Capability ${capability.name} has no directExecute()`);
  }
  const { queryManager, auditLog } = deps;
  // buildPayload() (not the caller's raw params) is what actually derives
  // real values like quadronOrigin/instanceCode from config. Skipping this
  // and passing raw params straight to directExecute() is what caused the
  // first live test to fail with "Failed to parse URL from undefined/...":
  // most callers (e.g. classificationEngine.js's fetchSource) never pass
  // params at all for this capability, relying entirely on buildPayload().
  const payload = capability.buildPayload(params);

  let resolveResult, rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  resultPromise.catch(() => {});

  const onAbort = () => {
    const isTimeout = signal.reason && signal.reason.name === "TimeoutError";
    rejectResult(Object.assign(new Error("Aborted"), { name: isTimeout ? "TimeoutError" : "AbortError" }));
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    await queryManager.markRunning(commandId);
    await auditLog.record(null, `${capability.auditAction}_REQUESTED`, { commandId, capability: capability.name, direct: true });

    capability.directExecute(user.id, payload, signal).then(resolveResult, rejectResult);

    const result = await resultPromise;
    const validation = capability.validateResult(result);
    if (!validation.ok) throw new Error(`Direct execution result failed validation: ${validation.reason}`);
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

// Both finalize functions below assume markRunning(commandId) has ALREADY
// been called earlier on this same commandId's own path (dispatchDirectly
// once actually dispatched, followLeader immediately, or the cache-hit
// branch in runQuery) - never called again here. Calling it again after a
// query may already be terminal would incorrectly flip it back to RUNNING
// (queryManagerMysql.js's markRunning() has no terminal-state guard of its
// own - it's meant to be called exactly once, before completion, by
// design).
async function finalizeWithResult(commandId, capability, result, deps) {
  const { queryManager, auditLog } = deps;
  capabilityResults.set(commandId, result);
  await queryManager.completeQuery(commandId);
  await auditLog.record(null, `${capability.auditAction}_COMPLETED`, { commandId });
}

async function finalizeWithError(commandId, capability, e, job, deps) {
  const { queryManager, auditLog } = deps;
  if (e.name === "AbortError" || e.name === "TimeoutError") {
    if (job.wasCancelledByUser()) {
      await queryManager.finalizeCancelled(commandId);
      await auditLog.record(null, `${capability.auditAction}_CANCELLED`, { commandId });
    } else {
      await queryManager.timeoutQuery(commandId);
      await auditLog.record(null, `${capability.auditAction}_TIMEOUT`, { commandId });
    }
  } else {
    await queryManager.failQuery(commandId, e.message || String(e));
    await auditLog.record(null, `${capability.auditAction}_FAILED`, { commandId, error: e.message });
  }
}

function getResult(commandId) {
  return capabilityResults.get(commandId) || null;
}

module.exports = { requestCapability, getResult };
