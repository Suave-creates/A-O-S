// Query definition for GET_NEXS_BLOCKED_INVENTORY_BATCH - runs N per-PID
// blocked-inventory lookups (the exact same NexS request contract as the
// single-PID GET_NEXS_BLOCKED_INVENTORY capability - see
// nexsBlockedInventory.js) under ONE Query Manager row, so Tote Purge
// scaling to hundreds/thousands of candidate PIDs never creates one Active
// Queries row per PID (see runtime/background/capabilities.js's
// executeGetNexsBlockedInventoryBatch for the actual per-PID fetch logic:
// bounded concurrency, per-PID failure isolation, shared fetch helper with
// the single-PID capability).
//
// This capability's job (like every other capability's validateResult())
// is only to confirm the runtime's result envelope looks like what it's
// supposed to produce - per-PID field normalization into the shape
// purgeClassify.js expects happens one layer up, in
// server/integrations/nexs/nexsBlockedInventoryProvider.js's fetchBlockedInventoryBatch(),
// exactly like the single-PID capability's own split with that file.

function buildPayload(nexsOrigin, params) {
  const { pids, facilityCode } = params || {};
  return { nexsOrigin, pids: Array.isArray(pids) ? pids : [], facilityCode: facilityCode || "NXS1" };
}

function validateResult(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "result must be an object" };
  if (!Array.isArray(result.results)) return { ok: false, reason: "result.results must be an array" };
  for (const r of result.results) {
    if (!r || typeof r !== "object" || typeof r.pid !== "string" || !r.pid) {
      return { ok: false, reason: "each result entry must have a non-empty string pid" };
    }
    if (r.status !== "ok" && r.status !== "failed") {
      return { ok: false, reason: `result entry for pid ${r.pid} has an invalid status "${r.status}"` };
    }
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult };
