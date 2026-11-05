const test = require("node:test");
const assert = require("node:assert/strict");
const perf = require("../../../features/one-pager-report/asrsPerformance");
const { msUntilNextSave } = require("../../../live/asrsPerformanceAuto");

const hours = (v) => Array(8).fill(v);
const sections = {
  ccMetrics: { shifts: { ccDone: { A: 1, B: 2, C: 0, Total: 3 }, discrepancies: { Total: 5 }, ccStationsRan: { Total: 4 } } },
  compaction: { shifts: { compaction: { Total: 10 }, toteFreed: { Total: 6 } } },
  asrsProduction: { hours: { jit: { A: hours(1), B: hours(2), C: hours(0) }, njit: { A: hours(10), B: hours(0), C: hours(0) } }, pickingOverall: { total: 104 } },
};

test("flowMetrics adds up production per department and shift, and keeps a missing section null (not 0)", () => {
  const m = perf.flowMetrics(sections);
  assert.equal(m.picked, 104);
  assert.equal(m.pickedJit, 24);
  assert.equal(m.pickedNjit, 80);
  assert.deepEqual([m.pickedA, m.pickedB, m.pickedC], [88, 16, 0]);
  assert.equal(m.ccDone, 3);
  assert.equal(m.compaction, 10);
  assert.equal(m.bermuda, null);
  const none = perf.flowMetrics({});
  assert.equal(none.picked, null);
  assert.equal(none.ccDone, null);
});

test("levelMetrics reads the right-now sections; utilisation becomes a percentage", () => {
  const m = perf.levelMetrics({
    lockedTotes: { summary: { total: 435, p0Count: 58, p1Count: 58, p2Count: 304, sdCount: 15 } },
    outsideTote: { total: 107, h24plus: 102 },
    utilisation: { totals: { util: 0.4478 } },
    totesInAsrs: { total: { total: 48547 } },
    aisleOccupancy: { occupancy: { average: 81.2 } },
  });
  assert.deepEqual(m, { lockedTotal: 435, lockedP0: 58, lockedP1: 58, lockedP2: 304, lockedSd: 15, outsideTotal: 107, outside24: 102, utilPct: 44.8, totesInAsrs: 48547, aisleAvg: 81.2 });
});

test("summarise totals flow figures and averages each figure over only the days that have it", () => {
  const s = perf.summarise([
    { m: { picked: 100, lockedTotal: 400 } },
    { m: { picked: 200, lockedTotal: null } },
    { m: { picked: null, lockedTotal: 500 } },
  ]);
  assert.equal(s.total.picked, 300);
  assert.equal(s.avg.picked, 150);
  assert.equal(s.avg.lockedTotal, 450);
  assert.equal(s.total.lockedTotal, undefined); // level figures never add up
  assert.equal(s.counted.picked, 2);
});

test("monthDays lists every calendar day, leap years included", () => {
  assert.equal(perf.monthDays("2026-11").length, 30);
  assert.equal(perf.monthDays("2028-02").length, 29);
  assert.equal(perf.monthDays("2026-11")[0], "2026-11-01");
});

test("the morning save is scheduled for the next 06:05 IST", () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(msUntilNextSave(at("2026-11-03T00:30:00Z")), 5 * 60000); // 06:00 IST -> 5 min
  assert.equal(msUntilNextSave(at("2026-11-03T00:35:00Z")), 24 * 3600000); // exactly 06:05 -> tomorrow
  assert.equal(msUntilNextSave(at("2026-11-03T14:00:00Z")), (10 * 60 + 35) * 60000); // 19:30 IST
});

test("backfillDay stores rebuilt shift figures and, with no earlier One Pager for that date, null snapshots", async () => {
  const writes = [];
  const db = {
    query: async () => [], // no one_pager_reports rows for that day
    execute: async (sql, params) => { writes.push(params); return {}; },
  };
  const engine = {
    runCcMetricsForDate: async () => sections.ccMetrics,
    runCompactionForDate: async () => { throw new Error("Grafana down"); },
    runAsrsProductionForDate: async () => sections.asrsProduction,
  };
  const m = await perf.backfillDay({ dateStr: "2026-11-01", user: { id: 1 }, db, engine, qm: {} });
  assert.equal(m.picked, 104);
  assert.equal(m.compaction, null); // the failed section stays null
  assert.equal(m.lockedTotal, null);
  assert.equal(writes[0][0], "2026-11-01");
  assert.equal(writes[0][2], "BACKFILL");
});
