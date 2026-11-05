const test = require("node:test");
const assert = require("node:assert/strict");
const { summarize, percentile } = require("../../../features/alerts/alertAnalytics");

// 2026-11-02 00:00 IST = 2026-11-01T18:30Z
const DAY0 = Date.parse("2026-11-01T18:30:00Z");
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60000;

function alert(over) {
  return { id: 1, ruleKey: "G1_TOTE_SHORT_QTY", level: "GLOBAL", status: "OPEN", detail: {}, eventAt: iso(DAY0 + 60 * MIN), raisedAt: iso(DAY0 + 61 * MIN), acknowledgedAt: null, acknowledgedBy: null, remark: null, remarkBy: null, ...over };
}

test("percentile uses nearest rank and is null with no data", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test("summarize counts by level, status, day, hour, rule, person and station", () => {
  const raised = DAY0 + 61 * MIN;
  const alerts = [
    alert({ id: 1, detail: { station: "S1" } }),
    alert({ id: 2, status: "ACKNOWLEDGED", acknowledgedBy: "E1", acknowledgedAt: iso(raised + 10 * MIN), remark: "done", remarkBy: "E2", detail: { station: "S1" } }),
    alert({ id: 3, ruleKey: "G2_STATION_SHORT_TOTES", level: "NORMAL", status: "ACKNOWLEDGED", acknowledgedBy: "E1", acknowledgedAt: iso(raised + 30 * MIN), eventAt: iso(DAY0 + 86400000 + 5 * 3600000) }),
    alert({ id: 4, eventAt: iso(DAY0 - 3 * 86400000) }), // before the period
  ];
  const s = summarize(alerts, { sinceMs: DAY0, nowMs: DAY0 + 2 * 86400000 - 1 });

  assert.deepEqual(s.totals, { total: 3, global: 2, normal: 1, open: 1, acknowledged: 2, withRemark: 1 });
  assert.deepEqual(s.byDay, [{ day: "2026-11-02", GLOBAL: 2, NORMAL: 0 }, { day: "2026-11-03", GLOBAL: 0, NORMAL: 1 }]);
  assert.equal(s.byHour[1].count, 2); // 01:00 IST
  assert.equal(s.byHour[5].count, 1);
  assert.deepEqual(s.ack, { count: 2, medianMin: 10, p90Min: 30 });
  assert.equal(s.byRule[0].key, "G1_TOTE_SHORT_QTY");
  assert.equal(s.byRule[0].total, 2);
  assert.equal(s.byRule[0].open, 1);
  assert.deepEqual(s.byRule[0].ack, { count: 1, medianMin: 10, p90Min: 10 });
  assert.deepEqual(s.byPerson.map((p) => [p.employeeId, p.acknowledged, p.remarks]), [["E1", 2, 0], ["E2", 0, 1]]);
  assert.deepEqual(s.byStation, [{ station: "S1", count: 2 }]);
});

test("an empty period has zero-filled days but no response-time figures", () => {
  const s = summarize([], { sinceMs: DAY0, nowMs: DAY0 + 3600000 });
  assert.equal(s.totals.total, 0);
  assert.equal(s.byDay.length, 1);
  assert.deepEqual(s.ack, { count: 0, medianMin: null, p90Min: null });
});

test("with history: every remark save counts, undo and growth are counted, time to first remark is measured", () => {
  const raised = DAY0 + 61 * MIN;
  const alerts = [alert({ id: 1, remark: "second", remarkBy: "E2" }), alert({ id: 2 })];
  const events = [
    { alertId: 1, kind: "RAISED", at: iso(raised) },
    { alertId: 1, kind: "UPDATED", at: iso(raised + MIN), metric: 40 },
    { alertId: 1, kind: "REMARK", at: iso(raised + 20 * MIN), actor: "E1" },
    { alertId: 1, kind: "REMARK_UNDONE", at: iso(raised + 21 * MIN), actor: "E1" },
    { alertId: 1, kind: "REMARK", at: iso(raised + 30 * MIN), actor: "E2" },
    { alertId: 99, kind: "REMARK", at: iso(raised), actor: "E9" }, // not an alert of this period
  ];
  const s = summarize(alerts, { sinceMs: DAY0, nowMs: DAY0 + 86400000 - 1, events });
  assert.deepEqual(s.history, { remarksSaved: 2, remarksUndone: 1, grew: 1, firstRemark: { count: 1, medianMin: 20, p90Min: 20 } });
  assert.deepEqual(s.byPerson.map((p) => [p.employeeId, p.remarks]), [["E1", 1], ["E2", 1]], "the undone remark still counts for E1");
});

test("the per-day series comes from the rollup when given, zero-filled for days without rows", () => {
  const daily = [{ day: "2026-11-02", level: "GLOBAL", raised: 5 }, { day: "2026-11-02", level: "NORMAL", raised: 2 }];
  const s = summarize([], { sinceMs: DAY0, nowMs: DAY0 + 2 * 86400000 - 1, daily });
  assert.equal(s.dailySource, "rollup");
  assert.deepEqual(s.byDay, [{ day: "2026-11-02", GLOBAL: 5, NORMAL: 2 }, { day: "2026-11-03", GLOBAL: 0, NORMAL: 0 }]);
});
