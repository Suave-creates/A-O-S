// Unit tests for server/features/nexs-asrs-dump/googleSheetAsrsDumpProvider.js. `client` (the
// Apps Script HTTP client) is fully injected/fake - no real network call
// anywhere in this file. No Quadron/Grafana/Concinity/Runtime call either.

const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchAsrsDump, normalizeRow } = require("../../../features/nexs-asrs-dump/googleSheetAsrsDumpProvider");

function fakeClient(rows) {
  return { fetchAsrsDump: async () => rows };
}
function throwingClient(err) {
  return { fetchAsrsDump: async () => { throw err; } };
}

// ── New 5-column raw shape ────────────────────────────────────────────────

test("normalizes the new raw 5-column shape, preserving source values and parsing location", () => {
  const raw = {
    pid: "82650064",
    location: "NXS1-ASRS-TS0000009125_PR1",
    barcode_count: 56,
    last_updated_at: "2026-04-22 19:02:30",
    ingested_at: "2026-08-24 00:17:01",
  };
  const row = normalizeRow(raw);
  assert.equal(row.pid, "82650064");
  assert.equal(row.location, "NXS1-ASRS-TS0000009125_PR1", "raw location must be preserved unchanged");
  assert.equal(row.barcodeCount, 56);
  assert.equal(row.lastUpdatedAt, "2026-04-22 19:02:30", "must be the raw string, never reformatted");
  assert.equal(row.ingestedAt, "2026-08-24 00:17:01");
  assert.equal(row.toteId, "TS0000009125");
  assert.equal(row.partition, "PR1");
});

// ── Confirmed live contract (pid/toteId/partition/inventoryCount, no
// location/barcode_count/timestamps) ───────────────────────────────────────

test("normalizes the confirmed live contract shape, reconstructing location with the NXS1-ASRS- prefix", () => {
  const raw = { pid: "12345", toteId: "TL0000003490", partition: "PR2", inventoryCount: 7 };
  const row = normalizeRow(raw);
  assert.equal(row.pid, "12345");
  assert.equal(row.toteId, "TL0000003490", "already-parsed toteId is passed through, not re-derived");
  assert.equal(row.partition, "PR2");
  assert.equal(row.barcodeCount, 7, "inventoryCount is the canonical barcode quantity");
  assert.equal(row.location, "NXS1-ASRS-TL0000003490_PR2", "reconstructed with the confirmed fixed facility prefix");
  assert.equal(row.lastUpdatedAt, null, "never fabricated - genuinely absent from this shape");
  assert.equal(row.ingestedAt, null);
});

test("live-contract shape without a partition reconstructs a location with no trailing suffix", () => {
  const row = normalizeRow({ pid: "1", toteId: "TS0000000001", inventoryCount: 3 });
  assert.equal(row.location, "NXS1-ASRS-TS0000000001");
});

// ── Malformed / partial rows - handled honestly, never crash ─────────────

test("a row with an unparseable location keeps pid/barcodeCount but leaves toteId/partition null", () => {
  const row = normalizeRow({ pid: "999", location: "DECANT-04", barcode_count: 3 });
  assert.equal(row.pid, "999");
  assert.equal(row.location, "DECANT-04", "preserved as-is even though it doesn't parse");
  assert.equal(row.barcodeCount, 3);
  assert.equal(row.toteId, null);
  assert.equal(row.partition, null);
});

test("a completely empty raw row does not throw", () => {
  const row = normalizeRow({});
  assert.deepEqual(row, { pid: null, location: null, barcodeCount: null, lastUpdatedAt: null, ingestedAt: null, toteId: null, partition: null });
});

test("normalizeRow(null/undefined) does not throw", () => {
  assert.doesNotThrow(() => normalizeRow(null));
  assert.doesNotThrow(() => normalizeRow(undefined));
});

// ── fetchAsrsDump() orchestration ─────────────────────────────────────────

test("fetchAsrsDump maps every row and computes latestIngestedAt/latestUpdatedAt as the string max", async () => {
  const client = fakeClient([
    { pid: "1", location: "TS0000000001", barcode_count: 1, last_updated_at: "2026-01-01 00:00:00", ingested_at: "2026-08-20 00:00:00" },
    { pid: "2", location: "TS0000000002", barcode_count: 2, last_updated_at: "2026-06-01 00:00:00", ingested_at: "2026-08-24 00:17:01" },
    { pid: "3", location: "TS0000000003", barcode_count: 3, last_updated_at: "2026-03-01 00:00:00", ingested_at: "2026-08-22 00:00:00" },
  ]);
  const result = await fetchAsrsDump({ client });
  assert.equal(result.rowCount, 3);
  assert.equal(result.rows.length, 3);
  assert.equal(result.latestIngestedAt, "2026-08-24 00:17:01");
  assert.equal(result.latestUpdatedAt, "2026-06-01 00:00:00");
  assert.equal(result.source, "google_sheet_direct");
});

test("empty dump: fetchAsrsDump returns rowCount 0 and null latest timestamps, not an error", async () => {
  const result = await fetchAsrsDump({ client: fakeClient([]) });
  assert.equal(result.rowCount, 0);
  assert.deepEqual(result.rows, []);
  assert.equal(result.latestIngestedAt, null);
  assert.equal(result.latestUpdatedAt, null);
});

test("stale/missing ingestion timestamp: rows with no ingested_at at all never fabricate a value", async () => {
  const client = fakeClient([{ pid: "1", toteId: "TL0000000001", inventoryCount: 5 }]);
  const result = await fetchAsrsDump({ client });
  assert.equal(result.rows[0].ingestedAt, null);
  assert.equal(result.latestIngestedAt, null, "must stay null - never derived from Date.now()");
});

test("source unavailable: a client-level failure propagates, is not swallowed into an empty dataset", async () => {
  const err = new Error("Apps Script request failed: fetch failed");
  err.code = "APPS_SCRIPT_NETWORK_ERROR";
  await assert.rejects(() => fetchAsrsDump({ client: throwingClient(err) }), /Apps Script request failed/);
});
