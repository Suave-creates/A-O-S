// One Pager Report -> formatted .xlsx (2026-09-08, operator-requested: "an
// excel which depicts same to same as the report when downloaded" - the
// flat single-row CSV wasn't it). Mirrors public/js/onePagerReport.js's own
// sheetHtml() section-by-section: same section titles/order, same table
// columns, same "Data unavailable" notes for a degraded section
// (report.sectionErrors) - this is the SAME report, just laid out as real
// Excel tables (top-to-bottom, one per section, rather than the browser's
// CSS grid) instead of HTML.
//
// exceljs (not a hand-rolled XLSX writer - the format is a real ZIP+XML
// structure, not worth reimplementing) is the one new dependency this
// needed; nothing else in this file talks to Excel's file format directly.

const ExcelJS = require("exceljs");

const TITLE_FONT = { bold: true, size: 14 };
const SUBTITLE_FONT = { size: 9, color: { argb: "FF5C6B80" } };
const SECTION_FONT = { bold: true, size: 12 };
const HEADER_FONT = { bold: true, size: 10 };
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F7FA" } };
const UNAVAILABLE_FONT = { italic: true, size: 9, color: { argb: "FFDC2626" } };
const THIN_BORDER = { style: "thin", color: { argb: "FFD7DEE7" } };
const ALL_BORDERS = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

function nf(v) {
  return v == null ? "" : Number(v);
}
function pctFraction(v) {
  return v == null ? "" : Number(v); // already-a-fraction values (e.g. utilisation.util) - formatted as "0.0%" via numFmt, not pre-multiplied
}
function alreadyPct(v) {
  return v == null ? "" : Number(v) / 100; // aisleOccupancy's own average/values are already 0-100 - divide back to a fraction so the SAME "0.0%" numFmt applies uniformly
}

// Writes one bordered table (its own section title row, an optional
// "Data unavailable" note, a header row, and its data rows) starting at
// `startRow`, `startCol`. Returns the row number just after the table
// (including its trailing blank spacer row) - the next section's own
// start row.
function writeSection(ws, startRow, startCol, { title, unavailable, headers, rows, totalCols = [], pctCols = [] }) {
  let r = startRow;
  const width = headers.length;

  const titleCell = ws.getCell(r, startCol);
  titleCell.value = title;
  titleCell.font = SECTION_FONT;
  if (width > 1) ws.mergeCells(r, startCol, r, startCol + width - 1);
  r++;

  if (unavailable) {
    const noteCell = ws.getCell(r, startCol);
    noteCell.value = `⚠ Data unavailable — ${unavailable}`;
    noteCell.font = UNAVAILABLE_FONT;
    if (width > 1) ws.mergeCells(r, startCol, r, startCol + width - 1);
    r++;
  }

  headers.forEach((h, i) => {
    const cell = ws.getCell(r, startCol + i);
    cell.value = h;
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.border = ALL_BORDERS;
  });
  r++;

  for (const row of rows) {
    row.forEach((v, i) => {
      const cell = ws.getCell(r, startCol + i);
      cell.value = v;
      cell.border = ALL_BORDERS;
      if (totalCols.includes(i)) cell.font = { bold: true };
      if (pctCols.includes(i) && typeof v === "number") cell.numFmt = "0.0%";
    });
    r++;
  }

  return r + 1; // one blank spacer row
}

function shiftRow(label, row) {
  const r = row || {};
  return [label, nf(r.A), nf(r.B), nf(r.C), nf(r.Total)];
}

// ASRS Production's own table shape - Department/Shift/Hour1-8/Total, the
// operator's own explicit format (2026-09-10), distinct enough from every
// other section's plain shift-row table (merged Department cells spanning
// 3 shift rows each, plus a single ungrouped "Picking / Overall" row - see
// onePagerReportEngine.js's own pickingOverallRow() for exactly what that
// row means) that it gets its own writer rather than being forced through
// writeSection()'s generic shape.
const ASRS_PRODUCTION_HEADERS = ["Department", "Shift", "Hour 1", "Hour 2", "Hour 3", "Hour 4", "Hour 5", "Hour 6", "Hour 7", "Hour 8", "Total"];
function writeAsrsProductionSection(ws, startRow, { title, unavailable, jit, njit, fr0, bulk, pickingOverall }) {
  let r = startRow;
  const width = ASRS_PRODUCTION_HEADERS.length;

  const titleCell = ws.getCell(r, 1);
  titleCell.value = title;
  titleCell.font = SECTION_FONT;
  ws.mergeCells(r, 1, r, width);
  r++;

  if (unavailable) {
    const noteCell = ws.getCell(r, 1);
    noteCell.value = `⚠ Data unavailable — ${unavailable}`;
    noteCell.font = UNAVAILABLE_FONT;
    ws.mergeCells(r, 1, r, width);
    r++;
  }

  ASRS_PRODUCTION_HEADERS.forEach((h, i) => {
    const cell = ws.getCell(r, 1 + i);
    cell.value = h;
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.border = ALL_BORDERS;
  });
  r++;

  function writeDeptBlock(label, hoursByShift) {
    const blockStartRow = r;
    for (const shiftCode of ["A", "B", "C"]) {
      const hours = (hoursByShift && hoursByShift[shiftCode]) || [];
      const hasData = hours.length === 8;
      const total = hasData ? hours.reduce((s, v) => s + v, 0) : null;
      const rowValues = [label, shiftCode, ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => nf(hours[i])), nf(total)];
      rowValues.forEach((v, i) => {
        const cell = ws.getCell(r, 1 + i);
        cell.value = v;
        cell.border = ALL_BORDERS;
        if (i === width - 1) cell.font = { bold: true };
      });
      r++;
    }
    ws.mergeCells(blockStartRow, 1, blockStartRow + 2, 1); // Department column spans its 3 shift rows
  }

  writeDeptBlock("JIT", jit);
  writeDeptBlock("NJIT", njit);
  writeDeptBlock("FR0", fr0);
  writeDeptBlock("FR0-Bulk (items)", bulk);

  // Picking / Overall - ONE row (not per-shift): the sum of all six
  // department/shift rows above, per hour column - see pickingOverallRow().
  const poHours = (pickingOverall && pickingOverall.hours) || [];
  const poTotal = pickingOverall ? pickingOverall.total : null;
  const poRow = ["Total", "All", ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => nf(poHours[i])), nf(poTotal)];
  poRow.forEach((v, i) => {
    const cell = ws.getCell(r, 1 + i);
    cell.value = v;
    cell.border = ALL_BORDERS;
    cell.font = { bold: true };
  });
  r++;

  // every department added together per shift, hour by hour (a missing department is left out)
  const depts = [jit, njit, fr0, bulk].filter(Boolean);
  for (const code of ["A", "B", "C"]) {
    const per = depts.length ? [0, 1, 2, 3, 4, 5, 6, 7].map((i) => depts.reduce((acc, d) => acc + ((d[code] && d[code][i]) || 0), 0)) : [];
    const sum = per.length ? per.reduce((acc, v) => acc + v, 0) : null;
    ["Total", code, ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => nf(per[i])), nf(sum)].forEach((v, i) => {
      const cell = ws.getCell(r, 1 + i);
      cell.value = v;
      cell.border = ALL_BORDERS;
      if (i === width - 1) cell.font = { bold: true };
    });
    r++;
  }

  return r + 1; // blank spacer row
}

function aisleRow(label, row) {
  const r = row || { values: [], average: null };
  const values = [0, 1, 2, 3, 4, 5].map((i) => alreadyPct(r.values && r.values[i]));
  return [label, ...values, alreadyPct(r.average)];
}

function unavailableReason(report, key) {
  return report.sectionErrors && report.sectionErrors[key];
}

// buildWorkbook(report) -> ExcelJS.Workbook, ready to .xlsx.write(stream).
// Pure with respect to I/O (never writes a file itself) - the route owns
// streaming it to the response.
function buildWorkbook(report) {
  const lt = (report.lockedTotes && report.lockedTotes.summary) || {};
  const ut = (report.utilisation && report.utilisation.totals) || {};
  const tia = report.totesInAsrs || {};
  const ot = report.outsideTote || {};
  const cc = (report.ccMetrics && report.ccMetrics.shifts) || {};
  const cp = (report.compaction && report.compaction.shifts) || {};
  const apHours = (report.asrsProduction && report.asrsProduction.hours) || {};
  const apPickingOverall = report.asrsProduction && report.asrsProduction.pickingOverall;
  const ao = report.aisleOccupancy;
  const caps = report.utilisationCaps || {};

  const wb = new ExcelJS.Workbook();
  wb.creator = "ASRS Intelligence & Automation | AOS";
  wb.created = new Date();
  const ws = wb.addWorksheet("One Pager Report", { views: [{ showGridLines: false }] });

  let r = 1;
  const title = ws.getCell(r, 1);
  title.value = `ASRS Snapshot — ${report.reportDate || ""}`;
  title.font = TITLE_FONT;
  r++;
  const sub = ws.getCell(r, 1);
  sub.value = `Generated ${report.generatedAt || ""}`;
  sub.font = SUBTITLE_FONT;
  r += 2;

  r = writeSection(ws, r, 1, {
    title: "🔒 Current Locked Totes",
    unavailable: unavailableReason(report, "lockedTotes"),
    headers: ["", "Supervisor Lock", "P0 Critical", "P1 High", "P2 Standard", "Total"],
    rows: [["Count", nf(lt.sdCount), nf(lt.p0Count), nf(lt.p1Count), nf(lt.p2Count), nf(lt.total)]],
    totalCols: [5],
  });

  r = writeSection(ws, r, 1, {
    title: "🗜️ Compaction",
    unavailable: unavailableReason(report, "compaction"),
    headers: ["Shift", "A", "B", "C", "Total"],
    rows: [shiftRow("Compaction", cp.compaction), shiftRow("Tote Freed", cp.toteFreed)],
    totalCols: [4],
  });

  r = writeSection(ws, r, 1, {
    title: "🗓️ CC Done / Discrepancies",
    unavailable: unavailableReason(report, "ccMetrics"),
    headers: ["Shift", "A", "B", "C", "Total"],
    rows: [shiftRow("CC Done", cc.ccDone), ...(cc.bermudaTotes ? [shiftRow("Bermuda Totes (all lines SHORT)", cc.bermudaTotes)] : []), ...(cc.purgedTotes ? [shiftRow("Purged Totes (pulled for purge)", cc.purgedTotes)] : []), ...(cc.shortQty ? [shiftRow("Quantity Marked Short (units)", cc.shortQty)] : []), shiftRow("Discrepancies Marked", cc.discrepancies)],
    totalCols: [4],
  });

  r = writeSection(ws, r, 1, {
    title: "🏭 Station Coverage",
    unavailable: unavailableReason(report, "ccMetrics"),
    headers: ["Shift", "A", "B", "C", "Total"],
    rows: [shiftRow("CC Stations Ran", cc.ccStationsRan), shiftRow("Stations Flagged (SHORT)", cc.discrepancyStations)],
    totalCols: [4],
  });

  r = writeSection(ws, r, 1, {
    title: "📦 Totes In ASRS",
    unavailable: unavailableReason(report, "utilisation"),
    headers: ["Totes In ASRS", "Frame", "Lens", "Total"],
    rows: [
      ["Large Tote", nf(tia.large && tia.large.frame), nf(tia.large && tia.large.lens), nf(tia.large && tia.large.total)],
      ["Small Tote", nf(tia.small && tia.small.frame), nf(tia.small && tia.small.lens), nf(tia.small && tia.small.total)],
      ["Total", nf(tia.total && tia.total.frame), nf(tia.total && tia.total.lens), nf(tia.total && tia.total.total)],
    ],
    totalCols: [3],
  });

  r = writeSection(ws, r, 1, {
    title: `📊 Tote Utilisation  (Caps: TL Lens ${nf(caps.largeLens) || "—"} · TL Frame ${nf(caps.largeFrame) || "—"} · TS Lens ${nf(caps.smallLens) || "—"} · TS Frame ${nf(caps.smallFrame) || "—"})`,
    unavailable: unavailableReason(report, "utilisation"),
    headers: ["Totes", "Capacity", "Quantity", "Utilisation"],
    rows: [[nf(ut.totes), nf(ut.cap), nf(ut.qty), pctFraction(ut.util)]],
    totalCols: [3],
    pctCols: [3],
  });

  r = writeSection(ws, r, 1, {
    title: "🚚 Outside Totes  (Outside Tote status only, not Bad Tracker)",
    unavailable: unavailableReason(report, "outsideTote"),
    headers: ["12 - 24 Hours", "Above 24 Hours", "Total"],
    rows: [[nf(ot.h12to24), nf(ot.h24plus), nf(ot.total)]],
    totalCols: [2],
  });

  r = writeAsrsProductionSection(ws, r, {
    title: "📦 ASRS Production (Completed Orders)",
    unavailable: unavailableReason(report, "asrsProduction"),
    jit: apHours.jit,
    njit: apHours.njit,
    fr0: apHours.fr0,
    bulk: apHours.bulk,
    pickingOverall: apPickingOverall,
  });

  r = writeSection(ws, r, 1, {
    title: "📶 Aisle Occupancy",
    unavailable: unavailableReason(report, "aisleOccupancy"),
    headers: ["Aisle", "1", "2", "3", "4", "5", "6", "Average"],
    rows: [
      aisleRow("Aisle Occupancy", ao && ao.occupancy),
      aisleRow("Large", ao && ao.large),
      aisleRow("Short", ao && ao.short),
    ],
    totalCols: [7],
    pctCols: [1, 2, 3, 4, 5, 6, 7],
  });

  ws.columns.forEach((col, i) => {
    col.width = i === 0 ? 24 : 14;
  });

  return wb;
}

// ── Bulk (day-range) workbook (2026-09-14) ──────────────────────────────
// Same title/section/header/border conventions as buildWorkbook() above,
// just fed onePagerReportBulkEngine.js's own {days, total, average} table
// shape instead of a single day's row - one row per day (calendar order),
// then a bolded/shaded TOTAL row and AVERAGE row at the end of each table,
// exactly matching the operator's own "in the last I want total and avg" -
// column-wise sum and column-wise mean across whichever days actually had
// data (see that file's own null-handling comment).

const BULK_SHIFT_HEADERS = ["Date", "A", "B", "C", "Total"];
function writeBulkShiftSection(ws, startRow, { title, table }) {
  let r = startRow;
  const width = BULK_SHIFT_HEADERS.length;

  const titleCell = ws.getCell(r, 1);
  titleCell.value = title;
  titleCell.font = SECTION_FONT;
  ws.mergeCells(r, 1, r, width);
  r++;

  BULK_SHIFT_HEADERS.forEach((h, i) => {
    const cell = ws.getCell(r, 1 + i);
    cell.value = h;
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.border = ALL_BORDERS;
  });
  r++;

  for (const day of table.days) {
    const row = [day.dateStr, nf(day.A), nf(day.B), nf(day.C), nf(day.Total)];
    row.forEach((v, i) => {
      const cell = ws.getCell(r, 1 + i);
      cell.value = v;
      cell.border = ALL_BORDERS;
      if (i === width - 1) cell.font = { bold: true };
    });
    r++;
  }

  for (const summary of [table.total, table.average]) {
    const row = [summary.dateStr, nf(summary.A), nf(summary.B), nf(summary.C), nf(summary.Total)];
    row.forEach((v, i) => {
      const cell = ws.getCell(r, 1 + i);
      cell.value = v;
      cell.border = ALL_BORDERS;
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
    });
    r++;
  }

  return r + 1; // blank spacer row
}

const BULK_HOURS_HEADERS = ["Date", "Hour 1", "Hour 2", "Hour 3", "Hour 4", "Hour 5", "Hour 6", "Hour 7", "Hour 8", "Total"];
function writeBulkHoursSection(ws, startRow, { title, table }) {
  let r = startRow;
  const width = BULK_HOURS_HEADERS.length;

  const titleCell = ws.getCell(r, 1);
  titleCell.value = title;
  titleCell.font = SECTION_FONT;
  ws.mergeCells(r, 1, r, width);
  r++;

  BULK_HOURS_HEADERS.forEach((h, i) => {
    const cell = ws.getCell(r, 1 + i);
    cell.value = h;
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
    cell.border = ALL_BORDERS;
  });
  r++;

  for (const day of table.days) {
    const row = [day.dateStr, ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => nf(day.hours[i])), nf(day.total)];
    row.forEach((v, i) => {
      const cell = ws.getCell(r, 1 + i);
      cell.value = v;
      cell.border = ALL_BORDERS;
      if (i === width - 1) cell.font = { bold: true };
    });
    r++;
  }

  for (const summary of [table.total, table.average]) {
    const row = [summary.dateStr, ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => nf(summary.hours[i])), nf(summary.total)];
    row.forEach((v, i) => {
      const cell = ws.getCell(r, 1 + i);
      cell.value = v;
      cell.border = ALL_BORDERS;
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
    });
    r++;
  }

  return r + 1; // blank spacer row
}

// buildBulkWorkbook(bulkReport) -> ExcelJS.Workbook, ready to .xlsx.write(stream).
// bulkReport is onePagerReportBulkEngine.js's own currentReport shape
// ({startDate, endDate, asrsProductionBulk, ccMetricsBulk, compactionBulk}).
function buildBulkWorkbook(bulkReport) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ASRS Intelligence & Automation | AOS";
  wb.created = new Date();
  const ws = wb.addWorksheet("Bulk Report", { views: [{ showGridLines: false }] });

  let r = 1;
  const title = ws.getCell(r, 1);
  title.value = `ASRS Bulk Report — ${bulkReport.startDate || ""} to ${bulkReport.endDate || ""} (${bulkReport.dayCount || 0} days)`;
  title.font = TITLE_FONT;
  r++;
  const sub = ws.getCell(r, 1);
  sub.value = `Generated ${bulkReport.generatedAt || ""}`;
  sub.font = SUBTITLE_FONT;
  r += 2;

  const apSectionTitle = ws.getCell(r, 1);
  apSectionTitle.value = "📦 ASRS Production (orders; FR0-Bulk in items) — day-wise";
  apSectionTitle.font = { bold: true, size: 13 };
  r += 2;
  for (const g of bulkReport.asrsProductionBulk.groups) {
    r = writeBulkHoursSection(ws, r, { title: `${g.label} — Shift ${g.shift}`, table: g.table });
  }
  r = writeBulkHoursSection(ws, r, { title: "Total — JIT + NJIT + FR0 + FR0-Bulk", table: bulkReport.asrsProductionBulk.pickingOverall });

  const ccSectionTitle = ws.getCell(r, 1);
  ccSectionTitle.value = "🗓️ CC Metrics / Station Coverage — day-wise";
  ccSectionTitle.font = { bold: true, size: 13 };
  r += 2;
  for (const m of bulkReport.ccMetricsBulk) {
    r = writeBulkShiftSection(ws, r, { title: m.label, table: m.table });
  }

  const cpSectionTitle = ws.getCell(r, 1);
  cpSectionTitle.value = "🗜️ Compaction / Tote Freed — day-wise";
  cpSectionTitle.font = { bold: true, size: 13 };
  r += 2;
  for (const m of bulkReport.compactionBulk) {
    r = writeBulkShiftSection(ws, r, { title: m.label, table: m.table });
  }

  ws.columns.forEach((col, i) => {
    col.width = i === 0 ? 14 : 12;
  });

  return wb;
}

module.exports = { buildWorkbook, buildBulkWorkbook };
