// Pure unit tests for server/platform/time/shiftWindows.js - ported verbatim from the
// legacy extension's istToParamMs()/shiftWindowsForDate(). No I/O.

const test = require("node:test");
const assert = require("node:assert/strict");
const { istToParamMs, shiftWindowsForDate, hourWindowsForDate, todayIST, todayShiftWindowsIST } = require("../../../platform/time/shiftWindows");

test("shiftWindowsForDate: A/B/C boundaries match the legacy IST shift hours (06:00/14:00/22:00)", () => {
  const w = shiftWindowsForDate("2026-08-20");
  assert.equal(w.A.from, istToParamMs(2026, 8, 20, 6, 0));
  assert.equal(w.A.to, istToParamMs(2026, 8, 20, 14, 0));
  assert.equal(w.B.from, istToParamMs(2026, 8, 20, 14, 0));
  assert.equal(w.B.to, istToParamMs(2026, 8, 20, 22, 0));
  assert.equal(w.C.from, istToParamMs(2026, 8, 20, 22, 0));
});

test("shiftWindowsForDate: Shift C spans into the NEXT day (22:00 on dateStr to 06:00 on dateStr+1)", () => {
  const w = shiftWindowsForDate("2026-08-20");
  assert.equal(w.C.to, istToParamMs(2026, 8, 21, 6, 0));
  assert.ok(w.C.to > w.C.from, "Shift C's end must be after its start");
});

test("shiftWindowsForDate: month/year rollover (day-overflow) is handled correctly", () => {
  const w = shiftWindowsForDate("2026-08-31");
  assert.equal(w.C.to, istToParamMs(2026, 9, 1, 6, 0));
});

test("windows are contiguous and non-overlapping: A.to === B.from, B.to === C.from", () => {
  const w = shiftWindowsForDate("2026-08-20");
  assert.equal(w.A.to, w.B.from);
  assert.equal(w.B.to, w.C.from);
});

test("hourWindowsForDate: each shift has exactly 8 hour windows, Hour 1 first, contiguous with no gaps", () => {
  const h = hourWindowsForDate("2026-08-20");
  for (const code of ["A", "B", "C"]) {
    assert.equal(h[code].length, 8);
    for (let i = 0; i < 7; i++) assert.equal(h[code][i].to, h[code][i + 1].from, `${code}[${i}].to must equal ${code}[${i + 1}].from`);
  }
});

test("hourWindowsForDate: Shift A's hours span exactly 06:00-14:00, matching shiftWindowsForDate's own shift boundaries", () => {
  const h = hourWindowsForDate("2026-08-20");
  const shifts = shiftWindowsForDate("2026-08-20");
  assert.equal(h.A[0].from, shifts.A.from);
  assert.equal(h.A[7].to, shifts.A.to);
});

test("hourWindowsForDate: Shift C's hours correctly roll over into the next day (22:00 -> 06:00 next day), matching shiftWindowsForDate", () => {
  const h = hourWindowsForDate("2026-08-20");
  const shifts = shiftWindowsForDate("2026-08-20");
  assert.equal(h.C[0].from, shifts.C.from);
  assert.equal(h.C[7].to, shifts.C.to);
  // Hour 3 of Shift C (22:00+2h = 00:00) is genuinely on the next calendar day.
  assert.equal(h.C[2].from, istToParamMs(2026, 8, 21, 0, 0));
});

test("hourWindowsForDate: every hour window is exactly 3,600,000ms (one hour) wide", () => {
  const h = hourWindowsForDate("2026-08-20");
  for (const code of ["A", "B", "C"]) {
    for (const w of h[code]) assert.equal(w.to - w.from, 3600000);
  }
});

test("todayIST returns a YYYY-MM-DD string", () => {
  assert.match(todayIST(), /^\d{4}-\d{2}-\d{2}$/);
});

test("todayShiftWindowsIST: dateStr matches todayIST(), windows match shiftWindowsForDate(that date)", () => {
  const { dateStr, windows } = todayShiftWindowsIST();
  assert.equal(dateStr, todayIST());
  assert.deepEqual(windows, shiftWindowsForDate(dateStr));
});
