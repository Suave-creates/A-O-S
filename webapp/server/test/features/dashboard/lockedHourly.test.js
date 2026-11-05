const test = require("node:test");
const assert = require("node:assert/strict");
const { lockedHourly } = require("../../../features/dashboard/dashboardDetail");

const H = 3600000;
const T0 = Date.UTC(2026, 9, 13, 0, 30); // 06:00 IST
const hours = [0, 1, 2, 3].map((i) => ({ shift: "A", label: `0${6 + i}-0${7 + i}`, from: T0 + i * H, to: T0 + (i + 1) * H, status: i < 2 ? "closed" : i === 2 ? "current" : "future" }));
const snap = (min, total) => ({ createdAt: new Date(T0 + min * 60000).toISOString(), summary: { total, p0Count: 1, p1Count: 2, p2Count: 3, sdCount: 4 } });

test("an hour's value is the LAST snapshot inside it; hours without one stay null (never guessed)", () => {
  const d = lockedHourly([snap(10, 400), snap(50, 390), snap(130, 380)], hours, "locked", "Locked Totes", "now");
  assert.deepEqual(d.hours.map((h) => h.value), [390, null, 380, null]);
  assert.deepEqual(d.hours.map((h) => h.snapshots), [2, 0, 1, 0]);
  assert.equal(d.hours[0].at, "06:50");
});

test("headline facts: latest, change since the first snapshot, peak and lowest hour", () => {
  const d = lockedHourly([snap(10, 400), snap(70, 420), snap(130, 380)], hours, "locked", "Locked Totes", "now");
  assert.equal(d.now.total, 380);
  assert.equal(d.change, -20);
  assert.deepEqual(d.peak, { label: "07-08", value: 420 });
  assert.deepEqual(d.low, { label: "08-09", value: 380 });
  assert.equal(d.snapshotCount, 3);
});

test("no snapshots today: empty facts, no invented numbers", () => {
  const d = lockedHourly([], hours, "locked", "Locked Totes", "now");
  assert.equal(d.now, null);
  assert.equal(d.change, null);
  assert.ok(d.hours.every((h) => h.value == null));
});
