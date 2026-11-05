// Query definition for the PULL_QUADRON_TOTE capability (Phase 4) - the
// first MUTATING capability. Unlike every capability before this, the
// runtime needs caller-supplied parameters (which tote, which station) -
// there is no fixed SQL/dashboard this always runs. capabilityManager.js
// was extended, backward-compatibly, to thread an optional `params`
// argument through to buildPayload() for exactly this reason.
//
// Executed server-side by pullQuadronToteDirect.js with the shared Concinity
// login; the token never leaves the backend process.

const TOTE_ID_REGEX = /^(TL|TS)[0-9]{10}$/;

function buildPayload(quadronOrigin, params) {
  const { toteId, zone, instanceCode } = params || {};
  return { quadronOrigin, toteId, zone, instanceCode };
}

// The only four real outcomes classifyQuadronPullResult() (runtime side)
// can ever produce - anything else fails validation rather than being
// passed through, which also means an accidentally-included extra field
// (e.g. a token) is rejected, not silently forwarded.
const ALLOWED_VERDICTS = new Set(["INSERTED", "ALREADY_QUEUED", "RELEASED", "NOT_AVAILABLE"]);
const ALLOWED_RESULT_KEYS = new Set(["verdict", "rawMessage", "toteId", "zone", "instanceCode", "completedAt"]);

function validateResult(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "result must be an object" };
  if (!ALLOWED_VERDICTS.has(result.verdict)) return { ok: false, reason: `unexpected verdict: ${result.verdict}` };
  if (typeof result.toteId !== "string" || !TOTE_ID_REGEX.test(result.toteId)) {
    return { ok: false, reason: "result.toteId must be a valid tote id" };
  }
  for (const key of Object.keys(result)) {
    if (!ALLOWED_RESULT_KEYS.has(key)) return { ok: false, reason: `unexpected field in result: ${key}` };
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult, TOTE_ID_REGEX };
