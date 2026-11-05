const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPickingMonitor } = require("../../../features/picking-monitor/pickingMonitorEngine");

const HOUR = 3600000;
const START = Date.UTC(2026, 9, 17, 0, 30); // 06:00 IST on the site day
const SHIFT_OF = (i) => ["A", "B", "C"][Math.floor(i / 8)];
const S = (station, items) => ({ station, items });

// 24 hour objects; `lists` fills the first N hours (the last one "current" when `running`), the rest are future.
function hours(lists, { running = true } = {}) {
  return Array.from({ length: 24 }, (_, i) => {
    const reached = i < lists.length;
    return {
      shift: SHIFT_OF(i), label: `${String((6 + i) % 24).padStart(2, "0")}-${String((7 + i) % 24).padStart(2, "0")}`,
      from: START + i * HOUR, to: START + (i + 1) * HOUR,
      status: !reached ? "future" : running && i === lists.length - 1 ? "current" : "closed",
      stations: reached ? lists[i] : null,
    };
  });
}
const FILTERS = { type: "ALL", priority: "ALL" };
const build = (o) => buildPickingMonitor({ siteDay: "2026-10-17", filters: FILTERS, windowMin: 60, ...o });

test("stations are ranked by the window, compared with the previous window and given a share", () => {
  const r = build({
    hours: hours([[S("GS1", 100), S("GS2", 50)], [S("GS1", 120), S("GS2", 80)]]),
    cur: [S("GS1", 120), S("GS2", 80)], prev: [S("GS1", 100), S("GS2", 100)],
    now: START + HOUR + 30 * 60000,
  });
  assert.deepEqual(r.stations.map((s) => s.id), ["GS1", "GS2"]);
  assert.equal(r.stations[0].rank, 1);
  assert.equal(r.stations[0].delta, 20);
  assert.equal(r.stations[0].deltaPct, 20);
  assert.equal(r.stations[1].deltaPct, -20);
  assert.equal(r.stations[0].share, 60);
  assert.equal(r.totals.window, 200);
  assert.equal(r.totals.prev, 200);
  assert.equal(r.totals.deltaPct, 0);
  assert.equal(r.totals.today, 350);
  assert.equal(r.stations[0].today, 220);
});

test("a station that worked earlier today but picked nothing in the window is idle; one far below its peers is slow", () => {
  const r = build({
    hours: hours([[S("GS1", 90), S("GS2", 100), S("GS3", 110), S("GS4", 100), S("GS5", 95), S("GS6", 60)]]),
    cur: [S("GS1", 100), S("GS2", 110), S("GS3", 120), S("GS4", 105), S("GS5", 10)], prev: null,
    now: START + 30 * 60000,
  });
  const by = Object.fromEntries(r.stations.map((s) => [s.id, s]));
  assert.equal(by.GS6.state, "idle");
  assert.equal(by.GS5.state, "slow"); // 10 vs a median of 105
  assert.equal(by.GS1.state, "ok");
  assert.deepEqual(r.totals.idle, ["GS6"]);
  assert.deepEqual(r.totals.slow, ["GS5"]);
  assert.equal(by.GS1.prev, null, "no previous window -> no comparison, not a fake 0");
  assert.equal(r.totals.deltaPct, null);
});

test("with fewer than four active stations nobody is called slow (no meaningful peer group)", () => {
  const r = build({ hours: hours([[S("GS1", 100), S("GS2", 5), S("GS3", 90)]]), cur: [S("GS1", 100), S("GS2", 5), S("GS3", 90)], prev: [], now: START + 30 * 60000 });
  assert.deepEqual(r.totals.slow, []);
});

test("future hours stay null; a station missing from a read hour picked 0 there; totals use only hours reached", () => {
  const r = build({ hours: hours([[S("GS1", 10)], [S("GS2", 20)]]), cur: [S("GS2", 20)], prev: [], now: START + HOUR + 20 * 60000 });
  assert.equal(r.hours[5].total, null);
  assert.equal(r.hours[0].total, 10);
  const gs1 = r.stations.find((s) => s.id === "GS1");
  assert.deepEqual(gs1.hours.slice(0, 3), [10, 0, null]);
  assert.equal(r.hoursReached, 2);
  assert.equal(r.totals.today, 30);
});

test("pace projects the running hour against the day's average closed hour", () => {
  const now = START + 3 * HOUR + 30 * 60000;
  const ahead = build({ hours: hours([[S("a", 100)], [S("a", 110)], [S("a", 120)], [S("a", 140)]]), cur: [S("a", 1)], prev: [], now });
  assert.equal(ahead.pace.soFar, 140);
  assert.equal(ahead.pace.projected, 280);
  assert.equal(ahead.pace.state, "ahead");
  assert.equal(ahead.pace.vsAvgPct, 155); // 280 projected vs the 110 average closed hour
  assert.equal(ahead.avgPerHour, 110);
  assert.deepEqual(ahead.peak, { label: "08-09", shift: "A", total: 120 });
  const behind = build({ hours: hours([[S("a", 100)], [S("a", 110)], [S("a", 120)], [S("a", 20)]]), cur: [S("a", 1)], prev: [], now });
  assert.equal(behind.pace.state, "behind");
  const early = build({ hours: hours([[S("a", 100)], [S("a", 5)]]), cur: [S("a", 1)], prev: [], now: START + HOUR + 4 * 60000 });
  assert.equal(early.pace.projected, null);
  assert.equal(early.pace.state, "building");
});

test("shift totals count whole hours for the per-hour rate", () => {
  const r = build({ hours: hours([[S("a", 100)], [S("a", 200)], [S("a", 50)]]), cur: [S("a", 1)], prev: [], now: START + 2 * HOUR + 30 * 60000 });
  assert.equal(r.shifts.A.total, 350);
  assert.equal(r.shifts.A.hours, 3);
  assert.equal(r.shifts.A.perHour, 150); // (100 + 200) / 2 closed hours
  assert.equal(r.shifts.B.perHour, null);
});

test("a quiet moment is an empty list, and missing inputs are rejected", () => {
  const r = build({ hours: hours([[]]), cur: [], prev: [], now: START + 30 * 60000 });
  assert.deepEqual(r.stations, []);
  assert.equal(r.totals.window, 0);
  assert.throws(() => build({ hours: hours([[]]), cur: null, prev: [] }), /current window/);
  assert.throws(() => build({ hours: null, cur: [], prev: [] }), /hours/);
});

const CFG = [
  { id: "GS1", type: "FR01", operationType: "PICKING", userId: "GS1", loggedIn: true, priorityWeight: 0 },
  { id: "GS2", type: "JIT", operationType: "PICKING", userId: "GS2", loggedIn: true, priorityWeight: 300000000 },
  { id: "GS3", type: "FR01", operationType: "PICKING", userId: "GS3", loggedIn: true, priorityWeight: 25000000 },
  { id: "GS4", type: "BULK", operationType: "PICKING", userId: "GS4", loggedIn: true, priorityWeight: 0 },
  { id: "GS5", type: "FR01", operationType: "NA", userId: null, loggedIn: false, priorityWeight: 0 },
];
const withConfig = (extra = {}) => build({
  hours: hours([[S("GS1", 280), S("GS2", 150), S("GS3", 200)]]),
  cur: [S("GS1", 280), S("GS2", 150), S("GS3", 200)], prev: [], now: START + HOUR / 2,
  config: CFG, ptl: [{ station: "GS1", queuedItems: 144, queuedLines: 77, queuedSkus: 55, slots: 15 }], ...extra,
});

test("each station carries its facts, capacity percent and colour; a station to be checked gets none", () => {
  const r = withConfig();
  const by = Object.fromEntries(r.stations.map((s) => [s.id, s]));
  assert.deepEqual([by.GS1.capacityPct, by.GS1.health, by.GS1.type, by.GS1.priorityClass], [93, "green", "FR01", "NONPRIORITY"]);
  assert.deepEqual([by.GS2.capacityPct, by.GS2.health, by.GS2.priorityClass], [50, "yellow", "PRIORITY"]);
  assert.deepEqual([by.GS3.priorityClass, by.GS3.health], ["CHECK", null], "25000000 is neither 0 nor 300000000");
  assert.equal(by.GS1.queuedItems, 144);
  assert.equal(by.GS2.queuedItems, null, "no PTL row for this station");
});

test("a logged-in picking station that picked nothing is listed and red; a station not picking is not", () => {
  const r = withConfig();
  const gs4 = r.stations.find((s) => s.id === "GS4");
  assert.deepEqual([gs4.picks, gs4.capacityPct, gs4.health], [0, 0, "red"]);
  assert.equal(r.stations.some((s) => s.id === "GS5"), false);
});

test("capacity totals count the judged stations and name the ones a supervisor must check", () => {
  const c = withConfig().capacity;
  assert.deepEqual([c.judged, c.green, c.yellow, c.red], [3, 1, 1, 1]);
  assert.deepEqual(c.check, ["GS3"]);
  assert.equal(c.utilisationPct, Math.round(((280 + 150 + 0) / (3 * 300)) * 100));
  assert.equal(c.designPerHour, 300);
});

test("station filters narrow the stations AND the totals; the type list stays whole", () => {
  const r = withConfig({ stationFilter: { stationType: "FR01", stationPriority: "ALL" } });
  assert.deepEqual(r.stations.map((s) => s.id).sort(), ["GS1", "GS3"]);
  assert.equal(r.totals.window, 480);
  assert.equal(r.totals.today, 480);
  assert.deepEqual(r.stationTypes, ["BULK", "FR01", "JIT"]);
  const prio = withConfig({ stationFilter: { stationType: "ALL", stationPriority: "PRIORITY" } });
  assert.deepEqual(prio.stations.map((s) => s.id), ["GS2"]);
  assert.equal(prio.filters.stationPriority, "PRIORITY");
});

test("without the config the picks still show, nothing is judged, and a station filter matches nothing", () => {
  const r = withConfig({ config: null, ptl: null });
  assert.equal(r.configAvailable, false);
  assert.equal(r.queueAvailable, false);
  assert.ok(r.stations.every((s) => s.health === null && s.type === null));
  assert.equal(r.capacity.judged, 0);
  assert.equal(r.capacity.utilisationPct, null);
  assert.equal(withConfig({ config: null, stationFilter: { stationType: "JIT" } }).stations.length, 0);
});

test("capacity is judged on the station's load across ALL orders, not on the order-filtered picks", () => {
  // The filtered view shows GS1 at 30 items, but across all orders it carried 280 in the window.
  const r = withConfig({ cur: [S("GS1", 30)], hours: hours([[S("GS1", 30)]]), loadCur: [S("GS1", 280), S("GS2", 150)] });
  const gs1 = r.stations.find((s) => s.id === "GS1");
  assert.equal(gs1.picks, 30, "the tile number is still the filtered picks");
  assert.deepEqual([gs1.capacityPct, gs1.health], [93, "green"]);
  // With the unfiltered read unavailable nobody is judged on a partial count.
  const none = withConfig({ cur: [S("GS1", 30)], hours: hours([[S("GS1", 30)]]), loadCur: null });
  assert.ok(none.stations.every((s) => s.health === null && s.capacityPct === null));
  assert.equal(none.capacity.judged, 0);
});
