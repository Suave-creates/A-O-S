// IST A/B/C shift window computation - ported verbatim (not reinvented) from
// the legacy extension's istToParamMs()/shiftWindowsForDate()
// (background/index.js:608-618), used by the legacy ASRS Daily Report to
// bound its Grafana CC Discrepancy/Stock Check queries. Same shift
// boundaries: A 06:00-14:00, B 14:00-22:00, C 22:00(date)-06:00(date+1), IST.
//
// The Dashboard is live-only (no report-date picker - see the Dashboard
// design decision to drop Historical/Manual distinctions), so this module
// only ever computes windows for TODAY's IST date, never an operator-picked
// date - todayIST()/todayShiftWindowsIST() are the only entry points a
// Dashboard caller needs.

function istToParamMs(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, h, mi, 0) - 5.5 * 3600000;
}

function shiftWindowsForDate(dateStr) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const nextDay = new Date(Date.UTC(y, mo - 1, d + 1)); // JS normalizes day-overflow automatically
  const ny = nextDay.getUTCFullYear(), nmo = nextDay.getUTCMonth() + 1, nd = nextDay.getUTCDate();
  return {
    A: { from: istToParamMs(y, mo, d, 6, 0), to: istToParamMs(y, mo, d, 14, 0) },
    B: { from: istToParamMs(y, mo, d, 14, 0), to: istToParamMs(y, mo, d, 22, 0) },
    C: { from: istToParamMs(y, mo, d, 22, 0), to: istToParamMs(ny, nmo, nd, 6, 0) },
  };
}

// Per-hour (not per-shift) windows for a site day - {A:[8], B:[8], C:[8]},
// each entry {from,to} in ms, Hour 1 first. Mirrors the ASRS Production
// Report extension's own buildHourWindows() (asrs-production-report/report.js) -
// same site day (06:00->06:00 next day, IST), same 8-hour-per-shift split.
// istToParamMs's own Date.UTC() call normalizes an hour argument past 23
// into the next day automatically (confirmed - same mechanism
// shiftWindowsForDate's own C-shift end already relies on), so Shift C's
// hours 22..29 (i.e. 22:00 through 05:00 the next day) fall out correctly
// with no separate day-rollover branch needed here.
const SHIFT_START_HOUR = { A: 6, B: 14, C: 22 };
function hourWindowsForDate(dateStr) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const result = {};
  for (const code of ["A", "B", "C"]) {
    const startHour = SHIFT_START_HOUR[code];
    const hours = [];
    for (let h = 0; h < 8; h++) {
      hours.push({ from: istToParamMs(y, mo, d, startHour + h, 0), to: istToParamMs(y, mo, d, startHour + h + 1, 0) });
    }
    result[code] = hours;
  }
  return result;
}

// "Today" per IST wall clock - mirrors report.js's own yesterdayIST() pattern
// (Intl-based, correct regardless of the server's OS timezone) but for
// TODAY, since the Dashboard always shows the current date's shifts-so-far,
// never a picked historical date.
function todayIST() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

function todayShiftWindowsIST() {
  const dateStr = todayIST();
  return { dateStr, windows: shiftWindowsForDate(dateStr) };
}

// The current site day as YYYY-MM-DD (IST). Between 00:00 and 06:00 IST that is
// the previous calendar date - shift C of that day is still running.
function siteDayIST(now = Date.now()) {
  const ist = new Date(now + 5.5 * 3600000 - 6 * 3600000); // shift the clock so the site day starts at 00:00
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

module.exports = { istToParamMs, shiftWindowsForDate, hourWindowsForDate, todayIST, todayShiftWindowsIST, siteDayIST };
