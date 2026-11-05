// Shared single-tote-pull dispatch logic used by the Tote Pull Engine's
// sequential loop (server/features/tote-puller/totePullEngine.js). Deliberately does NOT
// touch runtime/background/capabilities.js, server/integrations/capabilities/registry.js,
// or server/integrations/quadron/pullQuadronTote.js - PULL_QUADRON_TOTE itself is
// unmodified. This file only orchestrates calls to the existing,
// already-proven capabilityManager.requestCapability(), the same function
// the standalone /queries/pull-quadron-tote route already uses.

const queryManager = require("../../platform/queries/queryManager");
const capabilityManager = require("../capabilities/capabilityManager");
const quadronPullLock = require("./quadronPullLock");
const { TOTE_ID_REGEX } = require("./pullQuadronTote");
const { waitForTerminal, TERMINAL_STATUSES } = require("../../platform/queries/queryPoll");

// Validates exactly like the standalone route does (never trusts a caller
// blindly, including the Engine itself), checks the same duplicate-in-flight
// guard, then acquires the GLOBAL single-flight lock and holds it for the
// full duration - dispatch through terminal status - before dispatching.
// This is the blocking, queue-and-wait shape: correct for a background
// sequential loop, wrong for an interactive HTTP handler (see
// queries.routes.js for how the standalone route uses the lock instead,
// without blocking its own HTTP response).
async function pullOneTote({ user, toteId, zone, instanceCode, sessionId }) {
  if (typeof toteId !== "string" || !TOTE_ID_REGEX.test(toteId)) {
    return { ok: false, code: 400, reason: `toteId must match ${TOTE_ID_REGEX}` };
  }
  if (typeof zone !== "string" || !zone.trim()) {
    return { ok: false, code: 400, reason: "zone is required" };
  }
  if (typeof instanceCode !== "string" || !instanceCode.trim()) {
    return { ok: false, code: 400, reason: "instanceCode is required" };
  }

  const inFlight = await queryManager.findActiveByParam("PULL_QUADRON_TOTE", "toteId", toteId);
  if (inFlight) {
    return { ok: false, code: 409, reason: `Tote ${toteId} already has a pull in progress (${inFlight.query_id})` };
  }

  return quadronPullLock.withPullLock(async () => {
    const params = { toteId, zone: zone.trim(), instanceCode: instanceCode.trim() };
    if (sessionId) params.sessionId = sessionId; // correlation only - buildPayload() ignores unknown fields
    const dispatch = await capabilityManager.requestCapability({
      user,
      capabilityName: "PULL_QUADRON_TOTE",
      params,
    });
    if (!dispatch.ok) return dispatch; // {ok:false, code, reason} - never even started executing

    const query = await waitForTerminal(dispatch.query.query_id);
    const result = query.status === "COMPLETED" ? capabilityManager.getResult(query.query_id) : null;
    return { ok: true, query, result };
  });
}

module.exports = { pullOneTote, waitForTerminal, TERMINAL_STATUSES };
