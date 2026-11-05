// Cycle-count (CC) shift metrics. Shared by the live Dashboard and the One Pager
// Report (via dashboardMetrics.js), so both always agree.
//
// Definitions (operator-confirmed 2026-10-13):
//   - A tote is CHECKED when it appears in the stock-check rows (deduped to its BASE
//     tote id - a partition suffix like "-2" is the same physical tote).
//   - BERMUDA tote: its latest check marked EVERY line SHORT. These are not real
//     cycle counts - the tote's contents were not found - so they are separated out.
//   - PURGED tote: called through the Manual Tote Puller with the Purge toggle on, and Quadron then showed no
//     inventory for it (see stockCheck.js) - space freed on purpose. Taken out of Bermuda and CC Done.
//   - CC DONE (true): checked totes that are neither Bermuda nor Purged, i.e. the cycle count was
//     done properly (at least one line found).
//   - QUANTITY MARKED SHORT: the units on the SHORT lines of each tote's latest check (summed;
//     a re-checked tote is counted once, from its latest check), Purged totes left out - their units are
//     reported on their own (purgedShortQty). Also reported for Bermuda totes alone.
//   - Discrepancies Marked / Stations Flagged: SHORT-type verification events only
//     (ALRIGHT events are a clean check, not a discrepancy).
// A tote re-checked later is judged by its LATEST check (rows of one check share the
// same create_time), so a Bermuda tote that is counted properly afterwards becomes a
// proper CC Done.

const { classifyChecks } = require("../../platform/domain/stockCheck");

function ccMetricsFor(discRows, stockRows, purgeMarks = {}) {
  const shortDisc = (discRows || []).filter((r) => r.discrepancyType === "SHORT");
  const checks = classifyChecks(stockRows, purgeMarks);
  let bermuda = 0;
  let purged = 0;
  let shortQty = 0;
  let bermudaShortQty = 0;
  let purgedShortQty = 0;
  for (const c of checks.values()) {
    if (c.purged) { purged += 1; purgedShortQty += c.shortQty; continue; }
    shortQty += c.shortQty;
    if (c.bermuda) { bermuda += 1; bermudaShortQty += c.shortQty; }
  }
  return {
    discrepancies: shortDisc.length,
    ccDone: checks.size - bermuda - purged, // true CC Done
    bermudaTotes: bermuda,
    purgedTotes: purged,
    ccChecked: checks.size, // every distinct tote checked (CC Done + Bermuda + Purged)
    shortQty, // units marked short across checked totes, Purged ones excluded
    bermudaShortQty, // ...of which in Bermuda totes
    purgedShortQty, // units marked short in Purged totes
    ccStationsRan: new Set((stockRows || []).map((r) => r.station).filter(Boolean)).size,
    discrepancyStations: new Set(shortDisc.map((r) => r.station).filter(Boolean)).size,
  };
}

// combineShifts({A:{discRows,stockRows}, B:{...}, C:{...}}) -> the A/B/C/Total shape
// for every metric at once.
function combineShifts(windowRows, purgeMarks = {}) {
  const mA = ccMetricsFor(windowRows.A.discRows, windowRows.A.stockRows, purgeMarks);
  const mB = ccMetricsFor(windowRows.B.discRows, windowRows.B.stockRows, purgeMarks);
  const mC = ccMetricsFor(windowRows.C.discRows, windowRows.C.stockRows, purgeMarks);
  const combine = (key) => ({ A: mA[key], B: mB[key], C: mC[key], Total: mA[key] + mB[key] + mC[key] });
  return {
    ccDone: combine("ccDone"),
    bermudaTotes: combine("bermudaTotes"),
    purgedTotes: combine("purgedTotes"),
    ccChecked: combine("ccChecked"),
    shortQty: combine("shortQty"),
    bermudaShortQty: combine("bermudaShortQty"),
    purgedShortQty: combine("purgedShortQty"),
    discrepancies: combine("discrepancies"),
    ccStationsRan: combine("ccStationsRan"),
    discrepancyStations: combine("discrepancyStations"),
  };
}

module.exports = { ccMetricsFor, combineShifts, classifyChecks };
