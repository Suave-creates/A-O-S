// Query definition for the GET_NEXS_BLOCKED_INVENTORY capability - the
// blocked-inventory lookup the legacy extension's One Click Purge engine
// performs once per unique candidate PID (background/index.js's
// fetchBlockedInv()). The runtime needs a caller-supplied PID (and,
// optionally, a facility code) - there is no fixed dashboard this always
// runs, the same reason PULL_QUADRON_TOTE's buildPayload takes `params`.
//
// This capability's job (like every other capability's validateResult())
// is only to confirm the runtime's result envelope looks like what it's
// supposed to produce - field-name normalization (totalInventory/
// blockedInventory/availableInventory as numbers) happens one layer up, in
// server/integrations/nexs/nexsBlockedInventoryProvider.js, exactly like
// GET_NEXS_ASRS_DUMP's own split between this file and
// asrsDumpNormalizer.js.

function buildPayload(nexsOrigin, params) {
  const { pid, facilityCode } = params || {};
  return { nexsOrigin, pid, facilityCode: facilityCode || "NXS1" };
}

function validateResult(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "result must be an object" };
  if (typeof result.pid !== "string" || !result.pid) return { ok: false, reason: "result.pid must be a non-empty string" };
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return { ok: false, reason: "result.data must be a plain object" };
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult };
