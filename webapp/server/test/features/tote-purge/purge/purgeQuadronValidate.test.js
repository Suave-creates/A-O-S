// Unit tests for server/features/tote-purge/purge/purgeQuadronValidate.js - pure, no I/O,
// no network anywhere in this file. `quadronRows` is always a hand-built
// fixture shaped exactly like the EXISTING GET_QUADRON_INVENTORY
// capability's own normalized output.

const test = require("node:test");
const assert = require("node:assert/strict");
const { purgePartitionNum, buildQuadronIndexForPurge, validateCandidate, validateAllCandidates } = require("../../../../features/tote-purge/purge/purgeQuadronValidate");

function candidate(overrides) {
  return { toteId: "TS0000000001", pid: "1", partition: "PR1", inventoryCount: 3, ...overrides };
}

test("purgePartitionNum parses PR-prefixed and bare-suffix forms, never the trailing digits of a bare tote id", () => {
  assert.equal(purgePartitionNum("PR1"), 1);
  assert.equal(purgePartitionNum("_PR2"), 2);
  assert.equal(purgePartitionNum("TL0000003490-1"), 1);
  assert.equal(purgePartitionNum("3"), 3);
  assert.equal(purgePartitionNum(""), null);
  assert.equal(purgePartitionNum(null), null);
  assert.equal(purgePartitionNum("TL0000003490"), null, "must NOT extract 3490 from a bare tote id");
});

test("buildQuadronIndexForPurge re-indexes the existing capability's rows by base tote -> SKU -> qty/partition", () => {
  const rows = [{ toteId: "TS0000000001", quadronQty: 5, partitions: [{ part: 1, qty: 2, sku: "1" }, { part: 2, qty: 3, sku: "2" }] }];
  const idx = buildQuadronIndexForPurge(rows);
  assert.equal(idx["TS0000000001"].totalQty, 5);
  assert.equal(idx["TS0000000001"].skuQty["1"], 2);
  assert.equal(idx["TS0000000001"].skuQty["2"], 3);
  assert.equal(idx["TS0000000001"].skuPartition["1"], 1);
  assert.equal(idx["TS0000000001"].skuPartition["2"], 2);
});

test("buildQuadronIndexForPurge sums multiple partition lines for the same SKU in the same tote", () => {
  const rows = [{ toteId: "TS0000000001", quadronQty: 5, partitions: [{ part: 1, qty: 2, sku: "1" }, { part: 3, qty: 3, sku: "1" }] }];
  const idx = buildQuadronIndexForPurge(rows);
  assert.equal(idx["TS0000000001"].skuQty["1"], 5);
});

test("VALIDATED: Quadron quantity matches ASRS quantity and partition matches", () => {
  const qidx = { TS0000000001: { totalQty: 3, skuQty: { 1: 3 }, skuPartition: { 1: 1 } } };
  const v = validateCandidate(candidate(), qidx, 7);
  assert.equal(v.status, "VALIDATED");
});

test("VALIDATED: Quadron quantity matches and ASRS partition is blank (no partition to disagree)", () => {
  const qidx = { TS0000000001: { totalQty: 3, skuQty: { 1: 3 }, skuPartition: { 1: 4 } } };
  const v = validateCandidate(candidate({ partition: "" }), qidx, 7);
  assert.equal(v.status, "VALIDATED");
});

test("MISSING_IN_QUADRON: tote not found in the Quadron index at all", () => {
  const v = validateCandidate(candidate(), {}, 7);
  assert.equal(v.status, "MISSING_IN_QUADRON");
  assert.equal(v.quadronQty, null);
});

test("MISSING_IN_QUADRON: tote found but the SKU/PID is absent from it", () => {
  const qidx = { TS0000000001: { totalQty: 3, skuQty: { 999: 3 }, skuPartition: {} } };
  const v = validateCandidate(candidate(), qidx, 7);
  assert.equal(v.status, "MISSING_IN_QUADRON");
  assert.equal(v.quadronQty, 0);
});

test("EXCEEDS_PURGE_LIMIT: Quadron quantity exceeds the tote-barcode-max limit", () => {
  const qidx = { TS0000000001: { totalQty: 9, skuQty: { 1: 9 }, skuPartition: { 1: 1 } } };
  const v = validateCandidate(candidate(), qidx, 7);
  assert.equal(v.status, "EXCEEDS_PURGE_LIMIT");
  assert.equal(v.quadronQty, 9);
});

test("INVENTORY_MISMATCH: quantities differ (and the limit isn't exceeded)", () => {
  const qidx = { TS0000000001: { totalQty: 2, skuQty: { 1: 2 }, skuPartition: { 1: 1 } } };
  const v = validateCandidate(candidate({ inventoryCount: 3 }), qidx, 7);
  assert.equal(v.status, "INVENTORY_MISMATCH");
});

test("PARTITION_MISMATCH: both sides have a partition and they differ", () => {
  const qidx = { TS0000000001: { totalQty: 3, skuQty: { 1: 3 }, skuPartition: { 1: 2 } } };
  const v = validateCandidate(candidate({ partition: "PR1" }), qidx, 7);
  assert.equal(v.status, "PARTITION_MISMATCH");
});

test("validateAllCandidates: VALIDATION_UNAVAILABLE for every candidate when Quadron itself couldn't be reached - never silently treated as validated", () => {
  const kept = [candidate(), candidate({ toteId: "TS0000000002" })];
  validateAllCandidates(kept, { quadronOk: false, quadronRows: [] });
  assert.ok(kept.every((c) => c.validationStatus === "VALIDATION_UNAVAILABLE"));
  assert.ok(kept.every((c) => c.quadronValidated === false));
});

test("validateAllCandidates: Quadron's own partition backfills a blank ASRS partition for display", () => {
  const kept = [candidate({ partition: "" })];
  const rows = [{ toteId: "TS0000000001", quadronQty: 3, partitions: [{ part: 4, qty: 3, sku: "1" }] }];
  validateAllCandidates(kept, { quadronOk: true, quadronRows: rows });
  assert.equal(kept[0].partition, "PR4");
  assert.equal(kept[0].validationStatus, "VALIDATED", "a backfilled blank partition must not itself cause a mismatch");
});

test("validateAllCandidates: a non-blank ASRS partition is never overwritten by Quadron's", () => {
  const kept = [candidate({ partition: "PR1" })];
  const rows = [{ toteId: "TS0000000001", quadronQty: 3, partitions: [{ part: 1, qty: 3, sku: "1" }] }];
  validateAllCandidates(kept, { quadronOk: true, quadronRows: rows });
  assert.equal(kept[0].partition, "PR1");
});
