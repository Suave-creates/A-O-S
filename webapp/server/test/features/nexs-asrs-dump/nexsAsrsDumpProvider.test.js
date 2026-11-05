// Tests for server/features/nexs-asrs-dump/nexsAsrsDumpProvider.js - the stable selector
// interface. No real network call anywhere in this file.

const test = require("node:test");
const assert = require("node:assert/strict");

test("re-exports fetchAsrsDump, delegating to the Google Sheet (direct) provider", () => {
  const provider = require("../../../features/nexs-asrs-dump/nexsAsrsDumpProvider");
  const directProvider = require("../../../features/nexs-asrs-dump/googleSheetAsrsDumpProvider");
  assert.equal(typeof provider.fetchAsrsDump, "function");
  assert.equal(provider.fetchAsrsDump, directProvider.fetchAsrsDump, "must delegate to the exact same function, not a wrapped/duplicated copy");
});

test("consumers only need to require this one selector file, never a concrete implementation directly", () => {
  // Structural proof that this file is a thin selector (no business logic of
  // its own) - swapping the active provider means editing ONE require() in
  // this file, never touching a consumer.
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../../../features/nexs-asrs-dump/nexsAsrsDumpProvider.js"), "utf8");
  const codeOnly = src.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
  const requireCount = (codeOnly.match(/require\(/g) || []).length;
  assert.equal(requireCount, 1, "the selector should require exactly one concrete provider implementation");
});
