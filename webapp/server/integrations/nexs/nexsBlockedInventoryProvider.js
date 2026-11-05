// Production NexS Blocked Inventory provider - dispatches the
// GET_NEXS_BLOCKED_INVENTORY capability to the ASO Browser Runtime, the
// same request-capability-then-wait-then-unwrap flow every other
// capability uses (mirrors server/integrations/quadron/quadronPull.js's own use of
// capabilityManager.requestCapability() with caller-supplied params).
//
// This is the smallest reusable abstraction a future Tote Purge engine
// needs (one call per unique candidate PID, concurrency 5 - see
// background/index.js's runPurgeGenerate()). Tote Purge itself is NOT
// implemented here - this phase only builds the capability/provider it
// will eventually call.
//
// Field extraction is ported field-for-field from the legacy extension's
// OWN consumer of fetchBlockedInv()'s result (background/index.js):
//   blockedMap[pid] = { blocked: Number(r.data.blockedInventory)||0,
//                        total:   Number(r.data.totalInventory)||0,
//                        available: Number(r.data.availableInventory)||0 }
// Nothing is invented beyond that - if the actual NexS response is missing
// a field, it normalizes to 0, exactly like the legacy code already does,
// never fabricated as anything else.

const capabilityManager = require("../capabilities/capabilityManager");
const { waitForTerminal } = require("../../platform/queries/queryPoll");

function normalize(pid, result) {
  const data = (result && result.data) || {};
  return {
    pid: String(pid),
    totalInventory: Number(data.totalInventory) || 0,
    blockedInventory: Number(data.blockedInventory) || 0,
    availableInventory: Number(data.availableInventory) || 0,
  };
}

// fetchBlockedInventory({ user, pid, facilityCode }) -> { pid, totalInventory, blockedInventory, availableInventory }
// requestCapability/wait/getResult are injectable purely for testing (no
// real Runtime WebSocket connection needed to unit-test normalization) -
// production callers pass only { user, pid, facilityCode }.
//
// UNCHANGED for backward compatibility (NEXS batch-capability refactor -
// see fetchBlockedInventoryBatch below, which purgeEngine.js now calls
// instead of this function in a loop). Still used directly by any future
// single-PID caller that genuinely only needs one PID.
async function fetchBlockedInventory({
  user,
  pid,
  facilityCode,
  requestCapability = capabilityManager.requestCapability,
  wait = waitForTerminal,
  getResult = capabilityManager.getResult,
}) {
  const dispatch = await requestCapability({
    user,
    capabilityName: "GET_NEXS_BLOCKED_INVENTORY",
    params: { pid, facilityCode },
  });
  if (!dispatch.ok) {
    const err = new Error(dispatch.reason);
    err.code = "NEXS_BLOCKED_INVENTORY_ERROR";
    throw err;
  }

  const queryId = dispatch.query.query_id;
  let query;
  try {
    query = await wait(queryId);
  } catch (e) {
    // wait()'s own local safety-net deadline (see queryPoll.js) firing is
    // still a real failure of THIS lookup, never left to propagate as an
    // uncaught rejection out of a provider function whose whole contract is
    // "throws NEXS_BLOCKED_INVENTORY_ERROR on failure, never anything else".
    const err = new Error(e.message || String(e));
    err.code = "NEXS_BLOCKED_INVENTORY_ERROR";
    throw err;
  }
  if (query.status !== "COMPLETED") {
    const err = new Error(`GET_NEXS_BLOCKED_INVENTORY ended in status ${query.status}`);
    err.code = "NEXS_BLOCKED_INVENTORY_ERROR";
    throw err;
  }

  const result = getResult(queryId);
  return normalize(pid, result);
}

// fetchBlockedInventoryBatch({ user, pids, facilityCode }) -> blockedMap,
// where blockedMap[pid] = { ok:true, totalInventory, blockedInventory,
// availableInventory } | { ok:false, reason } - EXACTLY the shape
// purgeEngine.js used to build itself from N individual
// fetchBlockedInventory() calls. purgeClassify.classifyByBlocked() (which
// consumes blockedMap) is completely unchanged - it has no idea this is
// now one batched capability dispatch instead of N individual ones.
//
// Dispatches ONE GET_NEXS_BLOCKED_INVENTORY_BATCH capability request - one
// Query Manager row regardless of how many PIDs are requested. A PID
// missing from the runtime's results (should not normally happen, but
// never trusted blindly) is reported failed, exactly like a PID whose own
// entry came back status:"failed" - both isolate to that PID alone, never
// affecting any other PID's result.
// Large lists go to NexS in chunks of CHUNK_PIDS, one after another (2026-11-04: a Tote Purge of 2,892 PIDs in ONE
// request needed ~105 s and hit the capability's 60 s timeout, so every PID failed together; 814 PIDs took ~30 s).
// A chunk of 500 stays well inside the timeout, NexS still sees at most 5 lookups at a time, and a failed chunk
// only fails its own PIDs.
const CHUNK_PIDS = 500;

// Every PID that failed (a chunk cancelled in Active Queries, a timeout, a NexS error) gets ONE more try after the
// last chunk; if it fails again it is reported with that second reason. onProgress({ done, total, retrying }) is
// called after every chunk so a caller can show progress and an estimated time.
async function fetchBlockedInventoryBatch(opts) {
  const pids = Array.isArray(opts.pids) ? opts.pids : [];
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const blockedMap = Object.create(null);
  for (let i = 0; i < pids.length; i += CHUNK_PIDS) {
    Object.assign(blockedMap, await fetchOneChunk({ ...opts, pids: pids.slice(i, i + CHUNK_PIDS) }));
    onProgress({ done: Math.min(i + CHUNK_PIDS, pids.length), total: pids.length, retrying: false });
  }
  const failed = pids.filter((p) => !blockedMap[p] || !blockedMap[p].ok);
  if (failed.length && opts.retry !== false) {
    onProgress({ done: 0, total: failed.length, retrying: true });
    for (let i = 0; i < failed.length; i += CHUNK_PIDS) {
      Object.assign(blockedMap, await fetchOneChunk({ ...opts, pids: failed.slice(i, i + CHUNK_PIDS) }));
      onProgress({ done: Math.min(i + CHUNK_PIDS, failed.length), total: failed.length, retrying: true });
    }
  }
  return blockedMap;
}

async function fetchOneChunk({
  user,
  pids,
  facilityCode,
  requestCapability = capabilityManager.requestCapability,
  wait = waitForTerminal,
  getResult = capabilityManager.getResult,
}) {
  const blockedMap = Object.create(null);
  if (!Array.isArray(pids) || !pids.length) return blockedMap; // nothing to request - an empty batch is not an error

  const dispatch = await requestCapability({
    user,
    capabilityName: "GET_NEXS_BLOCKED_INVENTORY_BATCH",
    params: { pids, facilityCode },
  });
  if (!dispatch.ok) {
    // The whole batch could not even be dispatched (e.g. no capable
    // runtime online) - every requested PID is reported failed with the
    // same real reason, exactly matching the per-PID isolation contract
    // classifyByBlocked() already relies on (each lands in apiSkipped with
    // its own reason - there is no separate "batch failed entirely" branch
    // to add downstream).
    for (const pid of pids) blockedMap[pid] = { ok: false, reason: dispatch.reason };
    return blockedMap;
  }

  const queryId = dispatch.query.query_id;
  let query;
  try {
    query = await wait(queryId);
  } catch (e) {
    // wait()'s own local safety-net deadline (see queryPoll.js) firing must
    // never become an uncaught exception that hard-fails the ENTIRE Purge
    // run - it degrades to the same per-PID isolation as every other batch
    // failure mode (every requested PID reported failed with the real
    // reason), never a silent hang and never a whole-run crash.
    const reason = e.message || String(e);
    for (const pid of pids) blockedMap[pid] = { ok: false, reason };
    return blockedMap;
  }
  if (query.status !== "COMPLETED") {
    const reason = `GET_NEXS_BLOCKED_INVENTORY_BATCH ended in status ${query.status}`;
    for (const pid of pids) blockedMap[pid] = { ok: false, reason };
    return blockedMap;
  }

  const result = getResult(queryId);
  const byPid = new Map((result && Array.isArray(result.results) ? result.results : []).map((r) => [r.pid, r]));
  for (const pid of pids) {
    const r = byPid.get(pid);
    if (!r || r.status !== "ok") {
      blockedMap[pid] = { ok: false, reason: (r && r.error) || "PID missing from batch result" };
    } else {
      blockedMap[pid] = {
        ok: true,
        totalInventory: Number(r.totalInventory) || 0,
        blockedInventory: Number(r.blockedInventory) || 0,
        availableInventory: Number(r.availableInventory) || 0,
      };
    }
  }
  return blockedMap;
}

module.exports = { fetchBlockedInventory, fetchBlockedInventoryBatch, normalize, CHUNK_PIDS };
