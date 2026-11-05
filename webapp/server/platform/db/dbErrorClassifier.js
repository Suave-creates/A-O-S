// Pure classifier: does this error look like MySQL is simply unreachable
// (as opposed to a real application bug)? Used to choose a clearer error
// MESSAGE and a 503 (not 500) status - never to swallow an error, never to
// fabricate a successful response.

const CONNECTIVITY_CODES = new Set([
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "PROTOCOL_CONNECTION_LOST",
  "POOL_CLOSED",
]);

// Database review remediation (2026-09-04) - Task 5's "production-safe
// error handling... for database connection failures, pool exhaustion,
// query timeouts" requirement. Distinct from CONNECTIVITY_CODES above: this
// is not "MySQL is unreachable" but "MySQL is reachable, and this specific
// attempt to use it didn't succeed in time / at all":
//   - DB_ACQUIRE_TIMEOUT: this app's own code (db/index.js's
//     withAcquireTimeout) - every connection in the pool was busy and none
//     freed up within dbAcquireTimeoutMs.
//   - PROTOCOL_SEQUENCE_TIMEOUT: mysql2's own per-statement timeout firing
//     (db/index.js's withStatementTimeout / dbQueryTimeoutMs) - confirmed
//     by reading node_modules/mysql2/lib/commands/query.js's own
//     _handleTimeoutError(), which sets exactly this code.
//   - ER_CON_COUNT_ERROR: MySQL SERVER-side "Too many connections" (errno
//     1040) - the pool itself is fine, but the MySQL server has hit its own
//     max_connections ceiling (a real capacity signal, not a code bug).
const POOL_TIMEOUT_CODES = new Set(["DB_ACQUIRE_TIMEOUT", "PROTOCOL_SEQUENCE_TIMEOUT", "ER_CON_COUNT_ERROR"]);

function isMysqlConnectivityError(err) {
  return !!err && CONNECTIVITY_CODES.has(err.code);
}

function isMysqlPoolOrTimeoutError(err) {
  return !!err && POOL_TIMEOUT_CODES.has(err.code);
}

// Either class - "this request could not reach/use the database within its
// budget," the umbrella check server/index.js's global error handler uses
// to decide 503-with-a-clear-message vs. the generic 500.
function isMysqlUnavailableError(err) {
  return isMysqlConnectivityError(err) || isMysqlPoolOrTimeoutError(err);
}

module.exports = {
  isMysqlConnectivityError,
  isMysqlPoolOrTimeoutError,
  isMysqlUnavailableError,
  CONNECTIVITY_CODES,
  POOL_TIMEOUT_CODES,
};
