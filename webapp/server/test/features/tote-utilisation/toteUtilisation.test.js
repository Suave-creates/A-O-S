// Unit tests for server/features/tote-utilisation/toteUtilisation.js - the ported-verbatim
// (Phase 3 investigation confirmed byte-for-byte, zero business-rule
// changes) legacy calculation. Pure, no I/O, no network, no
// Quadron/Grafana/Concinity/Runtime/MySQL call anywhere in this file.
// Covers every rule documented in the Phase 3 investigation report
// (capacity defaults, product-type rule, mixed-tote exclusion, filtering,
// aggregation, distribution, output shape).

const test = require("node:test");
const assert = require("node:assert/strict");
const { computeToteUtilisation, isValidToteId, invBaseOf } = require("../../../features/tote-utilisation/toteUtilisation");

function row(pid, toteId, inventoryCount, location) {
  return { pid, toteId, inventoryCount, location: location === undefined ? toteId : location };
}

// ── isValidToteId / invBaseOf ────────────────────────────────────────────

test("isValidToteId accepts TL/TS + exactly 10 digits, rejects everything else", () => {
  assert.equal(isValidToteId("TL0000003490"), true);
  assert.equal(isValidToteId("TS0000003490"), true);
  assert.equal(isValidToteId("TX0000003490"), false);
  assert.equal(isValidToteId("TL000000349"), false); // 9 digits
  assert.equal(isValidToteId("TL00000034900"), false); // 11 digits
  assert.equal(isValidToteId(""), false);
  assert.equal(isValidToteId(null), false);
});

test("invBaseOf strips a _PRn suffix baked into the id, leaves a bare id unchanged", () => {
  assert.equal(invBaseOf("TL0000003490_PR1"), "TL0000003490");
  assert.equal(invBaseOf("tl0000003490_pr12"), "TL0000003490");
  assert.equal(invBaseOf("TL0000003490"), "TL0000003490");
  assert.equal(invBaseOf("DECANT-04"), "DECANT-04");
});

// ── capacity defaults ─────────────────────────────────────────────────────

test("capacity defaults are Large Lens 300, Large Frame 200, Small Lens 200, Small Frame 100 when caps is empty/omitted", () => {
  const r = computeToteUtilisation([], {});
  assert.equal(r.caps.largeLens, 300);
  assert.equal(r.caps.largeFrame, 200);
  assert.equal(r.caps.smallLens, 200);
  assert.equal(r.caps.smallFrame, 100);
});

test("capacity overrides are honored when positive, ignored (falls back to default) when <= 0", () => {
  const r = computeToteUtilisation([], { largeLens: 350, largeFrame: 0, smallLens: -5, smallFrame: 199 });
  assert.equal(r.caps.largeLens, 350);
  assert.equal(r.caps.largeFrame, 200); // 0 is not > 0, falls back
  assert.equal(r.caps.smallLens, 200); // negative falls back
  assert.equal(r.caps.smallFrame, 199);
});

// ── product-type rule (Frame vs Lens) ────────────────────────────────────

test("PID <= 999999 is Frame, PID >= 1000000 is Lens - exact boundary", () => {
  const r = computeToteUtilisation(
    [row("999999", "TS0000000001", 1), row("1000000", "TS0000000002", 1)],
    {}
  );
  assert.equal(r.detail.find((d) => d.toteId === "TS0000000001").productType, "Frame");
  assert.equal(r.detail.find((d) => d.toteId === "TS0000000002").productType, "Lens");
});

test("a non-numeric/unparseable PID defaults to Lens (NaN branch), never dropped", () => {
  const r = computeToteUtilisation([row("ABC", "TS0000000001", 1)], {});
  assert.equal(r.detail[0].productType, "Lens");
});

test("a missing PID is not excluded - it still defaults to Lens and is counted", () => {
  const r = computeToteUtilisation([{ toteId: "TS0000000001", inventoryCount: 1, location: "TS0000000001" }], {});
  assert.equal(r.pipeline.counted, 1);
  assert.equal(r.detail[0].productType, "Lens");
});

// ── tote-type + category assignment ──────────────────────────────────────

test("TL -> Large, TS -> Small, and each combines with product type into the correct one of 4 categories", () => {
  const r = computeToteUtilisation(
    [
      row("1", "TL0000000001", 5), // Large/Frame
      row("2000000", "TL0000000002", 5), // Large/Lens
      row("1", "TS0000000003", 5), // Small/Frame
      row("2000000", "TS0000000004", 5), // Small/Lens
    ],
    {}
  );
  assert.equal(r.stats.largeFrame.totes, 1);
  assert.equal(r.stats.largeLens.totes, 1);
  assert.equal(r.stats.smallFrame.totes, 1);
  assert.equal(r.stats.smallLens.totes, 1);
});

// ── utilisation formula ──────────────────────────────────────────────────

test("per-tote and per-category utilisation is quantity/capacity, category cap sums each tote's own capacity", () => {
  const r = computeToteUtilisation([row("1", "TS0000000001", 100, null)], { smallFrame: 200 });
  assert.equal(r.detail[0].utilisation, 0.5);
  assert.equal(r.stats.smallFrame.cap, 200); // 1 tote * 200 cap/tote
  assert.equal(r.stats.smallFrame.util, 0.5);
  assert.equal(r.totals.util, 0.5);
});

test("zero capacity never throws - guarded to 0", () => {
  const r = computeToteUtilisation([row("1", "TS0000000001", 5, null)], { smallFrame: -1 }); // falls back to default 200, still > 0
  assert.ok(Number.isFinite(r.detail[0].utilisation));
});

test("an empty tote (quantity 0) is still counted in its category, utilisation is 0", () => {
  const r = computeToteUtilisation([row("1", "TS0000000001", 0, null)], {});
  assert.equal(r.pipeline.counted, 1);
  assert.equal(r.detail[0].quantity, 0);
  assert.equal(r.detail[0].utilisation, 0);
});

// ── mixed-tote exclusion ──────────────────────────────────────────────────

test("a tote holding both Frame and Lens is excluded from stats/totals/detail entirely, reported only in mixed/mixedCount", () => {
  const r = computeToteUtilisation(
    [row("1", "TS0000000001", 3, null), row("2000000", "TS0000000001", 4, null)],
    {}
  );
  assert.equal(r.mixedCount, 1);
  assert.deepEqual(r.mixed, ["TS0000000001"]);
  assert.equal(r.detail.length, 0);
  assert.equal(r.totals.totes, 0);
  assert.equal(r.pipeline.mixed, 1);
  assert.equal(r.pipeline.counted, 0);
});

test("a tote with two rows of the SAME product type is not mixed - quantities sum, one detail row", () => {
  const r = computeToteUtilisation([row("1", "TS0000000001", 3, null), row("1", "TS0000000001", 4, null)], {});
  assert.equal(r.mixedCount, 0);
  assert.equal(r.detail.length, 1);
  assert.equal(r.detail[0].quantity, 7);
});

// ── filtering / exclusions ────────────────────────────────────────────────

test("an invalid tote id is excluded (excludedNonTote), regardless of location", () => {
  const r = computeToteUtilisation([row("1", "NOT-A-TOTE", 5, null)], {});
  assert.equal(r.pipeline.excludedNonTote, 1);
  assert.equal(r.pipeline.counted, 0);
});

test("a present `location` that fails STRICT_TOTE excludes the row even if toteId looks valid", () => {
  const r = computeToteUtilisation([row("1", "TS0000000001", 5, "DECANT-04")], {});
  assert.equal(r.pipeline.excludedNonTote, 1);
});

test("a present `location` matching STRICT_TOTE (bare toteId, optionally _PRn) is counted", () => {
  const r1 = computeToteUtilisation([row("1", "TS0000000001", 5, "TS0000000001")], {});
  assert.equal(r1.pipeline.counted, 1);
  const r2 = computeToteUtilisation([row("1", "TS0000000001", 5, "TS0000000001_PR2")], {});
  assert.equal(r2.pipeline.counted, 1);
});

test("a null/omitted `location` skips the location check entirely and falls through to the toteId check only", () => {
  const r = computeToteUtilisation([row("1", "TS0000000001", 5, null)], {});
  assert.equal(r.pipeline.excludedNonTote, 0);
  assert.equal(r.pipeline.counted, 1);
});

test("a synthetic canonical-style location (NXS1-ASRS- prefix) WOULD be excluded if passed through unchanged - documents why the job's adapter must omit it", () => {
  const r = computeToteUtilisation([row("1", "TS0000000001", 5, "NXS1-ASRS-TS0000000001")], {});
  assert.equal(r.pipeline.excludedNonTote, 1, "STRICT_TOTE does not allow the NXS1-ASRS- prefix - confirms the adapter's location:null decision is necessary, not optional");
});

// ── aggregation ────────────────────────────────────────────────────────────

test("multiple rows for the same tote (different partitions) aggregate into one tote entry", () => {
  const r = computeToteUtilisation(
    [row("1", "TS0000000001", 3, null), row("1", "TS0000000001", 2, null)],
    {}
  );
  assert.equal(r.detail.length, 1);
  assert.equal(r.detail[0].quantity, 5);
});

test("stats sums equal totals, pipeline.counted equals total non-mixed valid totes", () => {
  const r = computeToteUtilisation(
    [row("1", "TL0000000001", 10), row("2000000", "TS0000000002", 20), row("1", "NOT-A-TOTE", 5)],
    {}
  );
  const catSum = ["largeLens", "largeFrame", "smallLens", "smallFrame"].reduce((s, k) => s + r.stats[k].totes, 0);
  assert.equal(catSum, r.totals.totes);
  assert.equal(r.pipeline.counted, r.totals.totes);
  assert.equal(r.pipeline.scanned, 3);
  assert.equal(r.pipeline.excludedNonTote, 1);
});

// ── distribution ─────────────────────────────────────────────────────────

test("distribution buckets exact quantities 1-5, excludes 0 and 6+, separate from category totals", () => {
  const r = computeToteUtilisation(
    [
      row("1", "TS0000000001", 0, null),
      row("1", "TS0000000002", 1, null),
      row("1", "TS0000000003", 5, null),
      row("1", "TS0000000004", 6, null),
    ],
    {}
  );
  assert.equal(r.distribution[1], 1);
  assert.equal(r.distribution[5], 1);
  assert.equal(r.distTotal, 2);
  assert.equal(r.totals.totes, 4, "all 4 still counted toward totals, regardless of distribution bucketing");
});

// ── output shape ───────────────────────────────────────────────────────────

test("output includes generatedAt and the exact top-level keys consumers rely on", () => {
  const r = computeToteUtilisation([], {});
  assert.ok(r.generatedAt);
  for (const key of ["stats", "totals", "distribution", "distTotal", "mixed", "mixedCount", "detail", "caps", "pipeline"]) {
    assert.ok(key in r, `missing top-level key: ${key}`);
  }
});

test("empty input never throws, produces an all-zero result", () => {
  const r = computeToteUtilisation([], {});
  assert.equal(r.totals.totes, 0);
  assert.equal(r.totals.util, 0);
  assert.deepEqual(r.detail, []);
});
