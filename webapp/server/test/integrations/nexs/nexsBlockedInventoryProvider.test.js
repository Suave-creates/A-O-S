// Unit tests for server/integrations/nexs/nexsBlockedInventoryProvider.js.
// requestCapability/wait/getResult are fully injected fakes - no real
// Runtime WebSocket connection, no real Grafana/Quadron/Concinity/Apps
// Script network call anywhere in this file.

const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchBlockedInventory, fetchBlockedInventoryBatch, normalize } = require("../../../integrations/nexs/nexsBlockedInventoryProvider");

const USER = { id: 1, role: "USER", employeeId: "EMP001" };

function makeFakeBatchCapability({ results, dispatchFails, dispatchReason, terminalStatus = "COMPLETED" }) {
  let counter = 0;
  const dispatchedParams = [];
  const requestCapability = async ({ capabilityName, params }) => {
    assert.equal(capabilityName, "GET_NEXS_BLOCKED_INVENTORY_BATCH");
    dispatchedParams.push(params);
    if (dispatchFails) return { ok: false, code: 503, reason: dispatchReason || "No online, approved runtime currently advertises this capability" };
    counter++;
    return { ok: true, query: { query_id: `Q-BATCH-FAKE-${counter}`, status: "RUNNING" }, params };
  };
  const wait = async (queryId) => ({ query_id: queryId, status: terminalStatus });
  const getResult = () => ({ results: results || [] });
  return { requestCapability, wait, getResult, dispatchedParams };
}

function makeFakeCapability({ data, dispatchFails, dispatchReason, terminalStatus = "COMPLETED" }) {
  let counter = 0;
  const requestCapability = async ({ capabilityName, params }) => {
    assert.equal(capabilityName, "GET_NEXS_BLOCKED_INVENTORY");
    if (dispatchFails) return { ok: false, code: 503, reason: dispatchReason || "No online, approved runtime currently advertises this capability" };
    counter++;
    return { ok: true, query: { query_id: `Q-FAKE-${counter}`, status: "RUNNING" }, params };
  };
  const wait = async (queryId) => ({ query_id: queryId, status: terminalStatus });
  const getResult = () => ({ pid: "82650064", data: data || {} });
  return { requestCapability, wait, getResult };
}

test("dispatches GET_NEXS_BLOCKED_INVENTORY with pid/facilityCode and normalizes the result", async () => {
  const caps = makeFakeCapability({ data: { totalInventory: 500, blockedInventory: 120, availableInventory: 380 } });
  const result = await fetchBlockedInventory({ user: USER, pid: "82650064", facilityCode: "NXS1", ...caps });
  assert.deepEqual(result, { pid: "82650064", totalInventory: 500, blockedInventory: 120, availableInventory: 380 });
});

test("zero blocked inventory is preserved, not treated as absent/falsy-skip", async () => {
  const caps = makeFakeCapability({ data: { totalInventory: 42, blockedInventory: 0, availableInventory: 42 } });
  const result = await fetchBlockedInventory({ user: USER, pid: "1", facilityCode: "NXS1", ...caps });
  assert.equal(result.blockedInventory, 0);
  assert.equal(result.availableInventory, 42);
});

test("a field the NexS response doesn't provide normalizes to 0, exactly like the legacy extension's own Number(...)||0", async () => {
  const caps = makeFakeCapability({ data: { totalInventory: 10 } }); // no blockedInventory/availableInventory at all
  const result = await fetchBlockedInventory({ user: USER, pid: "1", facilityCode: "NXS1", ...caps });
  assert.equal(result.totalInventory, 10);
  assert.equal(result.blockedInventory, 0);
  assert.equal(result.availableInventory, 0);
});

test("a completely empty data object normalizes every field to 0, not an error", async () => {
  const caps = makeFakeCapability({ data: {} });
  const result = await fetchBlockedInventory({ user: USER, pid: "1", facilityCode: "NXS1", ...caps });
  assert.deepEqual(result, { pid: "1", totalInventory: 0, blockedInventory: 0, availableInventory: 0 });
});

test("dispatch-level failure (no online/approved runtime) propagates as a thrown error, never a silently empty/zeroed result", async () => {
  const caps = makeFakeCapability({ dispatchFails: true, dispatchReason: "No online, approved runtime currently advertises this capability" });
  await assert.rejects(() => fetchBlockedInventory({ user: USER, pid: "1", facilityCode: "NXS1", ...caps }), /No online, approved runtime/);
});

test("thrown error carries a distinguishing code", async () => {
  const caps = makeFakeCapability({ dispatchFails: true, dispatchReason: "Runtime offline" });
  try {
    await fetchBlockedInventory({ user: USER, pid: "1", facilityCode: "NXS1", ...caps });
    assert.fail("must throw");
  } catch (e) {
    assert.equal(e.code, "NEXS_BLOCKED_INVENTORY_ERROR");
    assert.match(e.message, /Runtime offline/);
  }
});

test("a non-COMPLETED terminal status (TIMEOUT/FAILED/CANCELLED) is a thrown error, not a silently-empty result", async () => {
  const caps = makeFakeCapability({ data: {}, terminalStatus: "TIMEOUT" });
  await assert.rejects(() => fetchBlockedInventory({ user: USER, pid: "1", facilityCode: "NXS1", ...caps }), /ended in status TIMEOUT/);
});

test("normalize() is exported standalone and matches the legacy extraction exactly: Number(r.data.X)||0 for each of the three fields", () => {
  assert.deepEqual(
    normalize("5", { data: { totalInventory: "500", blockedInventory: "120", availableInventory: "380" } }),
    { pid: "5", totalInventory: 500, blockedInventory: 120, availableInventory: 380 },
    "numeric strings coerce via Number(), same as the legacy extension"
  );
  assert.deepEqual(normalize("5", null), { pid: "5", totalInventory: 0, blockedInventory: 0, availableInventory: 0 });
  assert.deepEqual(normalize("5", {}), { pid: "5", totalInventory: 0, blockedInventory: 0, availableInventory: 0 });
});

test("never imports quadronPull/toteDispatchLoop/totePullEngine/autoEngine - read-only, obtains data only", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../../../integrations/nexs/nexsBlockedInventoryProvider.js"), "utf8");
  assert.doesNotMatch(src, /require\(\s*["'][^"']*(quadronPull|toteDispatchLoop|totePullEngine|autoEngine)["']\s*\)/);
});

test("never requests PULL_QUADRON_TOTE - only ever GET_NEXS_BLOCKED_INVENTORY", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../../../integrations/nexs/nexsBlockedInventoryProvider.js"), "utf8");
  assert.doesNotMatch(src, /PULL_QUADRON_TOTE/);
  assert.match(src, /GET_NEXS_BLOCKED_INVENTORY/);
});

// ── fetchBlockedInventoryBatch (NEXS batch-capability refactor) ─────────

test("empty PID list: returns an empty blockedMap, never dispatches a capability request", async () => {
  let dispatched = false;
  const requestCapability = async () => { dispatched = true; return { ok: true, query: { query_id: "Q-X" } }; };
  const result = await fetchBlockedInventoryBatch({ user: USER, pids: [], facilityCode: "NXS1", requestCapability });
  assert.equal(Object.keys(result).length, 0);
  assert.equal(dispatched, false);
});

test("a non-array pids value also returns an empty blockedMap without dispatching", async () => {
  let dispatched = false;
  const requestCapability = async () => { dispatched = true; return { ok: true, query: { query_id: "Q-X" } }; };
  const result = await fetchBlockedInventoryBatch({ user: USER, pids: null, facilityCode: "NXS1", requestCapability });
  assert.equal(Object.keys(result).length, 0);
  assert.equal(dispatched, false);
});

test("dispatches GET_NEXS_BLOCKED_INVENTORY_BATCH exactly once with pids/facilityCode, regardless of how many PIDs are requested", async () => {
  const caps = makeFakeBatchCapability({
    results: [
      { pid: "1", status: "ok", totalInventory: 500, blockedInventory: 120, availableInventory: 380, error: null },
      { pid: "2", status: "ok", totalInventory: 42, blockedInventory: 0, availableInventory: 42, error: null },
    ],
  });
  await fetchBlockedInventoryBatch({ user: USER, pids: ["1", "2"], facilityCode: "NXS2", ...caps });
  assert.equal(caps.dispatchedParams.length, 1, "exactly one capability dispatch for the whole batch");
  assert.deepEqual(caps.dispatchedParams[0], { pids: ["1", "2"], facilityCode: "NXS2" });
});

test("successful multi-PID batch: blockedMap has one ok:true entry per PID, correctly normalized", async () => {
  const caps = makeFakeBatchCapability({
    results: [
      { pid: "1", status: "ok", totalInventory: 500, blockedInventory: 120, availableInventory: 380, error: null },
      { pid: "2", status: "ok", totalInventory: "42", blockedInventory: 0, availableInventory: 42, error: null },
    ],
  });
  const result = await fetchBlockedInventoryBatch({ user: USER, pids: ["1", "2"], facilityCode: "NXS1", ...caps });
  assert.deepEqual(result["1"], { ok: true, totalInventory: 500, blockedInventory: 120, availableInventory: 380 });
  assert.deepEqual(result["2"], { ok: true, totalInventory: 42, blockedInventory: 0, availableInventory: 42 }, "numeric-string fields coerce via Number(), same as the single-PID path");
});

test("partial PID failures: one PID's status:'failed' entry isolates to that PID alone, the rest stay ok:true", async () => {
  const caps = makeFakeBatchCapability({
    results: [
      { pid: "1", status: "ok", totalInventory: 500, blockedInventory: 120, availableInventory: 380, error: null },
      { pid: "2", status: "failed", totalInventory: 0, blockedInventory: 0, availableInventory: 0, error: "NexS HTTP 500" },
      { pid: "3", status: "ok", totalInventory: 10, blockedInventory: 0, availableInventory: 10, error: null },
    ],
  });
  const result = await fetchBlockedInventoryBatch({ user: USER, pids: ["1", "2", "3"], facilityCode: "NXS1", ...caps });
  assert.equal(result["1"].ok, true);
  assert.equal(result["3"].ok, true);
  assert.deepEqual(result["2"], { ok: false, reason: "NexS HTTP 500" });
});

test("a PID missing entirely from the runtime's results (never blindly trusted) is reported failed, isolated to that PID", async () => {
  const caps = makeFakeBatchCapability({
    results: [{ pid: "1", status: "ok", totalInventory: 500, blockedInventory: 120, availableInventory: 380, error: null }],
  });
  const result = await fetchBlockedInventoryBatch({ user: USER, pids: ["1", "2"], facilityCode: "NXS1", ...caps });
  assert.equal(result["1"].ok, true);
  assert.deepEqual(result["2"], { ok: false, reason: "PID missing from batch result" });
});

test("dispatch-level failure (no capable runtime): every requested PID is reported failed with the same real reason - never a thrown error, never a silently empty map", async () => {
  const caps = makeFakeBatchCapability({ dispatchFails: true, dispatchReason: "No online, approved runtime currently advertises this capability" });
  const result = await fetchBlockedInventoryBatch({ user: USER, pids: ["1", "2", "3"], facilityCode: "NXS1", ...caps });
  assert.equal(Object.keys(result).length, 3);
  for (const pid of ["1", "2", "3"]) {
    assert.deepEqual(result[pid], { ok: false, reason: "No online, approved runtime currently advertises this capability" });
  }
});

test("a non-COMPLETED terminal status (TIMEOUT/FAILED/CANCELLED) reports every PID failed with that status in the reason, not a thrown error", async () => {
  const caps = makeFakeBatchCapability({ results: [], terminalStatus: "TIMEOUT" });
  const result = await fetchBlockedInventoryBatch({ user: USER, pids: ["1", "2"], facilityCode: "NXS1", ...caps });
  assert.match(result["1"].reason, /ended in status TIMEOUT/);
  assert.match(result["2"].reason, /ended in status TIMEOUT/);
});

test("facility code is threaded through to the batch dispatch params unchanged", async () => {
  const caps = makeFakeBatchCapability({ results: [{ pid: "1", status: "ok", totalInventory: 1, blockedInventory: 0, availableInventory: 1, error: null }] });
  await fetchBlockedInventoryBatch({ user: USER, pids: ["1"], facilityCode: "NXS3", ...caps });
  assert.equal(caps.dispatchedParams[0].facilityCode, "NXS3");
});

test("fetchBlockedInventory (single-PID) is unchanged and still exported for backward compatibility", async () => {
  assert.equal(typeof fetchBlockedInventory, "function");
});

// ── wait() throwing (local safety-net deadline exceeded) is handled, never
// an uncaught rejection - regression coverage for a gap found while
// investigating the observed GET_QUADRON_INVENTORY TIMEOUT: neither
// function previously wrapped its wait(queryId) call, so if the shared
// local poll deadline in queryPoll.js ever fired, it would propagate as an
// uncaught exception instead of a normal, isolated failure. ─────────────

test("fetchBlockedInventory: a thrown wait() (local deadline exceeded) surfaces as the normal NEXS_BLOCKED_INVENTORY_ERROR, not an uncaught exception", async () => {
  const requestCapability = async () => ({ ok: true, query: { query_id: "Q-1" } });
  const wait = async () => { throw new Error("Timed out locally waiting for query Q-1 to reach a terminal status"); };
  try {
    await fetchBlockedInventory({ user: USER, pid: "1", facilityCode: "NXS1", requestCapability, wait, getResult: () => null });
    assert.fail("must throw");
  } catch (e) {
    assert.equal(e.code, "NEXS_BLOCKED_INVENTORY_ERROR");
    assert.match(e.message, /Timed out locally waiting/);
  }
});

test("fetchBlockedInventoryBatch: a thrown wait() (local deadline exceeded) degrades to every requested PID reported failed - never an uncaught exception, never a hard-failed whole batch", async () => {
  const requestCapability = async () => ({ ok: true, query: { query_id: "Q-BATCH-1" } });
  const wait = async () => { throw new Error("Timed out locally waiting for query Q-BATCH-1 to reach a terminal status"); };
  const result = await fetchBlockedInventoryBatch({ user: USER, pids: ["1", "2", "3"], facilityCode: "NXS1", requestCapability, wait, getResult: () => null });
  for (const pid of ["1", "2", "3"]) {
    assert.deepEqual(result[pid], { ok: false, reason: "Timed out locally waiting for query Q-BATCH-1 to reach a terminal status" });
  }
});

test("fetchBlockedInventoryBatch: a large PID list goes to NexS in chunks, and a failed chunk only fails its own PIDs", async () => {
  const { fetchBlockedInventoryBatch, CHUNK_PIDS } = require("../../../integrations/nexs/nexsBlockedInventoryProvider");
  const pids = Array.from({ length: CHUNK_PIDS * 2 + 10 }, (_, i) => `P${i}`);
  const sent = [];
  const map = await fetchBlockedInventoryBatch({
    user: { id: 1 }, pids, facilityCode: "NXS1",
    requestCapability: async ({ params }) => { sent.push(params.pids); return { ok: true, query: { query_id: `Q${sent.length}` } }; },
    wait: async (id) => ({ status: id === "Q2" ? "TIMEOUT" : "COMPLETED" }),
    getResult: (id) => ({ results: sent[Number(id.slice(1)) - 1].map((pid) => ({ pid, status: "ok", totalInventory: 1, blockedInventory: 0, availableInventory: 1 })) }),
  });
  // three chunks, then ONE retry pass for the chunk that timed out (it succeeds the second time)
  assert.deepEqual(sent.map((c) => c.length), [CHUNK_PIDS, CHUNK_PIDS, 10, CHUNK_PIDS]);
  assert.equal(map.P0.ok, true);
  assert.equal(map[`P${CHUNK_PIDS}`].ok, true, "the timed-out chunk was retried and landed");
  assert.equal(map[`P${CHUNK_PIDS * 2 + 9}`].ok, true, "the chunk after it still ran");
});

test("fetchBlockedInventoryBatch: a PID that fails again on the retry is reported failed (one retry only), with progress", async () => {
  const { fetchBlockedInventoryBatch } = require("../../../integrations/nexs/nexsBlockedInventoryProvider");
  const progress = [];
  let n = 0;
  const map = await fetchBlockedInventoryBatch({
    user: { id: 1 }, pids: ["A", "B"], facilityCode: "NXS1",
    onProgress: (p) => progress.push(p),
    requestCapability: async () => ({ ok: true, query: { query_id: `Q${++n}` } }),
    wait: async () => ({ status: "CANCELLED" }),
    getResult: () => null,
  });
  assert.equal(n, 2, "the first try and one retry - never more");
  assert.equal(map.A.ok, false);
  assert.match(map.A.reason, /CANCELLED/);
  assert.deepEqual(progress.map((p) => [p.done, p.total, p.retrying]), [[2, 2, false], [0, 2, true], [2, 2, true]]);
});
