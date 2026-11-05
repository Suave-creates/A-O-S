// Pure unit tests for server/features/dashboard/ccMetrics.js - ported verbatim from the
// legacy extension's ccMetricsFor(). No I/O, no network, no capability call.

const test = require("node:test");
const assert = require("node:assert/strict");
const { ccMetricsFor, combineShifts, classifyChecks } = require("../../../features/dashboard/ccMetrics");

function disc(container, discrepancyType, station) {
  return { container, discrepancyType, station };
}
function stock(container, station, resultType, createTime, quantity) {
  return { container, station, resultType, createTime, quantity };
}

test("ccDone dedupes stock-check rows to distinct BASE totes (partition suffix stripped)", () => {
  const stockRows = [stock("TL0000000001-1", "5"), stock("TL0000000001-2", "5"), stock("TL0000000002", "6")];
  const m = ccMetricsFor([], stockRows);
  assert.equal(m.ccDone, 2, "TL0000000001-1 and -2 are the SAME base tote - must count once, not twice");
});

test("discrepancies counts only SHORT-type events - ALRIGHT is a clean check, not a discrepancy", () => {
  const discRows = [disc("TL0000000001", "SHORT", "5"), disc("TL0000000002", "ALRIGHT", "5"), disc("TL0000000003", "SHORT", "6")];
  const m = ccMetricsFor(discRows, []);
  assert.equal(m.discrepancies, 2);
});

test("ccStationsRan counts distinct stations across stock-check rows, ignoring falsy/missing station", () => {
  const stockRows = [stock("TL0000000001", "5"), stock("TL0000000002", "5"), stock("TL0000000003", "6"), stock("TL0000000004", null)];
  const m = ccMetricsFor([], stockRows);
  assert.equal(m.ccStationsRan, 2);
});

test("discrepancyStations counts distinct stations only among SHORT-type events", () => {
  const discRows = [disc("TL0000000001", "SHORT", "5"), disc("TL0000000002", "ALRIGHT", "9"), disc("TL0000000003", "SHORT", "5")];
  const m = ccMetricsFor(discRows, []);
  assert.equal(m.discrepancyStations, 1);
});

test("empty rows produce all-zero metrics, never a crash", () => {
  const m = ccMetricsFor([], []);
  assert.deepEqual(m, { discrepancies: 0, ccDone: 0, bermudaTotes: 0, purgedTotes: 0, ccChecked: 0, shortQty: 0, bermudaShortQty: 0, purgedShortQty: 0, ccStationsRan: 0, discrepancyStations: 0 });
});

test("ccMetricsFor tolerates undefined/null row arrays (defensive default)", () => {
  const m = ccMetricsFor(undefined, null);
  assert.deepEqual(m, { discrepancies: 0, ccDone: 0, bermudaTotes: 0, purgedTotes: 0, ccChecked: 0, shortQty: 0, bermudaShortQty: 0, purgedShortQty: 0, ccStationsRan: 0, discrepancyStations: 0 });
});

test("combineShifts: Total is the sum of A+B+C for every metric, per-shift values are preserved", () => {
  const windowRows = {
    A: { discRows: [disc("T1", "SHORT", "5")], stockRows: [stock("T1", "5")] },
    B: { discRows: [], stockRows: [stock("T2", "5"), stock("T3", "6")] },
    C: { discRows: [disc("T4", "SHORT", "7"), disc("T5", "SHORT", "7")], stockRows: [] },
  };
  const shifts = combineShifts(windowRows);
  assert.deepEqual(shifts.ccDone, { A: 1, B: 2, C: 0, Total: 3 });
  assert.deepEqual(shifts.discrepancies, { A: 1, B: 0, C: 2, Total: 3 });
  assert.deepEqual(shifts.ccStationsRan, { A: 1, B: 2, C: 0, Total: 3 });
  assert.deepEqual(shifts.discrepancyStations, { A: 1, B: 0, C: 1, Total: 2 });
});

// ── True CC Done vs Bermuda totes ───────────────────────────────────────────

test("Bermuda tote: EVERY line of its check is SHORT -> counted as Bermuda, not as CC Done", () => {
  const stockRows = [
    stock("TL0000000001", "5", "SHORT", "t1"), stock("TL0000000001", "5", "SHORT", "t1"), // all short -> Bermuda
    stock("TL0000000002", "5", "ALRIGHT", "t1", 4), stock("TL0000000002", "5", "SHORT", "t1", 2), // a counted match + a short -> proper
    stock("TL0000000003", "6", "ALRIGHT", "t1"), // clean -> proper
  ];
  const m = ccMetricsFor([], stockRows);
  assert.equal(m.ccChecked, 3);
  assert.equal(m.bermudaTotes, 1);
  assert.equal(m.ccDone, 2, "true CC Done = checked - Bermuda");
});

test("EXCESS or any non-SHORT line keeps a tote out of Bermuda", () => {
  const m = ccMetricsFor([], [stock("TL0000000001", "5", "SHORT", "t1"), stock("TL0000000001", "5", "EXCESS", "t1")]);
  assert.equal(m.bermudaTotes, 0);
  assert.equal(m.ccDone, 1);
});

test("a tote is judged by its LATEST check: Bermuda earlier, counted properly later -> proper CC Done", () => {
  const stockRows = [
    stock("TL0000000001", "5", "SHORT", "2026-10-13 08:00:00.000"),
    stock("TL0000000001", "6", "ALRIGHT", "2026-10-13 12:00:00.000"),
  ];
  const m = ccMetricsFor([], stockRows);
  assert.equal(m.bermudaTotes, 0);
  assert.equal(m.ccDone, 1);
  // ...and the other way round
  const m2 = ccMetricsFor([], [stock("TL0000000002", "5", "ALRIGHT", "2026-10-13 08:00:00.000"), stock("TL0000000002", "5", "SHORT", "2026-10-13 12:00:00.000")]);
  assert.equal(m2.bermudaTotes, 1);
  assert.equal(m2.ccDone, 0);
});

test("partition suffixes are one tote for the Bermuda decision too", () => {
  const m = ccMetricsFor([], [stock("TL0000000001-1", "5", "SHORT", "t1"), stock("TL0000000001-2", "5", "SHORT", "t1")]);
  assert.equal(m.ccChecked, 1);
  assert.equal(m.bermudaTotes, 1);
});

test("rows without a result type are never assumed SHORT (so never Bermuda)", () => {
  const m = ccMetricsFor([], [stock("TL0000000001", "5")]);
  assert.equal(m.bermudaTotes, 0);
  assert.equal(m.ccDone, 1);
});

test("classifyChecks reports the latest check's station, time and line count", () => {
  const map = classifyChecks([stock("TL0000000001", "GS1", "SHORT", "t1"), stock("TL0000000001", "GS1", "SHORT", "t1"), stock("TL0000000001", "GS2", "SHORT", "t2")]);
  assert.deepEqual(map.get("TL0000000001"), { latest: "t2", lines: 1, bermuda: true, purged: false, allAlright: false, shortQty: 0, shortLines: 1, station: "GS2" });
});

test("combineShifts carries Bermuda and checked totals per shift", () => {
  const shifts = combineShifts({
    A: { discRows: [], stockRows: [stock("T1", "5", "SHORT", "t"), stock("T2", "5", "ALRIGHT", "t")] },
    B: { discRows: [], stockRows: [stock("T3", "6", "SHORT", "t")] },
    C: { discRows: [], stockRows: [] },
  });
  assert.deepEqual(shifts.bermudaTotes, { A: 1, B: 1, C: 0, Total: 2 });
  assert.deepEqual(shifts.ccChecked, { A: 2, B: 1, C: 0, Total: 3 });
  assert.deepEqual(shifts.ccDone, { A: 1, B: 0, C: 0, Total: 1 });
});

// ── Purged vs Bermuda ──────────────────────────────────────────────────────

test("Bermuda is only a tote whose lines are ALL short: short + alright(0) lines are a normal CC Done", () => {
  const m = ccMetricsFor([], [
    stock("TL0000000001", "5", "SHORT", "t1", 2), stock("TL0000000001", "5", "SHORT", "t1", 3),
    stock("TL0000000001", "5", "ALRIGHT", "t1", 0), stock("TL0000000001", "5", "ALRIGHT", "t1", 0),
  ]);
  assert.equal(m.bermudaTotes, 0);
  assert.equal(m.ccDone, 1);
});

const win = (fromH, toH) => ({ from: Date.UTC(2026, 9, 15, fromH, 0, 0), to: Date.UTC(2026, 9, 15, toH, 0, 0) }); // UTC hours

test("a tote in purgeMarks (pulled in purge mode, then seen empty in Quadron) is Purged: out of CC Done, Bermuda and Qty short", () => {
  const rows = [stock("TL0000000001", "5", "SHORT", "2026-10-15 10:00:00.000", 2), stock("TL0000000001", "5", "ALRIGHT", "2026-10-15 10:00:00.000", 0)];
  const m = ccMetricsFor([], rows, { TL0000000001: win(4, 5) }); // pulled 09:30 IST, seen empty 10:30 IST; the check is 10:00 IST
  assert.equal(m.purgedTotes, 1);
  assert.equal(m.purgedShortQty, 2);
  assert.equal(m.bermudaTotes, 0);
  assert.equal(m.ccDone, 0);
  assert.equal(m.shortQty, 0, "purged units are reported on their own");
  assert.equal(m.ccChecked, 1);
});

test("a purge pull AFTER the check does not make that check a purge; a check inside the window does", () => {
  const rows = [stock("TL0000000001", "5", "SHORT", "2026-10-15 10:00:00.000", 2)];
  assert.equal(ccMetricsFor([], rows, { TL0000000001: win(6, 7) }).bermudaTotes, 1);
  assert.equal(ccMetricsFor([], rows, { TL0000000001: win(4, 5) }).purgedTotes, 1);
});

test("a later count on a purged tote (decanted again, called for a discrepancy) is a normal CC, not part of the purge", () => {
  const later = [stock("TL0000000001", "5", "SHORT", "2026-10-16 09:00:00.000", 2), stock("TL0000000001", "5", "ALRIGHT", "2026-10-16 09:00:00.000", 5)];
  const m = ccMetricsFor([], later, { TL0000000001: win(4, 5) }); // purge window closed on 15 Oct
  assert.equal(m.purgedTotes, 0);
  assert.equal(m.ccDone, 1);
});

test("a tote with no purge mark is never Purged, whatever its lines", () => {
  const counted = [stock("TL0000000002", "5", "SHORT", "2026-10-15 10:00:00.000", 2), stock("TL0000000002", "5", "ALRIGHT", "2026-10-15 10:00:00.000", 6)];
  const m = ccMetricsFor([], counted, {});
  assert.equal(m.purgedTotes, 0);
  assert.equal(m.ccDone, 1);
});

// ── Quantity marked short ──────────────────────────────────────────────────

function line(container, resultType, quantity, createTime, station = "5") {
  return { container, station, resultType, quantity, createTime };
}

test("shortQty sums the units on SHORT lines only (ALRIGHT / EXCESS units are not 'short')", () => {
  const m = ccMetricsFor([], [line("TL0000000001", "SHORT", 3, "t"), line("TL0000000001", "SHORT", 2, "t"), line("TL0000000001", "ALRIGHT", 50, "t"), line("TL0000000002", "EXCESS", 7, "t")]);
  assert.equal(m.shortQty, 5);
  assert.equal(m.bermudaShortQty, 0, "tote 1 has an ALRIGHT line, so it is not Bermuda");
});

test("bermudaShortQty is the short units inside Bermuda totes only", () => {
  const m = ccMetricsFor([], [line("TL0000000001", "SHORT", 4, "t"), line("TL0000000001", "SHORT", 6, "t"), line("TL0000000002", "ALRIGHT", 9, "t"), line("TL0000000002", "SHORT", 1, "t")]);
  assert.equal(m.shortQty, 11);
  assert.equal(m.bermudaShortQty, 10);
});

test("a re-checked tote is counted once, from its LATEST check (no double counting)", () => {
  const m = ccMetricsFor([], [line("TL0000000001", "SHORT", 5, "2026-10-13 08:00:00.000"), line("TL0000000001", "SHORT", 2, "2026-10-13 12:00:00.000")]);
  assert.equal(m.shortQty, 2);
});

test("quantities that are not numbers never poison the sum", () => {
  const m = ccMetricsFor([], [line("TL0000000001", "SHORT", null, "t"), line("TL0000000001", "SHORT", "abc", "t"), line("TL0000000001", "SHORT", "4", "t")]);
  assert.equal(m.shortQty, 4);
});

test("combineShifts carries shortQty and bermudaShortQty per shift", () => {
  const shifts = combineShifts({
    A: { discRows: [], stockRows: [line("T1", "SHORT", 3, "t")] },
    B: { discRows: [], stockRows: [line("T2", "SHORT", 2, "t"), line("T2", "ALRIGHT", 1, "t")] },
    C: { discRows: [], stockRows: [] },
  });
  assert.deepEqual(shifts.shortQty, { A: 3, B: 2, C: 0, Total: 5 });
  assert.deepEqual(shifts.bermudaShortQty, { A: 3, B: 0, C: 0, Total: 3 });
});
