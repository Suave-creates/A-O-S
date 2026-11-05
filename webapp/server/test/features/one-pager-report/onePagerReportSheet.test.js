// Unit tests for server/features/one-pager-report/onePagerReportSheet.js. upsertRowByDate is an
// injected fake - no real Google Sheets API call.

const test = require("node:test");
const assert = require("node:assert/strict");
const { saveReport, buildRow } = require("../../../features/one-pager-report/onePagerReportSheet");

const REPORT = {
  generatedAt: "2026-09-08T12:00:00.000Z",
  reportDate: "2026-09-08",
  lockedTotes: { summary: { sdCount: 2, p0Count: 1, p1Count: 3, p2Count: 5, total: 11 } },
  utilisation: { totals: { totes: 500, cap: 800, qty: 640, util: 0.8 } },
  totesInAsrs: { large: { frame: 100, lens: 200, total: 300 }, small: { frame: 10, lens: 20, total: 30 }, total: { frame: 110, lens: 220, total: 330 } },
  outsideTote: { h12to24: 4, h24plus: 2, total: 6 },
  ccMetrics: { shifts: { ccDone: { A: 1, B: 2, C: 3, Total: 6 }, discrepancies: { A: 1, B: 1, C: 1, Total: 3 }, ccStationsRan: { A: 1, B: 1, C: 1, Total: 3 }, discrepancyStations: { A: 0, B: 1, C: 0, Total: 1 } } },
  compaction: { shifts: { compaction: { A: 0, B: 0, C: 5, Total: 5 }, toteFreed: { A: 0, B: 0, C: 2, Total: 2 } } },
  aisleOccupancy: { occupancy: { average: 80.4 }, large: { average: 85.4 }, short: { average: 74.0 } },
};

test("buildRow(): flattens every section into a self-describing, flat field map", () => {
  const row = buildRow(REPORT);
  assert.equal(row["Locked Total"], 11);
  assert.equal(row["Locked Supervisor Lock"], 2);
  assert.equal(row["Compaction Total"], 5);
  assert.equal(row["CC Done C"], 3);
  assert.equal(row["Totes In ASRS Grand Total"], 330);
  assert.equal(row["Utilisation %"], 80);
  assert.equal(row["Outside Totes Total"], 6);
  assert.equal(row["Aisle Occupancy Avg %"], 80.4);
  assert.equal(row["Generated At"], "2026-09-08T12:00:00.000Z");
});

test("buildRow(): a degraded (null) section comes through as undefined fields, never a fabricated zero", () => {
  const row = buildRow({ generatedAt: "x", reportDate: "2026-09-08" });
  assert.equal(row["Locked Total"], undefined);
  assert.equal(row["Aisle Occupancy Avg %"], undefined);
});

test("saveReport(): calls upsertRowByDate with the spreadsheetId/tabName/date/fields and resolves the row number", async () => {
  let captured;
  const upsertRowByDate = async (args) => {
    captured = args;
    return 7;
  };
  const result = await saveReport(REPORT, { spreadsheetId: "sheet123", upsertRowByDate });
  assert.deepEqual(result, { ok: true, row: 7 });
  assert.equal(captured.spreadsheetId, "sheet123");
  assert.equal(captured.tabName, "One Pager Report");
  assert.equal(captured.date, "2026-09-08");
  assert.equal(captured.fields["Locked Total"], 11);
});

test("saveReport(): falls back to generatedAt's own date when reportDate is missing (an older cached report)", async () => {
  let captured;
  const upsertRowByDate = async (args) => {
    captured = args;
    return 1;
  };
  const report = { ...REPORT, reportDate: undefined, generatedAt: "2026-09-05T03:00:00.000Z" };
  await saveReport(report, { spreadsheetId: "sheet123", upsertRowByDate });
  assert.equal(captured.date, "2026-09-05");
});

test("saveReport(): throws NOT_CONFIGURED when no spreadsheetId is set, never silently no-ops", async () => {
  await assert.rejects(
    saveReport(REPORT, { spreadsheetId: null, upsertRowByDate: async () => 1 }),
    (e) => e.code === "NOT_CONFIGURED"
  );
});

test("saveReport(): a NOT_CONFIGURED error from upsertRowByDate itself (e.g. missing key path) propagates as-is", async () => {
  const upsertRowByDate = async () => {
    const err = new Error("ONE_PAGER_REPORT_SHEET_SERVICE_ACCOUNT_KEY_PATH is not configured");
    err.code = "NOT_CONFIGURED";
    throw err;
  };
  await assert.rejects(saveReport(REPORT, { spreadsheetId: "sheet123", upsertRowByDate }), (e) => e.code === "NOT_CONFIGURED");
});

test("saveReport(): any other upsertRowByDate failure is wrapped with a clear 'Sheet write failed' prefix", async () => {
  const upsertRowByDate = async () => {
    throw new Error("Google Sheets API read range failed (HTTP 403): The caller does not have permission");
  };
  await assert.rejects(saveReport(REPORT, { spreadsheetId: "sheet123", upsertRowByDate }), /Sheet write failed.*permission/);
});
