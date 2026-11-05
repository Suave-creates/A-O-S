// Shared "request a read capability, wait for it, unwrap its rows" helper.
// Used by both classificationEngine.js (on-demand refresh) and
// autoEngine.js (periodic fetch cycle) so the two data-fetch paths can
// never diverge in how they dispatch/await/unwrap a capability result.
// Never throws - always resolves to { ok, rows, queryId, reason }, so a
// caller can degrade gracefully (Classification) or retry later (Auto)
// without a try/catch at every call site.

const capabilityManager = require("./capabilityManager");
const { waitForTerminal } = require("../../platform/queries/queryPoll");

async function fetchCapabilitySource({
  user,
  capabilityName,
  requestCapability = capabilityManager.requestCapability,
  wait = waitForTerminal,
  getResult = capabilityManager.getResult,
}) {
  const dispatch = await requestCapability({ user, capabilityName });
  if (!dispatch.ok) return { ok: false, rows: [], queryId: null, reason: dispatch.reason };

  const queryId = dispatch.query.query_id;
  let query;
  try {
    query = await wait(queryId);
  } catch (e) {
    return { ok: false, rows: [], queryId, reason: e.message || String(e) };
  }
  if (query.status !== "COMPLETED") {
    return { ok: false, rows: [], queryId, reason: `${capabilityName} ended in status ${query.status}` };
  }

  const result = getResult(queryId);
  return { ok: true, rows: (result && result.rows) || [], queryId, reason: null };
}

module.exports = { fetchCapabilitySource };
