// Unit tests for the ACTUAL browser-loaded parser
// (webapp/public/js/toteListParser.js), not a hand-duplicated backend copy.
// Pure string parsing - no DOM, no database, no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseToteList } = require("../../../../public/js/core/toteListParser");

test("parses comma-separated totes", () => {
  assert.deepEqual(parseToteList("TL0000002607,TS0000000001,TL0000009207"), ["TL0000002607", "TS0000000001", "TL0000009207"]);
});

test("parses whitespace-separated totes (spaces, tabs, newlines)", () => {
  assert.deepEqual(parseToteList("TL0000002607 TS0000000001\tTL0000009207\nTS0000000002"), [
    "TL0000002607",
    "TS0000000001",
    "TL0000009207",
    "TS0000000002",
  ]);
});

test("parses a mix of commas, semicolons, and whitespace in one input", () => {
  assert.deepEqual(parseToteList("TL0000002607, TS0000000001; TL0000009207\n\nTS0000000002"), [
    "TL0000002607",
    "TS0000000001",
    "TL0000009207",
    "TS0000000002",
  ]);
});

test("converts lowercase/mixed-case input to uppercase", () => {
  assert.deepEqual(parseToteList("tl0000002607, Ts0000000001"), ["TL0000002607", "TS0000000001"]);
});

test("filters out invalid tote ids, keeping only real matches", () => {
  assert.deepEqual(parseToteList("TL0000002607, not-a-tote, TS0000000001, 12345, TL000000260"), ["TL0000002607", "TS0000000001"]);
});

test("preserves duplicates - does NOT deduplicate", () => {
  assert.deepEqual(parseToteList("TL0000002607, TL0000002607, TS0000000001"), ["TL0000002607", "TL0000002607", "TS0000000001"]);
});

test("preserves input order exactly, including with duplicates interleaved", () => {
  assert.deepEqual(parseToteList("TS0000000002, TL0000002607, TS0000000002, TS0000000001"), [
    "TS0000000002",
    "TL0000002607",
    "TS0000000002",
    "TS0000000001",
  ]);
});

test("empty/whitespace-only/null input returns an empty array", () => {
  assert.deepEqual(parseToteList(""), []);
  assert.deepEqual(parseToteList("   \n\t  "), []);
  assert.deepEqual(parseToteList(null), []);
  assert.deepEqual(parseToteList(undefined), []);
});

test("rejects a tote id with a partition suffix (not a valid base tote id)", () => {
  assert.deepEqual(parseToteList("TL0000002607-1"), []);
});
