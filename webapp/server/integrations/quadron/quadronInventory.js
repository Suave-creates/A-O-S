// Query definition for the GET_QUADRON_INVENTORY capability (Phase 3). The
// backend owns this definition (origin + instanceCode) - the runtime only
// ever executes its own hardcoded Quadron dashboard request against its own
// independently verified origin allow-list; the URL path itself is never
// taken from this payload (mirrors grafanaLockedTotes.js's own invariant).
//
// Auth is deliberately NOT this backend's concern: unlike Grafana
// (session cookie, credentials:"include"), Quadron requires a bearer JWT
// value, so the runtime performs the whole request - token extraction and
// fetch - inside an already-authenticated Concinity tab's own page context
// (see runtime/background/capabilities.js). This backend never sees, and
// this file never expects, a token in either direction.

function buildPayload(quadronOrigin, instanceCode) {
  return { quadronOrigin, instanceCode };
}

// Rejects any row carrying a field this capability doesn't expect - this is
// the backend's own independent check that the runtime's result is exactly
// the normalized shape it's supposed to be, never trusted blindly. In
// particular, an unexpected field (e.g. an accidentally-included token)
// fails validation rather than being passed through to the query result.
function validateResult(result) {
  if (!result || !Array.isArray(result.rows)) return { ok: false, reason: "result.rows must be an array" };

  const allowedRowKeys = new Set(["toteId", "quadronQty", "partitions"]);
  const allowedPartitionKeys = new Set(["part", "qty", "sku"]);

  for (const row of result.rows) {
    if (!row || typeof row.toteId !== "string" || !row.toteId) {
      return { ok: false, reason: "each row must have a non-empty string toteId" };
    }
    if (row.quadronQty != null && typeof row.quadronQty !== "number") {
      return { ok: false, reason: "quadronQty must be a number or null" };
    }
    if (!Array.isArray(row.partitions)) {
      return { ok: false, reason: "each row must have a partitions array" };
    }
    for (const key of Object.keys(row)) {
      if (!allowedRowKeys.has(key)) return { ok: false, reason: `unexpected field in row: ${key}` };
    }
    for (const part of row.partitions) {
      for (const key of Object.keys(part || {})) {
        if (!allowedPartitionKeys.has(key)) return { ok: false, reason: `unexpected field in partition: ${key}` };
      }
    }
  }
  return { ok: true };
}

// Pure comparison of an already-completed GET_GRAFANA_LOCKED_TOTES result
// against an already-completed GET_QUADRON_INVENTORY result. No I/O, no
// authorization here - the caller (queries.routes.js) is responsible for
// confirming the requesting user is allowed to see both underlying queries.
//
// Direction is deliberately one-way: Grafana's SQL_LOCKED is the source of
// truth for "this tote is currently locked"; this asks, for each such tote,
// whether Quadron's live inventory still agrees it's actually present.
// Quadron's raw dashboard dump has no independent "locked" concept of its
// own (see background/index.js), so there's no meaningful reverse direction
// to check without changing what GET_GRAFANA_LOCKED_TOTES queries - which is
// explicitly out of scope for this phase.
function reconcileWithGrafana(grafanaResult, quadronResult) {
  const quadronByTote = new Map((quadronResult?.rows || []).map((r) => [r.toteId, r]));

  const rows = (grafanaResult?.rows || []).map((g) => {
    const q = quadronByTote.get(g.toteId) || null;
    const quadronQty = q ? q.quadronQty : null;
    let verdict;
    if (!q) verdict = "MISSING_IN_QUADRON";
    else if (quadronQty > 0) verdict = "MATCH";
    else verdict = "MISMATCH";
    return { toteId: g.toteId, quadronQty, verdict };
  });

  const summary = rows.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});

  return { rows, summary, reconciledAt: new Date().toISOString() };
}

module.exports = { buildPayload, validateResult, reconcileWithGrafana };
