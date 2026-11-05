// Pure unit tests for server/platform/domain/asrsLocationParser.js. No I/O, no network,
// no Quadron/Grafana/Concinity/Runtime call anywhere in this file.

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLocation } = require("../../../platform/domain/asrsLocationParser");

test("parses a full raw location string with a tote id and partition", () => {
  const result = parseLocation("NXS1-ASRS-TS0000009125_PR1");
  assert.deepEqual(result, { toteId: "TS0000009125", partition: "PR1" });
});

test("parses a bare tote id with no prefix/partition", () => {
  const result = parseLocation("TL0000003490");
  assert.deepEqual(result, { toteId: "TL0000003490", partition: null });
});

test("is case-insensitive", () => {
  const result = parseLocation("nxs1-asrs-ts0000009125_pr2");
  assert.deepEqual(result, { toteId: "TS0000009125", partition: "PR2" });
});

test("returns nulls (never throws) for a location with no recognizable tote id", () => {
  assert.deepEqual(parseLocation("DECANT-STATION-04"), { toteId: null, partition: null });
  assert.deepEqual(parseLocation(""), { toteId: null, partition: null });
  assert.deepEqual(parseLocation(null), { toteId: null, partition: null });
  assert.deepEqual(parseLocation(undefined), { toteId: null, partition: null });
});

test("extracts the tote id even without a partition suffix present anywhere", () => {
  const result = parseLocation("NXS1-ASRS-TL0000000123");
  assert.deepEqual(result, { toteId: "TL0000000123", partition: null });
});

test("handles a two-digit partition number", () => {
  const result = parseLocation("TS0000009125_PR12");
  assert.deepEqual(result, { toteId: "TS0000009125", partition: "PR12" });
});

test("non-string input is coerced safely rather than throwing", () => {
  assert.deepEqual(parseLocation(12345), { toteId: null, partition: null });
});
