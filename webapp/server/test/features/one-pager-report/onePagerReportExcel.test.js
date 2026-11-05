// Unit tests for server/features/one-pager-report/onePagerReportExcel.js. Row numbers aren't
// hardcoded - sections are located by their own title text, same as a
// human opening the file would find them, so the tests stay valid if a
// section is reordered/added.

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildWorkbook } = require("../../../features/one-pager-report/onePagerReportExcel");

const REPORT = {
  generatedAt: "2026-09-08T12:00:00.000Z",
  reportDate: "2026-09-08",
  lockedTotes: { summary: { sdCount: 2, p0Count: 1, p1Count: 3, p2Count: 5, total: 11 } },
  utilisation: { totals: { totes: 500, cap: 800, qty: 640, util: 0.8 } },
  utilisationCaps: { largeLens: 300, largeFrame: 200, smallLens: 200, smallFrame: 100 },
  totesInAsrs: { large: { frame: 100, lens: 200, total: 300 }, small: { frame: 10, lens: 20, total: 30 }, total: { frame: 110, lens: 220, total: 330 } },
  outsideTote: { h12to24: 4, h24plus: 2, total: 6 },
  ccMetrics: { shifts: { ccDone: { A: 1, B: 2, C: 3, Total: 6 }, discrepancies: { A: 1, B: 1, C: 1, Total: 3 }, ccStationsRan: { A: 1, B: 1, C: 1, Total: 3 }, discrepancyStations: { A: 0, B: 1, C: 0, Total: 1 } } },
  compaction: { shifts: { compaction: { A: 0, B: 0, C: 5, Total: 5 }, toteFreed: { A: 0, B: 0, C: 2, Total: 2 } } },
  // Real operator-supplied reference numbers (2026-09-10).
  asrsProduction: {
    hours: {
      jit: { A: [87, 228, 261, 207, 179, 155, 253, 167], B: [207, 213, 190, 130, 173, 101, 151, 105], C: [142, 167, 163, 178, 405, 457, 372, 129] },
      njit: { A: [897, 1150, 1204, 1144, 1230, 1189, 1211, 1067], B: [876, 715, 833, 958, 1026, 945, 1080, 929], C: [893, 755, 915, 694, 1280, 1945, 1679, 1206] },
    },
    pickingOverall: { hours: [3102, 3228, 3566, 3311, 4293, 4792, 4746, 3603], total: 30641 },
  },
  aisleOccupancy: {
    occupancy: { values: [70, 75, 80, 85, 90, 82], average: 80.4 },
    large: { values: [72, 76, 81, 86, 91, 83], average: 81.5 },
    short: { values: [10, 12, 8, 9, 11, 14], average: 10.7 },
  },
  sectionErrors: {},
};

function findRow(ws, predicate) {
  for (let r = 1; r <= ws.rowCount; r++) {
    const v = ws.getCell(r, 1).value;
    if (predicate(v)) return r;
  }
  throw new Error("row not found");
}

function rowValues(ws, r, width) {
  const out = [];
  for (let c = 1; c <= width; c++) out.push(ws.getCell(r, c).value);
  return out;
}

test("buildWorkbook(): produces a single 'One Pager Report' worksheet", () => {
  const wb = buildWorkbook(REPORT);
  assert.equal(wb.worksheets.length, 1);
  assert.equal(wb.worksheets[0].name, "One Pager Report");
});

test("buildWorkbook(): Current Locked Totes section header + data row match the report", () => {
  const ws = buildWorkbook(REPORT).worksheets[0];
  const titleRow = findRow(ws, (v) => typeof v === "string" && v.includes("Current Locked Totes"));
  assert.deepEqual(rowValues(ws, titleRow + 1, 6), ["", "Supervisor Lock", "P0 Critical", "P1 High", "P2 Standard", "Total"]);
  assert.deepEqual(rowValues(ws, titleRow + 2, 6), ["Count", 2, 1, 3, 5, 11]);
});

test("buildWorkbook(): Totes In ASRS section carries Large/Small/Total rows", () => {
  const ws = buildWorkbook(REPORT).worksheets[0];
  const titleRow = findRow(ws, (v) => typeof v === "string" && v.includes("Totes In ASRS"));
  assert.deepEqual(rowValues(ws, titleRow + 2, 4), ["Large Tote", 100, 200, 300]);
  assert.deepEqual(rowValues(ws, titleRow + 3, 4), ["Small Tote", 10, 20, 30]);
  assert.deepEqual(rowValues(ws, titleRow + 4, 4), ["Total", 110, 220, 330]);
});

test("buildWorkbook(): ASRS Production section is the Department/Shift/Hour1-8/Total table, matching the operator's own reference numbers exactly", () => {
  const ws = buildWorkbook(REPORT).worksheets[0];
  const titleRow = findRow(ws, (v) => typeof v === "string" && v.includes("ASRS Production"));
  assert.deepEqual(rowValues(ws, titleRow + 1, 11), ["Department", "Shift", "Hour 1", "Hour 2", "Hour 3", "Hour 4", "Hour 5", "Hour 6", "Hour 7", "Hour 8", "Total"]);
  assert.deepEqual(rowValues(ws, titleRow + 2, 11), ["JIT", "A", 87, 228, 261, 207, 179, 155, 253, 167, 1537]);
  assert.deepEqual(rowValues(ws, titleRow + 3, 11), ["JIT", "B", 207, 213, 190, 130, 173, 101, 151, 105, 1270]);
  assert.deepEqual(rowValues(ws, titleRow + 4, 11), ["JIT", "C", 142, 167, 163, 178, 405, 457, 372, 129, 2013]);
  assert.deepEqual(rowValues(ws, titleRow + 5, 11), ["NJIT", "A", 897, 1150, 1204, 1144, 1230, 1189, 1211, 1067, 9092]);
  assert.deepEqual(rowValues(ws, titleRow + 6, 11), ["NJIT", "B", 876, 715, 833, 958, 1026, 945, 1080, 929, 7362]);
  assert.deepEqual(rowValues(ws, titleRow + 7, 11), ["NJIT", "C", 893, 755, 915, 694, 1280, 1945, 1679, 1206, 9367]);
  // FR0 and FR0-Bulk (items) blocks follow; this fixture has no data for them, so their cells stay blank
  assert.deepEqual(rowValues(ws, titleRow + 8, 11), ["FR0", "A", "", "", "", "", "", "", "", "", ""]);
  assert.deepEqual(rowValues(ws, titleRow + 11, 11), ["FR0-Bulk (items)", "A", "", "", "", "", "", "", "", "", ""]);
  assert.deepEqual(rowValues(ws, titleRow + 14, 11), ["Total", "All", 3102, 3228, 3566, 3311, 4293, 4792, 4746, 3603, 30641]);
  // then every department added per shift: JIT A + NJIT A, hour by hour
  assert.deepEqual(rowValues(ws, titleRow + 15, 11), ["Total", "A", 984, 1378, 1465, 1351, 1409, 1344, 1464, 1234, 10629]);
  assert.deepEqual(rowValues(ws, titleRow + 17, 11)[10], 2013 + 9367);
});

test("buildWorkbook(): ASRS Production's Department column is merged across each department's own 3 shift rows", () => {
  const ws = buildWorkbook(REPORT).worksheets[0];
  const titleRow = findRow(ws, (v) => typeof v === "string" && v.includes("ASRS Production"));
  const jitMerge = ws.getCell(titleRow + 2, 1).master;
  assert.equal(ws.getCell(titleRow + 3, 1).master, jitMerge);
  assert.equal(ws.getCell(titleRow + 4, 1).master, jitMerge);
  const njitMerge = ws.getCell(titleRow + 5, 1).master;
  assert.notEqual(njitMerge, jitMerge);
  assert.equal(ws.getCell(titleRow + 6, 1).master, njitMerge);
  assert.equal(ws.getCell(titleRow + 7, 1).master, njitMerge);
});

test("buildWorkbook(): ASRS Production degrades to blank Hour/Total cells (never a fabricated zero) when the section failed", () => {
  const report = { ...REPORT, sectionErrors: { asrsProduction: "no runtime" }, asrsProduction: null };
  const ws = buildWorkbook(report).worksheets[0];
  const titleRow = findRow(ws, (v) => typeof v === "string" && v.includes("ASRS Production"));
  assert.match(ws.getCell(titleRow + 1, 1).value, /Data unavailable.*no runtime/);
  assert.deepEqual(rowValues(ws, titleRow + 3, 11), ["JIT", "A", "", "", "", "", "", "", "", "", ""]);
  assert.deepEqual(rowValues(ws, titleRow + 15, 11), ["Total", "All", "", "", "", "", "", "", "", "", ""]);
});

test("buildWorkbook(): Tote Utilisation section header names the active caps and formats Utilisation as a percentage", () => {
  const ws = buildWorkbook(REPORT).worksheets[0];
  const titleRow = findRow(ws, (v) => typeof v === "string" && v.includes("Tote Utilisation"));
  const title = ws.getCell(titleRow, 1).value;
  assert.match(title, /TL Lens 300/);
  assert.match(title, /TS Frame 100/);
  assert.deepEqual(rowValues(ws, titleRow + 2, 4), [500, 800, 640, 0.8]);
  assert.equal(ws.getCell(titleRow + 2, 4).numFmt, "0.0%");
});

test("buildWorkbook(): Aisle Occupancy rows are converted from already-0-100 values back to 0-1 fractions", () => {
  const ws = buildWorkbook(REPORT).worksheets[0];
  const titleRow = findRow(ws, (v) => typeof v === "string" && v.includes("Aisle Occupancy"));
  const dataRow = rowValues(ws, titleRow + 2, 8);
  assert.equal(dataRow[0], "Aisle Occupancy");
  assert.equal(dataRow[1], 0.7);
  assert.equal(dataRow[7], 0.804);
});

test("buildWorkbook(): a degraded section shows a 'Data unavailable' note and shifts its own table down by one row", () => {
  const report = { ...REPORT, sectionErrors: { outsideTote: "runtime offline" } };
  const ws = buildWorkbook(report).worksheets[0];
  const titleRow = findRow(ws, (v) => typeof v === "string" && v.includes("Outside Totes"));
  const noteCell = ws.getCell(titleRow + 1, 1).value;
  assert.match(noteCell, /Data unavailable.*runtime offline/);
  assert.deepEqual(rowValues(ws, titleRow + 2, 3), ["12 - 24 Hours", "Above 24 Hours", "Total"]);
});

test("buildWorkbook(): a missing/degraded field renders as a blank cell, never a fabricated zero", () => {
  const ws = buildWorkbook({ generatedAt: "x", reportDate: "2026-09-08", sectionErrors: {} }).worksheets[0];
  const titleRow = findRow(ws, (v) => typeof v === "string" && v.includes("Current Locked Totes"));
  assert.deepEqual(rowValues(ws, titleRow + 2, 6), ["Count", "", "", "", "", ""]);
});
