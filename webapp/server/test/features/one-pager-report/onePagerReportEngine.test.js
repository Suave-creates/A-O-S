// Unit tests for server/features/one-pager-report/onePagerReportEngine.js's pure logic
// (summarizeOutsideTote - the age-bucketing that has no live equivalent
// anywhere else in this app to compare against). generate()/getCurrentReport()
// are integration-shaped (real queryManager/db/sub-engines) and are covered
// by the manual live test, not here - mirrors classificationEngine.js's own
// test split (classification.js's pure algorithm gets a dedicated unit
// test file; refresh() does not).

const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeOutsideTote, deriveTotesInAsrs, runSection, sumHoursRow, combineAsrsProductionTotal, pickingOverallRow, DEFAULT_UTILISATION_CAPS } = require("../../../features/one-pager-report/onePagerReportEngine");

// A raw IST-digit timestamp string `hoursAgo` hours before `now` (ms) -
// the inverse of istTimestamp.js's own parseIstRawDigitsToUtcMs().
function istTimestampHoursAgo(now, hoursAgo) {
  const targetUtcMs = now - hoursAgo * 3600000;
  const istMs = targetUtcMs + 5.5 * 3600000;
  const d = new Date(istMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const NOW = Date.parse("2026-09-07T12:00:00Z");

test("summarizeOutsideTote(): a row updated 20h ago (Outside Tote) counts in h12to24", () => {
  const rows = [{ tote: "TL0000000001", status: "Outside Tote", updated: istTimestampHoursAgo(NOW, 20) }];
  const result = summarizeOutsideTote(rows, NOW);
  assert.equal(result.h12to24, 1);
  assert.equal(result.h24plus, 0);
  assert.equal(result.total, 1);
  assert.deepEqual(result.totes.h12to24, ["TL0000000001"]);
});

test("summarizeOutsideTote(): a row updated 30h ago (Outside Tote) counts in h24plus", () => {
  const rows = [{ tote: "TL0000000001", status: "Outside Tote", updated: istTimestampHoursAgo(NOW, 30) }];
  const result = summarizeOutsideTote(rows, NOW);
  assert.equal(result.h12to24, 0);
  assert.equal(result.h24plus, 1);
});

test("summarizeOutsideTote(): a row updated less than 12h ago is not counted in either bucket", () => {
  const rows = [{ tote: "TL0000000001", status: "Outside Tote", updated: istTimestampHoursAgo(NOW, 5) }];
  const result = summarizeOutsideTote(rows, NOW);
  assert.equal(result.total, 0);
});

test("summarizeOutsideTote(): status other than 'Outside Tote' (e.g. Bad Tracker) is never counted, per explicit instruction", () => {
  const rows = [
    { tote: "TL0000000001", status: "Bad Tracker", updated: istTimestampHoursAgo(NOW, 30) },
    { tote: "TL0000000002", status: "Virtual Tote", updated: istTimestampHoursAgo(NOW, 30) },
  ];
  const result = summarizeOutsideTote(rows, NOW);
  assert.equal(result.total, 0);
});

test("summarizeOutsideTote(): an unparseable/missing updated timestamp is skipped, never guessed as a bucket", () => {
  const rows = [
    { tote: "TL0000000001", status: "Outside Tote", updated: null },
    { tote: "TL0000000002", status: "Outside Tote", updated: "" },
    { tote: "TL0000000003", status: "Outside Tote" },
  ];
  const result = summarizeOutsideTote(rows, NOW);
  assert.equal(result.total, 0);
});

test("summarizeOutsideTote(): handles a mix - buckets and total are all consistent", () => {
  const rows = [
    { tote: "A", status: "Outside Tote", updated: istTimestampHoursAgo(NOW, 15) },
    { tote: "B", status: "Outside Tote", updated: istTimestampHoursAgo(NOW, 40) },
    { tote: "C", status: "Outside Tote", updated: istTimestampHoursAgo(NOW, 13) },
    { tote: "D", status: "Bad Tracker", updated: istTimestampHoursAgo(NOW, 40) },
  ];
  const result = summarizeOutsideTote(rows, NOW);
  assert.equal(result.h12to24, 2);
  assert.equal(result.h24plus, 1);
  assert.equal(result.total, 3);
});

test("summarizeOutsideTote(): empty/missing rows array returns all zeros, never throws", () => {
  assert.deepEqual(summarizeOutsideTote(undefined, NOW), { h12to24: 0, h24plus: 0, total: 0, totes: { h12to24: [], h24plus: [] } });
  assert.deepEqual(summarizeOutsideTote([], NOW), { h12to24: 0, h24plus: 0, total: 0, totes: { h12to24: [], h24plus: [] } });
});

test("deriveTotesInAsrs(): maps stats.large/smallLens/Frame.totes into the Frame/Lens x Large/Small breakdown", () => {
  const stats = {
    largeFrame: { totes: 18077 },
    largeLens: { totes: 6619 },
    smallFrame: { totes: 4 },
    smallLens: { totes: 18683 },
  };
  const result = deriveTotesInAsrs(stats);
  assert.deepEqual(result, {
    large: { frame: 18077, lens: 6619, total: 24696 },
    small: { frame: 4, lens: 18683, total: 18687 },
    total: { frame: 18081, lens: 25302, total: 43383 },
  });
});

test("deriveTotesInAsrs(): returns null when stats is missing, never throws", () => {
  assert.equal(deriveTotesInAsrs(null), null);
  assert.equal(deriveTotesInAsrs(undefined), null);
});

test("deriveTotesInAsrs(): a missing category defaults to 0, never NaN", () => {
  const result = deriveTotesInAsrs({ largeFrame: { totes: 10 } });
  assert.deepEqual(result, {
    large: { frame: 10, lens: 0, total: 10 },
    small: { frame: 0, lens: 0, total: 0 },
    total: { frame: 10, lens: 0, total: 10 },
  });
});

test("runSection(): a successful fetch resolves {ok:true, data}", async () => {
  const result = await runSection(async () => ({ rows: [1, 2, 3] }));
  assert.deepEqual(result, { ok: true, data: { rows: [1, 2, 3] } });
});

test("runSection(): a rejected fetch resolves {ok:false, reason} - never rejects, never throws (the core of generate()'s per-section independence)", async () => {
  const result = await runSection(async () => {
    throw new Error("No online, approved runtime currently advertises this capability");
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "No online, approved runtime currently advertises this capability");
});

test("DEFAULT_UTILISATION_CAPS matches the operator's explicit instruction (TL Lens 300 / TL Frame 200 / TS Lens 200 / TS Frame 100) - deliberately different from utilisation.js's own defaults", () => {
  assert.deepEqual(DEFAULT_UTILISATION_CAPS, { largeLens: 300, largeFrame: 200, smallLens: 200, smallFrame: 100 });
});

test("combineAsrsProductionTotal(): sums the JIT and NJIT rows per shift, plus their own grand totals, matching the source extension's own Departments/ASRS Total roll-up", () => {
  const jit = { A: 40, B: 33, C: 12, Total: 85 };
  const njit = { A: 120, B: 95, C: 60, Total: 275 };
  assert.deepEqual(combineAsrsProductionTotal(jit, njit), { A: 160, B: 128, C: 72, Total: 360 });
});

test("combineAsrsProductionTotal(): an all-zero day combines to all zeros, never throws", () => {
  const zero = { A: 0, B: 0, C: 0, Total: 0 };
  assert.deepEqual(combineAsrsProductionTotal(zero, zero), zero);
});

// Real operator-supplied reference numbers (2026-09-10) - exact values from
// the reference table the operator gave, used verbatim as a regression
// fixture rather than invented numbers.
const JIT_HOURS = {
  A: [87, 228, 261, 207, 179, 155, 253, 167],
  B: [207, 213, 190, 130, 173, 101, 151, 105],
  C: [142, 167, 163, 178, 405, 457, 372, 129],
};
const NJIT_HOURS = {
  A: [897, 1150, 1204, 1144, 1230, 1189, 1211, 1067],
  B: [876, 715, 833, 958, 1026, 945, 1080, 929],
  C: [893, 755, 915, 694, 1280, 1945, 1679, 1206],
};

test("sumHoursRow(): sums each shift's own 8 hours into {A,B,C,Total} - matches the operator's own reference row totals", () => {
  assert.deepEqual(sumHoursRow(JIT_HOURS), { A: 1537, B: 1270, C: 2013, Total: 4820 });
  assert.deepEqual(sumHoursRow(NJIT_HOURS), { A: 9092, B: 7362, C: 9367, Total: 25821 });
});

test("pickingOverallRow(): sums all SIX shift-rows (both departments x all three shifts) per hour column, not matched by shift - matches the operator's own 'Picking / Overall' reference row exactly", () => {
  assert.deepEqual(pickingOverallRow(JIT_HOURS, NJIT_HOURS), {
    hours: [3102, 3228, 3566, 3311, 4293, 4792, 4746, 3603],
    total: 30641,
  });
});

test("runSection: a transient failure is retried once and the section recovers (no 'Data unavailable')", async () => {
  const { runSection } = require("../../../features/one-pager-report/onePagerReportEngine");
  let calls = 0;
  const r = await runSection(async () => { if (++calls === 1) throw new Error("Grafana HTTP 503"); return { ok: 1 }; }, { retryDelayMs: 1 });
  assert.deepEqual(r, { ok: true, data: { ok: 1 } });
  assert.equal(calls, 2);
});

test("runSection: still failing after the retry reports the real reason", async () => {
  const { runSection } = require("../../../features/one-pager-report/onePagerReportEngine");
  let calls = 0;
  const r = await runSection(async () => { calls++; throw new Error("boom"); }, { retryDelayMs: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "boom");
  assert.equal(calls, 2);
});

test("combined ASRS Production adds JIT, NJIT, FR0 and FR0-Bulk; a department that failed (null) is skipped", () => {
  const row = (A, B, C) => ({ A, B, C, Total: A + B + C });
  assert.deepEqual(combineAsrsProductionTotal(row(1, 2, 3), row(10, 20, 30), row(100, 0, 0), row(1000, 0, 0)), { A: 1111, B: 22, C: 33, Total: 1166 });
  assert.deepEqual(combineAsrsProductionTotal(row(1, 2, 3), row(10, 20, 30), null, null), { A: 11, B: 22, C: 33, Total: 66 });
  const h = (v) => ({ A: Array(8).fill(v), B: Array(8).fill(0), C: Array(8).fill(0) });
  const all = pickingOverallRow(h(1), h(2), h(3), h(4));
  assert.equal(all.hours[0], 10);
  assert.equal(all.total, 80);
  assert.equal(pickingOverallRow(h(1), h(2), null, null).total, 24);
});
