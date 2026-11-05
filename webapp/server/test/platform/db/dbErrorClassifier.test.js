// Pure unit tests for server/platform/db/dbErrorClassifier.js. No database, no
// network.

const test = require("node:test");
const assert = require("node:assert/strict");
const { isMysqlConnectivityError, isMysqlPoolOrTimeoutError, isMysqlUnavailableError } = require("../../../platform/db/dbErrorClassifier");

test("recognizes ETIMEDOUT (the actual error observed with an unreachable office MySQL)", () => {
  const err = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
  assert.equal(isMysqlConnectivityError(err), true);
});

test("recognizes ECONNREFUSED, ENOTFOUND, PROTOCOL_CONNECTION_LOST", () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "PROTOCOL_CONNECTION_LOST"]) {
    assert.equal(isMysqlConnectivityError(Object.assign(new Error(code), { code })), true, code);
  }
});

test("does NOT classify an unrelated application error as a DB connectivity error", () => {
  assert.equal(isMysqlConnectivityError(new Error("totes must be a non-empty array")), false);
  assert.equal(isMysqlConnectivityError(Object.assign(new Error("bad input"), { code: "ER_BAD_FIELD_ERROR" })), false);
});

test("handles null/undefined safely, never throws", () => {
  assert.equal(isMysqlConnectivityError(null), false);
  assert.equal(isMysqlConnectivityError(undefined), false);
  assert.equal(isMysqlConnectivityError({}), false);
});

// ── isMysqlPoolOrTimeoutError / isMysqlUnavailableError (2026-09-04 review) ──

test("isMysqlPoolOrTimeoutError recognizes this app's own acquire-timeout code (db/index.js's withAcquireTimeout)", () => {
  const err = Object.assign(new Error("Timed out after 10000ms waiting for a database connection"), { code: "DB_ACQUIRE_TIMEOUT" });
  assert.equal(isMysqlPoolOrTimeoutError(err), true);
});

test("isMysqlPoolOrTimeoutError recognizes mysql2's own per-statement timeout code", () => {
  const err = Object.assign(new Error("Query inactivity timeout"), { code: "PROTOCOL_SEQUENCE_TIMEOUT" });
  assert.equal(isMysqlPoolOrTimeoutError(err), true);
});

test("isMysqlPoolOrTimeoutError recognizes MySQL server-side 'too many connections'", () => {
  const err = Object.assign(new Error("Too many connections"), { code: "ER_CON_COUNT_ERROR", errno: 1040 });
  assert.equal(isMysqlPoolOrTimeoutError(err), true);
});

test("isMysqlPoolOrTimeoutError does NOT classify a plain connectivity error (that's the other function's job)", () => {
  assert.equal(isMysqlPoolOrTimeoutError(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), false);
});

test("isMysqlUnavailableError is true for EITHER connectivity or pool/timeout codes, false for an unrelated application error", () => {
  assert.equal(isMysqlUnavailableError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), true);
  assert.equal(isMysqlUnavailableError(Object.assign(new Error("x"), { code: "DB_ACQUIRE_TIMEOUT" })), true);
  assert.equal(isMysqlUnavailableError(Object.assign(new Error("x"), { code: "ER_BAD_FIELD_ERROR" })), false);
  assert.equal(isMysqlUnavailableError(new Error("totes must be a non-empty array")), false);
});

test("isMysqlPoolOrTimeoutError/isMysqlUnavailableError handle null/undefined safely, never throw", () => {
  assert.equal(isMysqlPoolOrTimeoutError(null), false);
  assert.equal(isMysqlUnavailableError(undefined), false);
});
