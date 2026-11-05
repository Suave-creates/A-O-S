// The one serializer for a Query Manager row -> the shape every query-based
// API returns. Shared by every feature that exposes queries, so it lives here
// rather than inside any one feature's routes.
const { isCancellationSupported } = require("./cancellationSupport");

function toPublicQuery(row) {
  return {
    queryId: row.query_id,
    operation: row.operation,
    status: row.status,
    parameters: row.parameters ? JSON.parse(row.parameters) : {},
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    error: row.error,
    createdAt: row.created_at,
    // See ./cancellationSupport.js - whether a Cancel action for
    // this row would actually stop real work, not just flip DB status.
    cancellationSupported: isCancellationSupported(row.operation),
  };
}

module.exports = { toPublicQuery };
