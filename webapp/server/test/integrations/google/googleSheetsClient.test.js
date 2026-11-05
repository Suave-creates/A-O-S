// Unit tests for server/integrations/google/googleSheetsClient.js. `client` (google-auth-
// library's own authorized-request object) is a fake in-memory sheet -
// no real Google auth, no real network call. Only upsertRowByDate() and
// colLetter() are exercised here; getAuth()/the real HTTP calls are
// exactly the thin, hard-to-usefully-unit-test parts google-auth-library
// itself already covers.

const test = require("node:test");
const assert = require("node:assert/strict");
const { upsertRowByDate, colLetter } = require("../../../integrations/google/googleSheetsClient");

test("colLetter(): converts 1-based column numbers to spreadsheet letters", () => {
  assert.equal(colLetter(1), "A");
  assert.equal(colLetter(26), "Z");
  assert.equal(colLetter(27), "AA");
  assert.equal(colLetter(52), "AZ");
  assert.equal(colLetter(53), "BA");
});

// A minimal in-memory stand-in for one spreadsheet's one tab - just enough
// of the Sheets API's own URL/verb shapes for upsertRowByDate() to drive
// correctly. `grid` is a plain 2D array of cell values, row 0 = headers.
function makeFakeClient({ tabExists = true, grid = [] } = {}) {
  const state = { tabExists, grid: grid.map((r) => r.slice()) };
  const calls = [];

  function colRangeToIndices(a1) {
    // Only ever parses the shapes this file itself generates: "1:1",
    // "A1", "A1:C1", "B2:B", "A5:C5" - never a general A1-notation parser.
    const m = /^([A-Z]*)(\d*):?([A-Z]*)(\d*)$/.exec(a1);
    const colToNum = (s) => (s ? [...s].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) : null);
    return { c1: colToNum(m[1]), r1: m[2] ? Number(m[2]) : null, c2: colToNum(m[3]) || colToNum(m[1]), r2: m[4] ? Number(m[4]) : null };
  }

  async function request({ url, method = "GET", data }) {
    calls.push({ url, method, data });

    if (url.includes("?fields=sheets.properties.title")) {
      return { data: { sheets: state.tabExists ? [{ properties: { title: "One Pager Report" } }] : [] } };
    }
    if (url.endsWith(":batchUpdate")) {
      state.tabExists = true;
      return { data: {} };
    }
    if (url.includes(":append")) {
      const row = data.values[0];
      state.grid.push(row);
      const rowNum = state.grid.length; // 1-based, matches a real sheet
      return { data: { updates: { updatedRange: `'One Pager Report'!A${rowNum}:${colLetter(row.length)}${rowNum}` } } };
    }
    if (method === "PUT") {
      const range = decodeURIComponent(url.split("/values/")[1].split("?")[0]);
      const a1 = range.split("!")[1];
      const { c1, r1, r2 } = colRangeToIndices(a1);
      const startRow = r1 - 1;
      const endRow = (r2 || r1) - 1;
      for (let r = startRow, i = 0; r <= endRow; r++, i++) {
        while (state.grid.length <= r) state.grid.push([]);
        const rowValues = data.values[i];
        for (let c = 0; c < rowValues.length; c++) state.grid[r][c1 - 1 + c] = rowValues[c];
      }
      return { data: {} };
    }
    // GET values
    const range = decodeURIComponent(url.split("/values/")[1]);
    const a1 = range.split("!")[1];
    const { c1, r1, c2, r2 } = colRangeToIndices(a1);
    const startRow = (r1 || 1) - 1;
    const endRow = (r2 || state.grid.length) - 1;
    // No column letters at all (e.g. "1:1") means "the whole row", not
    // zero columns - mirrors the real Sheets API's own A1-notation rules.
    const widestRow = Math.max(1, ...state.grid.map((r) => r.length));
    const colStart = c1 || 1;
    const colEnd = c2 || c1 || widestRow;
    const values = [];
    for (let r = startRow; r <= endRow && r < state.grid.length; r++) {
      const row = state.grid[r] || [];
      const slice = [];
      for (let c = colStart - 1; c <= colEnd - 1; c++) slice.push(row[c] === undefined ? "" : row[c]);
      while (slice.length && slice[slice.length - 1] === "") slice.pop(); // real Sheets API never pads trailing empties
      values.push(slice);
    }
    return { data: { values } };
  }

  return { request, state, calls };
}

test("upsertRowByDate(): on a brand-new tab, bootstraps the Date header and appends the first row", async () => {
  const client = makeFakeClient({ tabExists: false, grid: [] });
  const row = await upsertRowByDate({ spreadsheetId: "s1", tabName: "One Pager Report", date: "2026-09-08", fields: { "Locked Total": 11 }, client });
  assert.equal(row, 2);
  assert.deepEqual(client.state.grid[0], ["Date", "Locked Total"]);
  assert.deepEqual(client.state.grid[1], ["2026-09-08", 11]);
});

test("upsertRowByDate(): a field name not already in the header gets appended as a new column, existing ones untouched", async () => {
  const client = makeFakeClient({ grid: [["Date", "Locked Total"], ["2026-09-07", 5]] });
  await upsertRowByDate({ spreadsheetId: "s1", tabName: "One Pager Report", date: "2026-09-08", fields: { "Locked Total": 11, "Aisle Occupancy Avg %": 80.4 }, client });
  assert.deepEqual(client.state.grid[0], ["Date", "Locked Total", "Aisle Occupancy Avg %"]);
  assert.deepEqual(client.state.grid[1], ["2026-09-07", 5]); // untouched
  assert.deepEqual(client.state.grid[2], ["2026-09-08", 11, 80.4]);
});

test("upsertRowByDate(): saving an already-present date OVERWRITES that row in place, never duplicates it", async () => {
  const client = makeFakeClient({ grid: [["Date", "Locked Total"], ["2026-09-07", 5], ["2026-09-08", 11]] });
  const row = await upsertRowByDate({ spreadsheetId: "s1", tabName: "One Pager Report", date: "2026-09-08", fields: { "Locked Total": 99 }, client });
  assert.equal(row, 3);
  assert.equal(client.state.grid.length, 3, "must still be exactly 3 rows (1 header + 2 dates) - never 4");
  assert.deepEqual(client.state.grid[2], ["2026-09-08", 99]);
  assert.deepEqual(client.state.grid[1], ["2026-09-07", 5], "the other date's row must be untouched");
});

test("upsertRowByDate(): a missing field in this write is left blank, never carries over a stale value from a previous save", async () => {
  const client = makeFakeClient({ grid: [["Date", "Locked Total", "Outside Totes Total"], ["2026-09-08", 11, 6]] });
  await upsertRowByDate({ spreadsheetId: "s1", tabName: "One Pager Report", date: "2026-09-08", fields: { "Locked Total": 12 }, client });
  assert.deepEqual(client.state.grid[1], ["2026-09-08", 12, ""]);
});

test("upsertRowByDate(): throws NOT_CONFIGURED when no key file and no injected client are given", async () => {
  await assert.rejects(
    upsertRowByDate({ spreadsheetId: "s1", tabName: "One Pager Report", date: "2026-09-08", fields: {}, keyFile: null }),
    (e) => e.code === "NOT_CONFIGURED"
  );
});
