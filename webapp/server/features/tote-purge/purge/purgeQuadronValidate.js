// Pure Quadron-validation stage of the Tote Purge engine - ported
// faithfully from background/index.js's buildQuadronIndex()/purgeValidate()
// (runPurgeGenerate() step 6). No I/O, no network - `quadronRows` is
// already-fetched data from the EXISTING GET_QUADRON_INVENTORY
// capability's own normalized output (runtime/background/capabilities.js's
// executeGetQuadronInventory: one row per base tote id, `quadronQty`
// summed across all its SKUs, `partitions: [{part, qty, sku}]` per line) -
// this file only re-indexes that already-fetched data by SKU, it never
// fetches Quadron itself (see server/features/tote-purge/purgeEngine.js for the
// orchestration that calls the existing capability via
// server/integrations/capabilities/capabilitySource.js - no second Quadron fetch implementation).

const PURGE_TOTE_MAX = 7; // fallback tote-barcode-max if the caller doesn't supply one

// Partition number from "PR1" | "_PR1" | "TL0000003490-1" | "1" -> integer,
// or null. Only matches genuine partition tokens - NOT the trailing digits
// of a bare tote id like "TL0000003490" (which must return null, never
// 3490). Ported verbatim from background/index.js's purgePartitionNum().
function purgePartitionNum(p) {
  const s = String(p || "").trim();
  if (!s) return null;
  const m = s.match(/_PR(\d+)/i) || s.match(/(?:^|[^0-9])PR(\d+)/i) || s.match(/-(\d+)\s*$/) || s.match(/^(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

// buildQuadronIndexForPurge(quadronRows) -> { [baseToteId]: { totalQty, skuQty:{sku:qty}, skuPartition:{sku:part} } }
//
// Reconstructs the same per-tote/per-SKU shape legacy's own
// buildQuadronIndex() built directly from the raw Concinity payload - here
// built from the existing capability's already-normalized `partitions`
// array instead, since that already carries {part, qty, sku} per line.
function buildQuadronIndexForPurge(quadronRows) {
  const idx = Object.create(null);
  for (const r of quadronRows || []) {
    const base = r && r.toteId;
    if (!base) continue;
    const entry = { totalQty: Number(r.quadronQty) || 0, skuQty: Object.create(null), skuPartition: Object.create(null) };
    for (const p of (r && r.partitions) || []) {
      const sku = String((p && p.sku) || "").trim();
      if (!sku) continue;
      const qty = Number(p.qty) || 0;
      entry.skuQty[sku] = (entry.skuQty[sku] || 0) + qty;
      if (entry.skuPartition[sku] == null && p.part != null) entry.skuPartition[sku] = p.part;
    }
    idx[base] = entry;
  }
  return idx;
}

// Validate one candidate against the Quadron index -> {status, quadronQty, quadronPartition}
function validateCandidate(c, qidx, toteBarcodeMax) {
  const limit = toteBarcodeMax != null && !isNaN(Number(toteBarcodeMax)) ? Number(toteBarcodeMax) : PURGE_TOTE_MAX;
  const q = qidx[c.toteId];
  if (!q) return { status: "MISSING_IN_QUADRON", quadronQty: null, quadronPartition: null };
  const qQty = q.skuQty[c.pid];
  if (qQty == null) return { status: "MISSING_IN_QUADRON", quadronQty: 0, quadronPartition: null }; // tote present, SKU absent
  const qPart = q.skuPartition[c.pid] != null ? q.skuPartition[c.pid] : null;
  if (qQty > limit) return { status: "EXCEEDS_PURGE_LIMIT", quadronQty: qQty, quadronPartition: qPart };
  if (qQty !== c.inventoryCount) return { status: "INVENTORY_MISMATCH", quadronQty: qQty, quadronPartition: qPart };
  const cPart = purgePartitionNum(c.partition);
  if (qPart != null && cPart != null && qPart !== cPart) return { status: "PARTITION_MISMATCH", quadronQty: qQty, quadronPartition: qPart };
  return { status: "VALIDATED", quadronQty: qQty, quadronPartition: qPart };
}

// validateAllCandidates(kept, { quadronOk, quadronRows, toteBarcodeMax }) -> kept (mutated in place, same array)
//
// If Quadron itself could not be reached, EVERY candidate is explicitly
// flagged VALIDATION_UNAVAILABLE - never silently treated as validated.
// Quadron's own partition backfills a blank ASRS partition for display
// (Quadron treated as authoritative when ASRS leaves it blank) - matches
// legacy exactly.
function validateAllCandidates(kept, { quadronOk, quadronRows, toteBarcodeMax } = {}) {
  const qidx = quadronOk ? buildQuadronIndexForPurge(quadronRows) : null;

  for (const c of kept) {
    if (!quadronOk) {
      c.quadronValidated = false;
      c.validationStatus = "VALIDATION_UNAVAILABLE";
      c.quadronQty = null;
      c.quadronPartition = null;
      c.notes = ["Quadron API unavailable"];
      continue;
    }
    const v = validateCandidate(c, qidx, toteBarcodeMax);
    c.validationStatus = v.status;
    c.quadronQty = v.quadronQty;
    c.quadronPartition = v.quadronPartition;
    c.quadronValidated = v.status === "VALIDATED";
    c.notes = [];
    if ((!c.partition || c.partition === "") && v.quadronPartition != null) c.partition = "PR" + v.quadronPartition;
  }
  return kept;
}

module.exports = { PURGE_TOTE_MAX, purgePartitionNum, buildQuadronIndexForPurge, validateCandidate, validateAllCandidates };
