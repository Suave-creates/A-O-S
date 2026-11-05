// Thin Google Sheets API v4 client, authenticated via a service account
// (2026-09-08, pivoted from an Apps Script Web App - the Lenskart Workspace
// only offers "Only myself" / "Anyone within lenskart.com" for a Web App's
// access, never true "Anyone", so an unauthenticated server-side POST
// always redirects to a Google sign-in page instead of executing, no
// matter how the script itself is deployed - confirmed live, and it
// explains the pre-existing NexS ASRS Dump Apps Script's own silent
// failures too. A service account sidesteps this entirely: it's a genuine
// server-to-server credential (no user session, no "who has access"
// setting in the picture at all) - the same standard mechanism Google
// itself documents for exactly this use case.
//
// Deliberately NOT the full `googleapis` package (which generates a client
// for every Google API) - just `google-auth-library` for the auth/token
// handling (JWT signing + OAuth2 exchange, the genuinely fragile part worth
// a real library for) plus plain REST calls against the Sheets API's own
// documented endpoints, kept in this one small, focused file so any future
// Sheet integration can reuse it without pulling in more surface area than
// this app needs.

const { GoogleAuth } = require("google-auth-library");
const config = require("../../config");

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

let cachedAuth = null;
function getAuth(keyFile) {
  // Cached per keyFile path (not globally) - GoogleAuth itself caches/
  // refreshes the actual access token internally, this just avoids
  // re-parsing the key file on every single call.
  if (!cachedAuth || cachedAuth.keyFile !== keyFile) {
    cachedAuth = { keyFile, auth: new GoogleAuth({ keyFile, scopes: SCOPES }) };
  }
  return cachedAuth.auth;
}

// Wraps a google-auth-library request error into a clear, non-secret-
// leaking message - the raw error often includes the full request (with
// Authorization header) in its `.config`, which must never end up in a
// route response or log.
function describeRequestError(e, action) {
  const status = e.response && e.response.status;
  const data = e.response && e.response.data;
  const reason = (data && data.error && (data.error.message || data.error.status)) || e.message || String(e);
  return new Error(`Google Sheets API ${action} failed${status ? ` (HTTP ${status})` : ""}: ${reason}`);
}

// 1-based column number -> spreadsheet column letter(s) (1 -> A, 26 -> Z, 27 -> AA, ...).
function colLetter(n) {
  let s = "";
  let num = n;
  while (num > 0) {
    const rem = (num - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    num = Math.floor((num - 1) / 26);
  }
  return s;
}

async function ensureTabExists(client, spreadsheetId, tabName) {
  let meta;
  try {
    meta = await client.request({ url: `${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties.title` });
  } catch (e) {
    throw describeRequestError(e, "read spreadsheet metadata");
  }
  const titles = ((meta.data && meta.data.sheets) || []).map((s) => s.properties.title);
  if (titles.includes(tabName)) return;
  try {
    await client.request({
      url: `${SHEETS_BASE}/${spreadsheetId}:batchUpdate`,
      method: "POST",
      data: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  } catch (e) {
    throw describeRequestError(e, `create tab "${tabName}"`);
  }
}

async function readRange(client, spreadsheetId, range) {
  try {
    const resp = await client.request({ url: `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}` });
    return (resp.data && resp.data.values) || [];
  } catch (e) {
    throw describeRequestError(e, `read range ${range}`);
  }
}

async function writeRange(client, spreadsheetId, range, values) {
  try {
    await client.request({
      url: `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      method: "PUT",
      data: { range, majorDimension: "ROWS", values },
    });
  } catch (e) {
    throw describeRequestError(e, `write range ${range}`);
  }
}

// Appends one row to the end of `tabName` (Sheets itself decides the exact
// row, based on the sheet's current last row) - returns the 1-based row
// number it actually landed on, parsed from the API's own updatedRange
// response (e.g. "'One Pager Report'!A5:AG5" -> 5), or null if that
// couldn't be parsed (informational only - the write itself already
// succeeded either way).
async function appendRow(client, spreadsheetId, tabName, values) {
  let resp;
  try {
    resp = await client.request({
      url: `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(tabName + "!A:A")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      method: "POST",
      data: { range: `${tabName}!A:A`, majorDimension: "ROWS", values: [values] },
    });
  } catch (e) {
    throw describeRequestError(e, `append row to "${tabName}"`);
  }
  const updatedRange = resp.data && resp.data.updates && resp.data.updates.updatedRange;
  const m = updatedRange && /![A-Z]+(\d+):/.exec(updatedRange);
  return m ? Number(m[1]) : null;
}

// upsertRowByDate({ spreadsheetId, tabName, date, fields, keyFile }) - the
// full self-describing-columns, one-row-per-date logic: bootstraps the
// header row on first use, appends a column for any field name not already
// present (existing columns are never reordered/removed), finds an
// existing row for `date` in column A and overwrites it in place, or
// appends a new row if none exists. Returns the 1-based row number that
// was written (best-effort for a fresh append - see appendRow()).
async function upsertRowByDate({
  spreadsheetId,
  tabName,
  date,
  fields,
  keyFile = config.onePagerReportSheetServiceAccountKeyPath,
  // Test-only seam: a pre-built client (or fake) bypasses getAuth()/keyFile
  // entirely, so this function's own read/write/append orchestration can
  // be unit-tested without any real Google auth or network call.
  client: injectedClient,
}) {
  if (!spreadsheetId) throw new Error("spreadsheetId is required");
  if (!injectedClient && !keyFile) {
    const err = new Error("ONE_PAGER_REPORT_SHEET_SERVICE_ACCOUNT_KEY_PATH is not configured");
    err.code = "NOT_CONFIGURED";
    throw err;
  }

  const client = injectedClient || (await getAuth(keyFile).getClient());

  await ensureTabExists(client, spreadsheetId, tabName);

  let headerRow = (await readRange(client, spreadsheetId, `${tabName}!1:1`))[0] || [];
  if (headerRow.length === 0) {
    headerRow = ["Date"];
    await writeRange(client, spreadsheetId, `${tabName}!A1`, [headerRow]);
  }

  const headerIndex = {}; // header text (trimmed) -> 1-based column
  headerRow.forEach((h, i) => {
    const name = String(h || "").trim();
    if (name) headerIndex[name] = i + 1;
  });
  if (!headerIndex["Date"]) {
    // Defensive only - Date is always written as column A above; this
    // would only trigger if something else already occupies A1.
    const err = new Error(`"${tabName}"!A1 must be "Date" - found "${headerRow[0]}" instead`);
    throw err;
  }

  const fieldNames = Object.keys(fields || {});
  const missing = fieldNames.filter((n) => !headerIndex[n]);
  if (missing.length) {
    const newHeaderRow = headerRow.slice();
    for (const name of missing) {
      newHeaderRow.push(name);
      headerIndex[name] = newHeaderRow.length;
    }
    await writeRange(client, spreadsheetId, `${tabName}!A1:${colLetter(newHeaderRow.length)}1`, [newHeaderRow]);
    headerRow = newHeaderRow;
  }

  const dateCol = headerIndex["Date"];
  const dateColLetter = colLetter(dateCol);
  const dateRows = await readRange(client, spreadsheetId, `${tabName}!${dateColLetter}2:${dateColLetter}`);
  let targetRow = null;
  for (let i = 0; i < dateRows.length; i++) {
    if (String((dateRows[i] || [])[0] || "").trim() === String(date).trim()) {
      targetRow = i + 2;
      break;
    }
  }

  const lastCol = headerRow.length;
  const rowValues = new Array(lastCol).fill("");
  rowValues[dateCol - 1] = date;
  for (const name of fieldNames) {
    const v = (fields || {})[name];
    rowValues[headerIndex[name] - 1] = v === undefined || v === null ? "" : v;
  }

  if (targetRow) {
    await writeRange(client, spreadsheetId, `${tabName}!A${targetRow}:${colLetter(lastCol)}${targetRow}`, [rowValues]);
    return targetRow;
  }
  return appendRow(client, spreadsheetId, tabName, rowValues);
}

module.exports = { upsertRowByDate, colLetter };
