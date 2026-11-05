// One Pager Report -> Google Sheet (2026-09-08, operator-approved: a
// dedicated new Sheet, written via the Sheets API + a service account -
// see server/integrations/google/googleSheetsClient.js's own header comment for why this
// isn't an Apps Script Web App: the Lenskart Workspace has no true
// "Anyone" access option for a Web App, so an unauthenticated server-side
// call always redirects to a Google sign-in page instead of executing. See
// server/apps-script/SETUP.md for how to create the service account, share
// the Sheet with it, and configure the two env vars this file reads.
//
// One row per calendar date - a same-day "Save to Sheet" click OVERWRITES
// that date's existing row rather than duplicating it, per explicit
// operator instruction; googleSheetsClient.upsertRowByDate() is what
// actually implements the overwrite-by-date lookup (this file only ever
// builds the field values).
//
// Self-describing columns, deliberately: the field list below is not
// hardcoded anywhere else. The Sheet's own header row is bootstrapped from
// whatever field names arrive in the FIRST write (insertion order, "Date"
// always column A) and every write after that is matched to a column by
// header TEXT, appending a new column for any name it hasn't seen before -
// so adding/renaming/removing a field here never needs a matching manual
// edit anywhere.

const config = require("../../config");
const googleSheetsClient = require("../../integrations/google/googleSheetsClient");

function fmtPct(fraction) {
  return fraction == null ? null : Number((Number(fraction) * 100).toFixed(1));
}

// Flattens the report into { "Column Label": value, ... }. Every value is a
// straight passthrough of what onePagerReportEngine.js already computed -
// nothing re-derived, nothing fabricated for a section that degraded (see
// report.sectionErrors) - those fields simply come through as null/undefined
// here, which the Apps Script writes as a blank cell, never a fake zero.
function buildRow(report) {
  const lt = (report.lockedTotes && report.lockedTotes.summary) || {};
  const ut = (report.utilisation && report.utilisation.totals) || {};
  const tia = report.totesInAsrs || {};
  const ot = report.outsideTote || {};
  const cc = (report.ccMetrics && report.ccMetrics.shifts) || {};
  const cp = (report.compaction && report.compaction.shifts) || {};
  const ao = report.aisleOccupancy || {};

  function shiftFields(label, row) {
    return {
      [`${label} A`]: row && row.A,
      [`${label} B`]: row && row.B,
      [`${label} C`]: row && row.C,
      [`${label} Total`]: row && row.Total,
    };
  }

  return {
    "Locked Supervisor Lock": lt.sdCount,
    "Locked P0": lt.p0Count,
    "Locked P1": lt.p1Count,
    "Locked P2": lt.p2Count,
    "Locked Total": lt.total,
    ...shiftFields("Compaction", cp.compaction),
    ...shiftFields("Tote Freed", cp.toteFreed),
    ...shiftFields("CC Done", cc.ccDone),
    ...(cc.bermudaTotes ? shiftFields("Bermuda Totes", cc.bermudaTotes) : {}),
    ...(cc.shortQty ? shiftFields("Qty Marked Short", cc.shortQty) : {}),
    ...shiftFields("Discrepancies Marked", cc.discrepancies),
    ...shiftFields("Stations Ran", cc.ccStationsRan),
    ...shiftFields("Stations Flagged SHORT", cc.discrepancyStations),
    "Totes In ASRS Large Frame": tia.large && tia.large.frame,
    "Totes In ASRS Large Lens": tia.large && tia.large.lens,
    "Totes In ASRS Large Total": tia.large && tia.large.total,
    "Totes In ASRS Small Frame": tia.small && tia.small.frame,
    "Totes In ASRS Small Lens": tia.small && tia.small.lens,
    "Totes In ASRS Small Total": tia.small && tia.small.total,
    "Totes In ASRS Grand Total": tia.total && tia.total.total,
    "Utilisation Totes": ut.totes,
    "Utilisation Capacity": ut.cap,
    "Utilisation Qty": ut.qty,
    "Utilisation %": fmtPct(ut.util),
    "Outside Totes 12-24 Hours": ot.h12to24,
    "Outside Totes Above 24 Hours": ot.h24plus,
    "Outside Totes Total": ot.total,
    "Aisle Occupancy Avg %": ao.occupancy && ao.occupancy.average,
    "Aisle Occupancy Large Avg %": ao.large && ao.large.average,
    "Aisle Occupancy Short Avg %": ao.short && ao.short.average,
    "Generated At": report.generatedAt,
  };
}

const DEFAULT_TAB_NAME = "One Pager Report";

async function saveReport(
  report,
  {
    spreadsheetId = config.onePagerReportSheetSpreadsheetId,
    tabName = DEFAULT_TAB_NAME,
    upsertRowByDate = googleSheetsClient.upsertRowByDate,
  } = {}
) {
  if (!spreadsheetId) {
    const err = new Error("ONE_PAGER_REPORT_SHEET_SPREADSHEET_ID is not configured - ask an admin to set it before saving to a Sheet");
    err.code = "NOT_CONFIGURED";
    throw err;
  }

  // reportDate is present for every report generated after the "Report
  // Date" picker was added; falls back to generatedAt's own date for any
  // older cached report that predates it - never sends a blank date, which
  // would break the per-date overwrite lookup.
  const date = report.reportDate || (report.generatedAt || "").slice(0, 10);

  try {
    const row = await upsertRowByDate({ spreadsheetId, tabName, date, fields: buildRow(report) });
    return { ok: true, row };
  } catch (e) {
    if (e.code === "NOT_CONFIGURED") throw e;
    throw new Error(`Sheet write failed: ${e.message}`);
  }
}

module.exports = { saveReport, buildRow };
