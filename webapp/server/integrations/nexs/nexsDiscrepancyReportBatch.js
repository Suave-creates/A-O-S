// Query definition for GET_NEXS_DISCREPANCY_REPORT_BATCH - the NexS leg of
// the CNG Inv Validator's three-way reconciliation (see
// server/features/cng-validator/cngValidator.js). Ported from the legacy extension's own CNG
// validator (background/cng-validator.js's cngFetchNexsPartition()): one
// GET per exact (facility, base tote, partition) location against NexS's
// fetchDiscrepancyReport endpoint, reading `data.imsCount`. Modeled on
// GET_NEXS_BLOCKED_INVENTORY_BATCH's own shape (N per-item lookups under
// ONE Query Manager row, bounded concurrency, per-item failure isolation -
// see runtime/background/capabilities.js's executeGetNexsDiscrepancyReportBatch).

const { TOTE_ID_REGEX } = require("../quadron/pullQuadronTote");

// items: [{base, part}] - base is a validated tote id, part a positive
// integer partition number (from the "-N" suffix, already split by the
// caller - this capability never parses a combined "BASE-N" string itself).
function buildPayload(nexsOrigin, params) {
  const { items, facilityCode } = params || {};
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("GET_NEXS_DISCREPANCY_REPORT_BATCH requires a non-empty items array");
  }
  for (const item of items) {
    if (!item || typeof item.base !== "string" || !TOTE_ID_REGEX.test(item.base)) {
      throw new Error(`GET_NEXS_DISCREPANCY_REPORT_BATCH: invalid base tote id: ${item && item.base}`);
    }
    if (!Number.isInteger(item.part) || item.part < 1) {
      throw new Error(`GET_NEXS_DISCREPANCY_REPORT_BATCH: invalid partition number for ${item.base}: ${item && item.part}`);
    }
  }
  return {
    nexsOrigin,
    items: items.map((i) => ({ base: i.base, part: i.part })),
    facilityCode: facilityCode || "NXS1",
  };
}

function validateResult(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "result must be an object" };
  if (!Array.isArray(result.results)) return { ok: false, reason: "result.results must be an array" };
  for (const r of result.results) {
    if (!r || typeof r !== "object" || typeof r.base !== "string" || !r.base) {
      return { ok: false, reason: "each result entry must have a non-empty string base" };
    }
    if (!Number.isInteger(r.part)) {
      return { ok: false, reason: `result entry for ${r.base} must have an integer part` };
    }
    if (r.status !== "ok" && r.status !== "failed") {
      return { ok: false, reason: `result entry for ${r.base}_PR${r.part} has an invalid status "${r.status}"` };
    }
    if (r.imsCount != null && typeof r.imsCount !== "number") {
      return { ok: false, reason: `result entry for ${r.base}_PR${r.part} has a non-numeric imsCount` };
    }
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult };
