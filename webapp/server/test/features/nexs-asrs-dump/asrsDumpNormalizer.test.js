// Unit tests for server/features/nexs-asrs-dump/asrsDumpNormalizer.js - the ASRS Dump row
// normalization shared by BOTH concrete providers (googleSheetAsrsDumpProvider.js
// and runtimeAsrsDumpProvider.js), so there is exactly one place this logic
// lives. No I/O, no network, no Quadron/Grafana/Concinity/Runtime call
// anywhere in this file.

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeRow, latestOf } = require("../../../features/nexs-asrs-dump/asrsDumpNormalizer");

test("confirmed live contract: pid/toteId/partition/inventoryCount are preserved, location is derived with the NXS1-ASRS- prefix", () => {
  const row = normalizeRow({ pid: "82650064", toteId: "TS0000009125", partition: "PR1", inventoryCount: 56 });
  assert.equal(row.pid, "82650064");
  assert.equal(row.toteId, "TS0000009125");
  assert.equal(row.partition, "PR1");
  assert.equal(row.barcodeCount, 56, "inventoryCount is the canonical barcode quantity");
  assert.equal(row.location, "NXS1-ASRS-TS0000009125_PR1", "location must be reconstructed with the fixed facility prefix");
  assert.equal(row.lastUpdatedAt, null, "must never fabricate a timestamp the source didn't send");
  assert.equal(row.ingestedAt, null, "must never fabricate a timestamp the source didn't send");
});

test("a second live example (TL variant) reconstructs the same way", () => {
  const row = normalizeRow({ pid: "206272", toteId: "TL0000031768", partition: "PR2", inventoryCount: 63 });
  assert.equal(row.location, "NXS1-ASRS-TL0000031768_PR2");
  assert.equal(row.toteId, "TL0000031768");
  assert.equal(row.partition, "PR2");
  assert.equal(row.barcodeCount, 63);
});

test("a row with no partition (legitimate, not an error) derives location without a trailing partition suffix", () => {
  const row = normalizeRow({ pid: "999", toteId: "TS0000000001", partition: null, inventoryCount: 10 });
  assert.equal(row.partition, null);
  assert.equal(row.location, "NXS1-ASRS-TS0000000001", "no dangling underscore when there is no partition");
});

test("toteId is normalized to uppercase and trimmed, matching the rest of the codebase's tote-id convention", () => {
  const row = normalizeRow({ pid: "1", toteId: " ts0000009125 ", partition: "pr1", inventoryCount: 5 });
  assert.equal(row.toteId, "TS0000009125");
});

test("fallback: a source that instead sends a raw `location` string (not the confirmed live shape) still parses toteId/partition out of it", () => {
  const row = normalizeRow({ pid: "1", location: "NXS1-ASRS-TL0000031768_PR2", barcode_count: 3 });
  assert.equal(row.toteId, "TL0000031768");
  assert.equal(row.partition, "PR2");
  assert.equal(row.location, "NXS1-ASRS-TL0000031768_PR2", "an explicitly-provided location is preserved verbatim, not re-derived");
  assert.equal(row.barcodeCount, 3, "barcode_count is accepted as a fallback field name");
});

test("an unparseable location (no recognizable tote id) keeps pid/barcodeCount, leaves toteId/partition null, preserves the raw location string - nothing dropped", () => {
  const row = normalizeRow({ pid: "999", location: "DECANT-04", barcode_count: 3 });
  assert.equal(row.pid, "999");
  assert.equal(row.location, "DECANT-04");
  assert.equal(row.barcodeCount, 3);
  assert.equal(row.toteId, null);
  assert.equal(row.partition, null);
});

test("empty/null raw rows never throw", () => {
  assert.doesNotThrow(() => normalizeRow({}));
  assert.doesNotThrow(() => normalizeRow(null));
  assert.doesNotThrow(() => normalizeRow(undefined));
  const row = normalizeRow({});
  assert.equal(row.location, null);
  assert.equal(row.toteId, null);
  assert.equal(row.barcodeCount, null);
});

test("latestOf computes the string max, never fabricates when all values are absent", () => {
  const rows = [{ ingestedAt: "2026-08-20T00:00:00.000Z" }, { ingestedAt: "2026-08-24T00:17:01.000Z" }, { ingestedAt: null }];
  assert.equal(latestOf(rows, "ingestedAt"), "2026-08-24T00:17:01.000Z");
  assert.equal(latestOf([{ ingestedAt: null }], "ingestedAt"), null);
  assert.equal(latestOf([], "ingestedAt"), null);
});
