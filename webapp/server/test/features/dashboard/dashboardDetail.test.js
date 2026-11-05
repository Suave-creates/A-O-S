// dashboardDetail.js: the pure shaping behind the Dashboard's detail popups.

const test = require("node:test");
const assert = require("node:assert/strict");
const metrics = require("../../../features/dashboard/dashboardMetrics");
const d = require("../../../features/dashboard/dashboardDetail");
const { combineShifts } = require("../../../features/dashboard/ccMetrics");

const NOW = Date.UTC(2026, 9, 13, 8, 53); // 14:23 IST
const HOURS = metrics.dayHours("2026-10-13", NOW);
const ist = (h, mi = 0, s = 0) => Date.UTC(2026, 9, 13, h, mi, s) - 5.5 * 3600000;
// Discrepancy rows carry the IST wall clock as if it were UTC (see dashboardDetail.js).
const wall = (h, mi = 0) => Date.UTC(2026, 9, 13, h, mi);
const istText = (h, mi = 0) => `2026-10-13 ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00.000`;

test("istStringToMs reads IST wall-clock strings; rowMs also accepts epoch ms", () => {
  assert.equal(d.istStringToMs("2026-10-13 14:00:00.000"), ist(14));
  assert.equal(d.rowMs(wall(9, 30)), ist(9, 30), "numeric (wall-clock-as-UTC) rows convert to a true epoch");
  assert.equal(d.istStringToMs("garbage"), null);
});

function rows() {
  return {
    A: {
      stockRows: [
        { container: "TL0000000001", station: "GS1", user: "u1", createTime: istText(6, 10) },
        { container: "TL0000000001-1", station: "GS1", user: "u1", createTime: istText(6, 20) }, // same BASE tote, same hour
        { container: "TL0000000002", station: "GS2", user: "u2", createTime: istText(7, 5) },
        { container: "TS0000000003", station: "GS1", user: "u1", createTime: istText(13, 59) },
      ],
      discRows: [
        { station: "GS1", user: "u1", container: "TL0000000001", eventType: "E", discrepancyType: "SHORT", createTime: wall(6, 15) },
        { station: "GS2", user: "u2", container: "TL0000000002", eventType: "E", discrepancyType: "ALRIGHT", createTime: wall(7, 10) }, // not a discrepancy
        { station: "GS2", user: "u2", container: "TL0000000009", eventType: "E", discrepancyType: "SHORT", createTime: wall(13, 30) },
      ],
    },
    B: { stockRows: [], discRows: [] },
    C: { stockRows: [], discRows: [] },
  };
}

test("ccHourly: CC Done counts distinct BASE totes per hour (partitions don't double count)", () => {
  const cc = d.ccHourly(rows(), HOURS);
  assert.equal(cc.ccDone[0], 1, "06-07: TL...1 and its _PR1 are one tote");
  assert.equal(cc.ccDone[1], 1, "07-08");
  assert.equal(cc.ccDone[7], 1, "13-14");
  assert.equal(cc.ccDone.reduce((a, b) => a + b, 0), 3);
});

test("ccHourly: stations running per hour and SHORT-only discrepancies per hour", () => {
  const cc = d.ccHourly(rows(), HOURS);
  assert.equal(cc.stations[0], 1);
  assert.equal(cc.stations[1], 1);
  assert.equal(cc.discrepancies[0], 1);
  assert.equal(cc.discrepancies[1], 0, "ALRIGHT is a clean check, not a discrepancy");
  assert.equal(cc.discrepancies[7], 1);
});

test("ccHourly: the tile totals agree with the shift-level numbers (same definitions)", () => {
  const r = rows();
  const cc = d.ccHourly(r, HOURS);
  const shifts = combineShifts(r);
  assert.equal(cc.totals.ccDone, shifts.ccDone.A);
  assert.equal(cc.totals.discrepancies, shifts.discrepancies.A);
  assert.equal(cc.totals.ccStationsRan, shifts.ccStationsRan.A);
});

test("ccHourly: station table and latest discrepancies (newest first, IST clock)", () => {
  const cc = d.ccHourly(rows(), HOURS);
  const gs1 = cc.stationRows.find((s) => s.station === "GS1");
  assert.equal(gs1.totes, 2);
  assert.equal(gs1.checks, 3);
  assert.equal(gs1.discrepancies, 1);
  assert.equal(cc.stationRows[0].station, "GS1", "most totes first");
  assert.deepEqual(cc.discrepancyRows.map((r) => r.time), ["13:30:00", "06:15:00"]);
  assert.equal(cc.discrepancyRows[0].station, "GS2");
});

test("ccHourly: rows outside the site day are ignored for the hourly series", () => {
  const r = rows();
  r.A.stockRows.push({ container: "TL0000000099", station: "GS9", user: "x", createTime: "2026-10-12 03:00:00.000" });
  const cc = d.ccHourly(r, HOURS);
  assert.equal(cc.ccDone.reduce((a, b) => a + b, 0), 3);
});

test("hourlyEnvelope: peak / current / per-hour average ignore future hours; future hours carry null", () => {
  const values = HOURS.map((h, i) => (h.status === "future" ? 999 : i + 1));
  const env = d.hourlyEnvelope({ metric: "compaction", title: "Compaction", unit: "events", siteDay: "2026-10-13", hours: HOURS, values, shifts: { A: 1, B: 2, C: 3, Total: 6 }, generatedAt: "t" });
  assert.equal(env.kind, "hourly");
  assert.equal(env.since, "06:00 IST");
  assert.equal(env.hours.filter((h) => h.status === "future").every((h) => h.value === null), true, "future hours never show a value");
  assert.deepEqual(env.peak, { label: "14-15", value: 9 });
  assert.deepEqual(env.current, { label: "14-15", value: 9 });
  assert.equal(env.perHour, 5);
  assert.deepEqual(env.shifts, { A: 1, B: 2, C: 3, Total: 6 });
});

test("hourlyEnvelope: a day with no data yet has no peak and no average (not zero)", () => {
  const future = metrics.dayHours("2026-10-14", NOW);
  const env = d.hourlyEnvelope({ metric: "x", title: "X", unit: "u", siteDay: "2026-10-14", hours: future, values: future.map(() => null), shifts: {}, generatedAt: "t" });
  assert.equal(env.peak, null);
  assert.equal(env.perHour, null);
});

// ── Aisle audit ──────────────────────────────────────────────────────────

const levels = (a) => (a <= 4 ? 19 : 24);

test("aisleAuditSummary: per-aisle totals, level occupancy, side/depth split", () => {
  const model = {
    occupiedSlots: [
      { aisle: 1, level: 1, side: "left", depth: "front", zone: "Z1", shuttleHealthStatus: "OK" },
      { aisle: 1, level: 1, side: "right", depth: "back", zone: "Z1", shuttleHealthStatus: "OK" },
      { aisle: 1, level: 2, side: "left", depth: "front", zone: "Z2", shuttleHealthStatus: "BAD" },
      { aisle: 5, level: 24, side: "right", depth: "back", zone: "Z9", shuttleHealthStatus: "OK" },
    ],
    duplicateSlots: [{ slotKey: "x", containers: ["a", "b"] }],
    unparsedLocations: [],
  };
  const s = d.aisleAuditSummary(model, levels);
  assert.equal(s.aisles.length, 6);
  const a1 = s.aisles[0];
  assert.equal(a1.total, 19 * 452);
  assert.equal(a1.occupied, 3);
  assert.equal(a1.levels.length, 19);
  assert.equal(a1.levels[0].occupied, 2);
  assert.equal(a1.levels[1].occupied, 1);
  assert.equal(a1.sides.left.occupied, 2);
  assert.equal(a1.depths.back.occupied, 1);
  assert.deepEqual(a1.zones[0], { zone: "Z1", occupied: 2 });
  assert.deepEqual(a1.shuttleHealth.find((h) => h.status === "BAD"), { status: "BAD", occupied: 1 });
  assert.equal(s.aisles[4].levels.length, 24);
  assert.equal(s.overall.occupied, 4);
  assert.equal(s.anomalies.duplicateSlots, 1);
});

test("aisleAuditSummary: empty model is all zeros, not an error", () => {
  const s = d.aisleAuditSummary({ occupiedSlots: [] }, levels);
  assert.equal(s.overall.occupied, 0);
  assert.equal(s.overall.pct, 0);
});

// ── Utilisation ──────────────────────────────────────────────────────────

const RUN = {
  createdAt: "2026-10-13T08:00:00.000Z",
  caps: { largeLens: 300 },
  totals: { totes: 100, qty: 5000, cap: 10000, util: 0.5 },
  stats: {
    largeLens: { totes: 10, qty: 100, cap: 200 },
    largeFrame: { totes: 20, qty: 300, cap: 300 },
    smallLens: { totes: 30, qty: 50, cap: 200 },
    smallFrame: { totes: 40, qty: 10, cap: 100 },
  },
};

test("utilisationEnvelope: category rows plus Large / Small / Total groups", () => {
  const env = d.utilisationEnvelope({ metric: "utilisation", title: "T", siteDay: "2026-10-13", latest: RUN, generatedAt: "t" });
  assert.equal(env.categories.length, 4);
  assert.equal(env.categories[0].util, 0.5);
  assert.deepEqual({ totes: env.large.totes, util: env.large.util }, { totes: 30, util: 400 / 500 });
  assert.deepEqual({ totes: env.small.totes, util: env.small.util }, { totes: 70, util: 60 / 300 });
  assert.equal(env.total.util, 0.5);
  assert.equal(env.trend, undefined); // the tiles carry the latest run only
});

test("utilisationEnvelope: no run yet -> an explicit empty state", () => {
  const env = d.utilisationEnvelope({ metric: "utilisation", title: "T", siteDay: "d", latest: null, generatedAt: "t" });
  assert.equal(env.empty, true);
});

test("regression: hourly discrepancy buckets add up to the shift total the tile shows (wall-clock-as-UTC rows)", () => {
  const discRows = [];
  for (let h = 6; h < 14; h++) for (let k = 0; k < h - 5; k++) discRows.push({ station: "GS1", discrepancyType: "SHORT", container: "TL000000000" + k, createTime: wall(h, 10 + k) });
  const r = { A: { discRows, stockRows: [] }, B: { discRows: [], stockRows: [] }, C: { discRows: [], stockRows: [] } };
  const cc = d.ccHourly(r, HOURS);
  const shiftA = combineShifts(r).discrepancies.A;
  assert.equal(cc.discrepancies.slice(0, 8).reduce((a, b) => a + b, 0), shiftA, "shift A hours sum to the tile's shift A");
  assert.equal(cc.discrepancies.slice(8).reduce((a, b) => a + b, 0), 0, "nothing leaks into shift B hours");
  assert.deepEqual(cc.discrepancies.slice(0, 8), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("lastEventInfo: the table's IST wall-clock-as-UTC timestamp becomes a date + HH:MM; junk becomes null", () => {
  assert.deepEqual(d.lastEventInfo(Date.UTC(2026, 9, 13, 5, 54, 39)), { date: "2026-10-13", time: "05:54" });
  assert.equal(d.lastEventInfo(null), null);
  assert.equal(d.lastEventInfo(NaN), null);
});

test("hourlyEnvelope carries the last event through for a genuine zero day", () => {
  const env = d.hourlyEnvelope({ metric: "compaction", title: "C", unit: "compaction events", siteDay: "2026-10-13", hours: HOURS, values: HOURS.map((h) => (h.status === "future" ? null : 0)), shifts: { A: 0, B: 0, C: 0, Total: 0 }, generatedAt: "t", lastEvent: Date.UTC(2026, 9, 13, 5, 54) });
  assert.deepEqual(env.lastEvent, { date: "2026-10-13", time: "05:54" });
  assert.equal(env.peak.value, 0);
});

// ── CC Done: Bermuda split and stations running now ─────────────────────────

test("ccHourly: per-hour true CC Done vs Bermuda (every line SHORT), and the day's Bermuda list", () => {
  const r = {
    A: {
      stockRows: [
        { container: "TL0000000001", station: "GS1", resultType: "SHORT", createTime: istText(6, 10) },
        { container: "TL0000000001", station: "GS1", resultType: "SHORT", createTime: istText(6, 10) },
        { container: "TL0000000002", station: "GS1", resultType: "ALRIGHT", quantity: 4, createTime: istText(6, 20) },
        { container: "TL0000000002", station: "GS1", resultType: "SHORT", createTime: istText(6, 20) },
        { container: "TL0000000003", station: "GS2", resultType: "SHORT", createTime: istText(7, 5) },
      ],
      discRows: [],
    },
    B: { stockRows: [], discRows: [] },
    C: { stockRows: [], discRows: [] },
  };
  const cc = d.ccHourly(r, HOURS, NOW);
  assert.deepEqual(cc.ccDone.slice(0, 2), [1, 0], "06-07: tote 2 is proper; 07-08: tote 3 is Bermuda so not CC Done");
  assert.deepEqual(cc.bermuda.slice(0, 2), [1, 1]);
  assert.equal(cc.bermudaTotal, 2);
  assert.deepEqual(cc.bermudaRows.map((x) => [x.tote, x.station, x.time, x.lines]), [["TL0000000003", "GS2", "07:05:00", 1], ["TL0000000001", "GS1", "06:10:00", 2]]);
});

test("ccHourly: stations 'running now' = stations with a stock check in the last 10 minutes", () => {
  const justNow = new Date(NOW - 3 * 60000 + 5.5 * 3600000).toISOString().slice(0, 19).replace("T", " ") + ".000"; // 3 min ago, IST wall clock
  const longAgo = new Date(NOW - 40 * 60000 + 5.5 * 3600000).toISOString().slice(0, 19).replace("T", " ") + ".000";
  const r = {
    A: { stockRows: [
      { container: "TL0000000001", station: "GS1", resultType: "ALRIGHT", createTime: justNow },
      { container: "TL0000000002", station: "GS2", resultType: "ALRIGHT", createTime: longAgo },
    ], discRows: [] },
    B: { stockRows: [], discRows: [] }, C: { stockRows: [], discRows: [] },
  };
  const cc = d.ccHourly(r, HOURS, NOW);
  assert.equal(cc.stationsRunningNow, 1);
  assert.equal(cc.stationRows.find((s) => s.station === "GS1").running, true);
  assert.equal(cc.stationRows.find((s) => s.station === "GS2").running, false);
});

test("ccHourly: stations ran today is the DISTINCT count across the whole day (not a sum of per-shift counts)", () => {
  const r = {
    A: { stockRows: [{ container: "TL0000000001", station: "GS1", resultType: "ALRIGHT", createTime: istText(7, 0) }, { container: "TL0000000002", station: "GS2", resultType: "ALRIGHT", createTime: istText(8, 0) }], discRows: [] },
    B: { stockRows: [{ container: "TL0000000003", station: "GS1", resultType: "ALRIGHT", createTime: istText(14, 30) }], discRows: [] },
    C: { stockRows: [], discRows: [] },
  };
  assert.equal(d.ccHourly(r, HOURS, NOW).stationsRanToday, 2, "GS1 ran in both shifts but is one station");
});

test("ccHourly: units marked short per hour, per station and per Bermuda tote", () => {
  const r = {
    A: {
      stockRows: [
        { container: "TL0000000001", station: "GS1", resultType: "SHORT", quantity: 4, createTime: istText(6, 10) },
        { container: "TL0000000001", station: "GS1", resultType: "SHORT", quantity: 2, createTime: istText(6, 10) },
        { container: "TL0000000002", station: "GS1", resultType: "ALRIGHT", quantity: 9, createTime: istText(7, 5) },
        { container: "TL0000000002", station: "GS1", resultType: "SHORT", quantity: 1, createTime: istText(7, 5) },
      ],
      discRows: [],
    },
    B: { stockRows: [], discRows: [] }, C: { stockRows: [], discRows: [] },
  };
  const cc = d.ccHourly(r, HOURS, NOW);
  assert.deepEqual(cc.shortQty.slice(0, 2), [6, 1]);
  assert.equal(cc.stationRows.find((s) => s.station === "GS1").shortQty, 7);
  assert.equal(cc.bermudaRows[0].shortQty, 6);
});

test("multi-shift flagging: a tote checked in two shifts is listed with each shift's verdict, and Bermuda-in-both is counted", () => {
  const r = {
    A: { stockRows: [
      { container: "TL0000000001", station: "GS1", resultType: "SHORT", quantity: 2, createTime: istText(7, 0) }, // Bermuda in A
      { container: "TL0000000002", station: "GS1", resultType: "SHORT", quantity: 1, createTime: istText(8, 0) }, // Bermuda in A
      { container: "TL0000000003", station: "GS1", resultType: "ALRIGHT", quantity: 0, createTime: istText(9, 0) }, // proper, A only
    ], discRows: [] },
    B: { stockRows: [
      { container: "TL0000000001", station: "GS2", resultType: "SHORT", quantity: 3, createTime: istText(14, 30) }, // Bermuda again in B
      { container: "TL0000000002", station: "GS2", resultType: "ALRIGHT", quantity: 5, createTime: istText(15, 0) }, // proper in B
    ], discRows: [] },
    C: { stockRows: [], discRows: [] },
  };
  const cc = d.ccHourly(r, HOURS, NOW);
  assert.equal(cc.multiShift.total, 2);
  assert.equal(cc.multiShift.bermudaInMultiple, 1, "only tote 1 is Bermuda in both shifts");
  assert.deepEqual(cc.multiShift.rows.map((x) => [x.tote, x.A, x.B, x.C]), [["TL0000000001", "Bermuda", "Bermuda", "-"], ["TL0000000002", "Bermuda", "CC Done", "-"]]);
  assert.equal(cc.multiShift.distinctChecked, 3);
  const row = cc.bermudaRows.find((x) => x.tote === "TL0000000001");
  assert.equal(row.shifts, "A+B");
  assert.match(row.multi, /^⚑/);
});

test("ccHourly: the CC Done list holds every proper tote (newest first) and is the exact complement of the Bermuda list", () => {
  const r = {
    A: { stockRows: [
      { container: "TL0000000001", station: "GS1", resultType: "ALRIGHT", quantity: 4, createTime: istText(7, 0) },
      { container: "TL0000000001", station: "GS1", resultType: "SHORT", quantity: 3, createTime: istText(7, 0) },
      { container: "TL0000000002", station: "GS2", resultType: "SHORT", quantity: 2, createTime: istText(8, 0) }, // Bermuda
      { container: "TL0000000003", station: "GS3", resultType: "ALRIGHT", quantity: 5, createTime: istText(9, 0) },
    ], discRows: [] },
    B: { stockRows: [{ container: "TL0000000003", station: "GS3", resultType: "ALRIGHT", quantity: 1, createTime: istText(14, 20) }], discRows: [] },
    C: { stockRows: [], discRows: [] },
  };
  const cc = d.ccHourly(r, HOURS, NOW);
  assert.deepEqual(cc.doneRows.map((x) => x.tote), ["TL0000000003", "TL0000000001"], "newest check first");
  assert.equal(cc.doneTotal, 2);
  assert.deepEqual(cc.bermudaRows.map((x) => x.tote), ["TL0000000002"]);
  const t1 = cc.doneRows.find((x) => x.tote === "TL0000000001");
  assert.deepEqual([t1.station, t1.lines, t1.shortQty, t1.time], ["GS1", 2, 3, "07:00:00"]);
  assert.match(cc.doneRows.find((x) => x.tote === "TL0000000003").multi, /^⚑ A\+B/, "checked in two shifts is flagged");
  assert.equal(cc.doneTotal + cc.bermudaTotal, cc.multiShift.distinctChecked, "CC Done + Bermuda = every distinct tote checked");
});
