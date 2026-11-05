// Pure unit tests for server/features/tote-puller/toteStatus.js - ported verbatim from the
// legacy extension's trStatusOf().

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyStatus } = require("../../../platform/domain/toteStatus");

test("classifyStatus: '_bt_' anywhere in the location means Bad Tracker, checked before Buffer patterns", () => {
  assert.equal(classifyStatus("ASRS_BT_BIN_001"), "Bad Tracker");
});

test("classifyStatus: '_bin' or '_bout' means Buffer", () => {
  assert.equal(classifyStatus("ZONE_BIN_5"), "Buffer");
  assert.equal(classifyStatus("ZONE_BOUT_5"), "Buffer");
});

test("classifyStatus: contains 'out' (not already matched above) means Outside Tote", () => {
  assert.equal(classifyStatus("OUTBOUND_DOCK_3"), "Outside Tote");
});

test("classifyStatus: starts with 004-009 means On Location", () => {
  assert.equal(classifyStatus("007-06-1-217-1-02"), "On Location");
  assert.equal(classifyStatus("004-01-1-001-1-01"), "On Location");
  assert.equal(classifyStatus("003-01-1-001-1-01"), "—", "003 is below the 004-009 range - unclassified");
});

test("classifyStatus: an empty/null/undefined location returns an empty string, never a fabricated status", () => {
  assert.equal(classifyStatus(""), "");
  assert.equal(classifyStatus(null), "");
  assert.equal(classifyStatus(undefined), "");
});

test("classifyStatus: is case-insensitive", () => {
  assert.equal(classifyStatus("ASRS_BT_BIN_001"), "Bad Tracker");
  assert.equal(classifyStatus("asrs_bt_bin_001"), "Bad Tracker");
});

test("classifyStatus: an unrecognized shape returns '—', never throws", () => {
  assert.equal(classifyStatus("some-random-string"), "—");
});
