// Recovers a TRUE UTC epoch-ms value from a Grafana-returned datetime field
// whose raw digits represent this facility's own IST wall-clock time (the
// same quirk server/platform/time/shiftWindows.js's istToParamMs() corrects for on
// already-known calendar components - this applies the identical
// correction to a raw Grafana value instead). Grafana's MSSQL datasource
// marshals a naive, no-timezone datetime column by treating its raw digits
// AS IF they were already UTC; this facility's DB actually stores those
// digits in IST wall-clock time, so treating them as UTC without
// correction reads every timestamp about 5.5h later than it really is.
//
// Mirrors public/js/tracker.js's own parseDateDigits()/parseIstMs() exactly
// - the two must stay in lockstep, since what the operator sees on screen
// and what any backend staleness/age comparison uses must never silently
// disagree. Never guesses: an unparseable value returns null, not 0/NaN
// treated as "very old" or "very fresh".
function parseIstRawDigitsToUtcMs(v) {
  if (v == null || v === "") return null;
  let y, mo, d, h, mi, s;
  if (typeof v === "number" || /^-?\d+$/.test(String(v))) {
    const dt = new Date(Number(v));
    if (Number.isNaN(dt.getTime())) return null;
    // Read the UTC calendar fields back out - Grafana computed this number
    // as Date.UTC(rawDigits) in the first place, so this recovers the
    // original raw digits exactly, never re-interpreting them through
    // whatever timezone this Node process happens to run in.
    y = dt.getUTCFullYear();
    mo = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
    h = dt.getUTCHours();
    mi = dt.getUTCMinutes();
    s = dt.getUTCSeconds();
  } else {
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null; // unrecognized shape - never guessed
    [, y, mo, d, h, mi, s] = m.map(Number);
  }
  return Date.UTC(y, mo - 1, d, h, mi, s) - 5.5 * 3600000;
}

module.exports = { parseIstRawDigitsToUtcMs };
