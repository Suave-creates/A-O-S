// Bulk Inventory Check (2026-10-01, operator-requested: "create a new
// module Bulk Inventory Check where I will put bulk tote and I will get the
// barcode details") - orchestrates the single GET_GRAFANA_TOTE_INVENTORY_CHECK
// capability dispatch this feature needs and groups the raw per-partition
// rows back under each originally-requested tote. Mirrors
// asrsLocationsEngine.js's own createQuery/registerJob/markRunning/
// dispatch/completeQuery/failQuery shape exactly - ONE Query Manager row
// for the whole run, same as every other single-capability feature in this
// app. 100% read-only - never pulls a tote or affects any operation.

const defaultCapabilityManager = require("../../integrations/capabilities/capabilityManager");
const { waitForTerminal } = require("../../platform/queries/queryPoll");
const defaultQueryManager = require("../../platform/queries/queryManager");
const { TOTE_ID_REGEX } = require("../../integrations/quadron/pullQuadronTote");
const { splitPartitionedToteId } = require("../../integrations/quadron/quadronInventoryDirect");
const { MAX_TOTES } = require("../../integrations/grafana/grafanaToteInventoryCheck");

// Validates/dedupes the caller-supplied tote list the same way every other
// bulk-tote feature in this app does (CNG Inv Validator, Outside Tote
// Analysis) - loud rejection on anything invalid, never a silent drop.
// Pure, exported for direct unit testing.
function normalizeTotes(rawTotes) {
  if (!Array.isArray(rawTotes) || rawTotes.length === 0) {
    const err = new Error("At least one tote id is required");
    err.code = 400;
    throw err;
  }
  const seen = new Set();
  const totes = [];
  for (const raw of rawTotes) {
    const t = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    if (!t || seen.has(t)) continue;
    seen.add(t);
    totes.push(t);
  }
  if (!totes.length) {
    const err = new Error("At least one tote id is required");
    err.code = 400;
    throw err;
  }
  const invalid = totes.filter((t) => !TOTE_ID_REGEX.test(t));
  if (invalid.length) {
    const err = new Error(`Invalid tote id(s): ${invalid.join(", ")}`);
    err.code = 400;
    throw err;
  }
  if (totes.length > MAX_TOTES) {
    const err = new Error(`${totes.length} totes exceeds the ${MAX_TOTES} limit per request - split into smaller batches`);
    err.code = 400;
    throw err;
  }
  return totes;
}

// Groups the capability's own flat per-partition rows back under each
// REQUESTED base tote (a tote with zero matching rows still gets its own
// entry, found:false, rather than silently vanishing - the operator needs
// to know a pasted tote had NO barcode data, not just see it missing from
// the list). A row whose own base doesn't match any requested tote (should
// never happen, since the SQL's own WHERE clause only ever matches
// requested bases - defensive only) is simply never attributed anywhere,
// never fabricated onto the wrong tote. Pure, exported for direct unit
// testing without touching capability dispatch at all.
function groupRowsByTote(totes, rows) {
  const byBase = new Map(totes.map((t) => [t, []]));
  for (const row of rows || []) {
    const { base } = splitPartitionedToteId(row.container);
    if (byBase.has(base)) byBase.get(base).push(row);
  }
  return totes.map((tote) => {
    const partitions = byBase.get(tote) || [];
    return {
      tote,
      found: partitions.length > 0,
      partitions: partitions
        .slice()
        .sort((a, b) => (Number(a.partition) || 0) - (Number(b.partition) || 0)),
    };
  });
}

async function checkBulkInventory({
  queryId,
  user,
  totes: rawTotes,
  requestCapability = defaultCapabilityManager.requestCapability,
  wait = waitForTerminal,
  getResult: getCapabilityResult = defaultCapabilityManager.getResult,
  qm = defaultQueryManager,
}) {
  const controller = new AbortController();
  qm.registerJob(queryId, controller);

  try {
    await qm.markRunning(queryId);
    const totes = normalizeTotes(rawTotes);

    const dispatch = await requestCapability({ user, capabilityName: "GET_GRAFANA_TOTE_INVENTORY_CHECK", params: { totes } });
    if (!dispatch.ok) {
      const err = new Error(dispatch.reason || "GET_GRAFANA_TOTE_INVENTORY_CHECK dispatch failed");
      err.code = dispatch.code || 502;
      throw err;
    }

    const capQueryId = dispatch.query.query_id;
    const query = await wait(capQueryId);
    if (query.status !== "COMPLETED") {
      const err = new Error(`GET_GRAFANA_TOTE_INVENTORY_CHECK ended in status ${query.status}`);
      err.code = 502;
      throw err;
    }

    const result = getCapabilityResult(capQueryId);
    const items = groupRowsByTote(totes, (result && result.rows) || []);
    const generatedAt = new Date().toISOString();
    const foundCount = items.filter((i) => i.found).length;

    await qm.completeQuery(queryId);
    return { generatedAt, requestedCount: totes.length, foundCount, notFoundCount: totes.length - foundCount, items };
  } catch (e) {
    await qm.failQuery(queryId, e.message || String(e));
    throw e;
  } finally {
    qm.unregisterJob(queryId);
  }
}

module.exports = { checkBulkInventory, normalizeTotes, groupRowsByTote };
