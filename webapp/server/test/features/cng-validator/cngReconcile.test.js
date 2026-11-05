// Pure unit tests for server/features/cng-validator/cngReconcile.js - the CNG Inv Validator's
// verdict-computation algorithm. No database, no network, no capability
// dispatch of any kind.

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseContainer, indexQuadronByBase, indexGrafanaByBase, indexNexsByBase, unionPartitionItems, computeRows, focusPartsForBase } = require("../../../features/cng-validator/cngReconcile");

test("parseContainer: splits a well-formed 'BASE-PART' container", () => {
  assert.deepEqual(parseContainer("TS0000018492-6"), { base: "TS0000018492", part: 6 });
});

test("parseContainer: rejects a base that isn't a valid tote id, or a non-numeric part", () => {
  assert.equal(parseContainer("not-a-tote-6"), null);
  assert.equal(parseContainer("TS0000018492-abc"), null);
  assert.equal(parseContainer("TS0000018492"), null, "no '-' at all is malformed");
});

test("indexQuadronByBase: only includes bases the caller asked about, keyed by part -> {qty,sku}", () => {
  const rows = [
    { toteId: "TS0000018492", quadronQty: 15, partitions: [{ part: 1, qty: 10, sku: "SKU1" }, { part: 2, qty: 5, sku: "SKU2" }] },
    { toteId: "TS0000099999", quadronQty: 1, partitions: [{ part: 1, qty: 1, sku: "SKU9" }] }, // not requested - must be excluded
  ];
  const map = indexQuadronByBase(rows, ["TS0000018492"]);
  assert.equal(map.size, 1);
  assert.deepEqual(map.get("TS0000018492").get(1), { qty: 10, sku: "SKU1" });
  assert.deepEqual(map.get("TS0000018492").get(2), { qty: 5, sku: "SKU2" });
  assert.equal(map.get("TS0000099999"), undefined);
});

test("indexGrafanaByBase: parses each container into base/part, ignores malformed rows", () => {
  const rows = [
    { container: "TS0000018492-1", qty: 10 },
    { container: "TS0000018492-2", qty: 5 },
    { container: "not-a-tote-1", qty: 99 }, // malformed - must be silently ignored, not thrown
  ];
  const map = indexGrafanaByBase(rows);
  assert.equal(map.get("TS0000018492").get(1), 10);
  assert.equal(map.get("TS0000018492").get(2), 5);
  assert.equal(map.size, 1);
});

test("indexNexsByBase: a failed item's imsCount is treated as absent (null), never a fabricated 0", () => {
  const results = [
    { base: "TS0000018492", part: 1, status: "ok", imsCount: 7, error: null },
    { base: "TS0000018492", part: 2, status: "failed", imsCount: null, error: "timeout" },
  ];
  const map = indexNexsByBase(results);
  assert.equal(map.get("TS0000018492").get(1), 7);
  assert.equal(map.get("TS0000018492").get(2), null);
});

test("unionPartitionItems: NexS is never used to discover partitions - only Quadron+Grafana's union is queried", () => {
  const quadronByBase = new Map([["TS0000018492", new Map([[1, {}], [3, {}]])]]);
  const grafanaByBase = new Map([["TS0000018492", new Map([[2, 5]])]]);
  const items = unionPartitionItems(["TS0000018492"], quadronByBase, grafanaByBase);
  assert.deepEqual(items, [
    { base: "TS0000018492", part: 1 },
    { base: "TS0000018492", part: 2 },
    { base: "TS0000018492", part: 3 },
  ]);
});

test("unionPartitionItems: a base with no partitions in either source produces no items", () => {
  const items = unionPartitionItems(["TS0000000000"], new Map(), new Map());
  assert.deepEqual(items, []);
});

// ── Focus Mode: fixed per-tote-type partition ceiling, ignores Quadron/Grafana ──

test("focusPartsForBase: TL totes get PR1..PR8, TS totes get PR1..PR20", () => {
  assert.deepEqual(focusPartsForBase("TL0000002607"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(focusPartsForBase("TS0000018492").length, 20);
  assert.deepEqual(focusPartsForBase("TS0000018492").slice(0, 3), [1, 2, 3]);
  assert.equal(focusPartsForBase("TS0000018492")[19], 20);
});

test("focusPartsForBase: an unrecognized prefix yields no partitions rather than throwing", () => {
  assert.deepEqual(focusPartsForBase("XX0000000001"), []);
});

test("unionPartitionItems: focusMode sweeps every possible partition per tote type, ignoring what Quadron/Grafana actually found", () => {
  // Quadron/Grafana are both completely empty for this base - the normal
  // (non-focus) union would be empty and NexS would never be queried.
  const items = unionPartitionItems(["TL0000002607"], new Map(), new Map(), true);
  assert.equal(items.length, 8);
  assert.deepEqual(items[0], { base: "TL0000002607", part: 1 });
  assert.deepEqual(items[7], { base: "TL0000002607", part: 8 });
});

test("unionPartitionItems: focusMode is per-tote-type across a mixed TL/TS list", () => {
  const items = unionPartitionItems(["TL0000002607", "TS0000018492"], new Map(), new Map(), true);
  assert.equal(items.filter((i) => i.base === "TL0000002607").length, 8);
  assert.equal(items.filter((i) => i.base === "TS0000018492").length, 20);
});

test("unionPartitionItems: focusMode defaults to false - existing (non-focus) callers are unaffected", () => {
  const items = unionPartitionItems(["TL0000002607"], new Map(), new Map());
  assert.deepEqual(items, []);
});

// ── computeRows: the 4 verdicts, verified exactly per the legacy algorithm ──

test("computeRows: MATCH - all 3 totals present and equal", () => {
  const quadronByBase = new Map([["TS0000018492", new Map([[1, { qty: 5 }]])]]);
  const grafanaByBase = new Map([["TS0000018492", new Map([[1, 5]])]]);
  const nexsByBase = new Map([["TS0000018492", new Map([[1, 5]])]]);
  const [row] = computeRows(["TS0000018492"], quadronByBase, grafanaByBase, nexsByBase);
  assert.equal(row.verdict, "MATCH");
  assert.equal(row.quadron, 5);
  assert.equal(row.nexs, 5);
  assert.equal(row.grafana, 5);
});

test("computeRows: MISMATCH - all 3 totals present but not all equal", () => {
  const quadronByBase = new Map([["TS0000018492", new Map([[1, { qty: 5 }]])]]);
  const grafanaByBase = new Map([["TS0000018492", new Map([[1, 5]])]]);
  const nexsByBase = new Map([["TS0000018492", new Map([[1, 3]])]]);
  const [row] = computeRows(["TS0000018492"], quadronByBase, grafanaByBase, nexsByBase);
  assert.equal(row.verdict, "MISMATCH");
});

test("computeRows: PARTIAL - exactly 2 of 3 totals present, REGARDLESS of whether they agree (confirmed against the actual legacy algorithm, not its UI copy)", () => {
  const quadronByBase = new Map([["TS0000018492", new Map([[1, { qty: 5 }]])]]);
  const grafanaByBase = new Map([["TS0000018492", new Map([[1, 5]])]]); // agrees with quadron
  const nexsByBase = new Map(); // absent entirely
  const [row] = computeRows(["TS0000018492"], quadronByBase, grafanaByBase, nexsByBase);
  assert.equal(row.verdict, "PARTIAL", "2-of-3 present must be PARTIAL even though the two present values agree - not MATCH");
});

test("computeRows: PARTIAL - exactly 1 of 3 totals present", () => {
  const quadronByBase = new Map([["TS0000018492", new Map([[1, { qty: 5 }]])]]);
  const [row] = computeRows(["TS0000018492"], quadronByBase, new Map(), new Map());
  assert.equal(row.verdict, "PARTIAL");
  assert.equal(row.quadron, 5);
  assert.equal(row.nexs, null);
  assert.equal(row.grafana, null);
});

test("computeRows: MISSING - none of the 3 totals present (no partitions found anywhere)", () => {
  const [row] = computeRows(["TS0000018492"], new Map(), new Map(), new Map());
  assert.equal(row.verdict, "MISSING");
  assert.equal(row.quadron, null);
  assert.equal(row.nexs, null);
  assert.equal(row.grafana, null);
  assert.deepEqual(row.partitions, []);
});

test("computeRows: totals are SUMMED across all partitions, not taken from a single partition", () => {
  const quadronByBase = new Map([["TS0000018492", new Map([[1, { qty: 5 }], [2, { qty: 3 }]])]]);
  const grafanaByBase = new Map([["TS0000018492", new Map([[1, 5], [2, 3]])]]);
  const nexsByBase = new Map([["TS0000018492", new Map([[1, 5], [2, 3]])]]);
  const [row] = computeRows(["TS0000018492"], quadronByBase, grafanaByBase, nexsByBase);
  assert.equal(row.quadron, 8);
  assert.equal(row.nexs, 8);
  assert.equal(row.grafana, 8);
  assert.equal(row.verdict, "MATCH");
});

test("computeRows: per-partition match is 2-of-3-present equality, independent of and not fed into the tote-level verdict", () => {
  const quadronByBase = new Map([["TS0000018492", new Map([[1, { qty: 5 }], [2, { qty: 9 }]])]]);
  const grafanaByBase = new Map([["TS0000018492", new Map([[1, 5], [2, 2]])]]); // partition 2 disagrees
  const nexsByBase = new Map([["TS0000018492", new Map([[1, 5], [2, 9]])]]);
  const [row] = computeRows(["TS0000018492"], quadronByBase, grafanaByBase, nexsByBase);
  assert.equal(row.partitions.find((p) => p.part === 1).match, true);
  assert.equal(row.partitions.find((p) => p.part === 2).match, false);
  // Tote-level totals: quadron 14, nexs 14, grafana 7 - all 3 present, not equal -> MISMATCH
  assert.equal(row.verdict, "MISMATCH");
});

test("computeRows: focusMode surfaces NexS data even when Quadron and Grafana are both completely empty for that tote", () => {
  // Reproduces the exact scenario this feature exists for: a tote with zero
  // rows in Quadron/Grafana (normal mode -> MISSING, NexS never queried)
  // but real data sitting in NexS at a specific partition location.
  const nexsByBase = new Map([["TL0000002995", new Map([[3, 12]])]]);
  const [row] = computeRows(["TL0000002995"], new Map(), new Map(), nexsByBase, true);
  assert.equal(row.partitions.length, 8, "every TL partition PR1-8 must be present, not just the one NexS had data for");
  assert.equal(row.nexs, 12);
  assert.equal(row.quadron, null);
  assert.equal(row.grafana, null);
  assert.equal(row.verdict, "PARTIAL", "1-of-3 present (NexS only)");
  const p3 = row.partitions.find((p) => p.part === 3);
  assert.equal(p3.nexs, 12);
  assert.equal(p3.quadron, null);
  assert.equal(p3.grafana, null);
});

test("computeRows: focusMode defaults to false - existing non-focus behavior is unchanged", () => {
  const [row] = computeRows(["TL0000002995"], new Map(), new Map(), new Map());
  assert.deepEqual(row.partitions, []);
  assert.equal(row.verdict, "MISSING");
});

test("computeRows: preserves the caller's input order across multiple bases", () => {
  const rows = computeRows(["TS0000000002", "TS0000000001"], new Map(), new Map(), new Map());
  assert.deepEqual(rows.map((r) => r.base), ["TS0000000002", "TS0000000001"]);
});
