// Unit tests for server/features/bulk-inventory-check/bulkInventoryCheckEngine.js. requestCapability/
// wait/getResult/qm are injected fakes - no real capability dispatch, no
// database.

const test = require("node:test");
const assert = require("node:assert/strict");
const { checkBulkInventory, normalizeTotes, groupRowsByTote } = require("../../../features/bulk-inventory-check/bulkInventoryCheckEngine");

// ── normalizeTotes() ───────────────────────────────────────────────────

test("normalizeTotes(): uppercases, trims, and dedupes while preserving first-seen order", () => {
  assert.deepEqual(normalizeTotes([" tl0000025362 ", "TL0000025362", "TS0000018492"]), ["TL0000025362", "TS0000018492"]);
});

test("normalizeTotes(): throws 400 on an empty array", () => {
  assert.throws(() => normalizeTotes([]), (e) => e.code === 400 && /at least one tote/i.test(e.message));
});

test("normalizeTotes(): throws 400 when every entry is blank/whitespace", () => {
  assert.throws(() => normalizeTotes(["", "   ", null]), (e) => e.code === 400);
});

test("normalizeTotes(): throws 400 on an invalid tote id, naming it (uppercased, matching its own normalization) in the message", () => {
  assert.throws(() => normalizeTotes(["TL0000025362", "not-a-tote"]), (e) => e.code === 400 && /NOT-A-TOTE/.test(e.message));
});

test("normalizeTotes(): throws 400 when the list exceeds MAX_TOTES", () => {
  const { MAX_TOTES } = require("../../../integrations/grafana/grafanaToteInventoryCheck");
  const totes = Array.from({ length: MAX_TOTES + 1 }, (_, i) => `TL${String(i).padStart(10, "0")}`);
  assert.throws(() => normalizeTotes(totes), (e) => e.code === 400 && /exceeds the/.test(e.message));
});

// ── groupRowsByTote() ──────────────────────────────────────────────────

test("groupRowsByTote(): a tote with matching rows is grouped found:true, partitions sorted numerically", () => {
  const rows = [
    { container: "TL0000025362-2", partition: "2", sku: "A" },
    { container: "TL0000025362-1", partition: "1", sku: "B" },
  ];
  const result = groupRowsByTote(["TL0000025362"], rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].found, true);
  assert.deepEqual(result[0].partitions.map((p) => p.partition), ["1", "2"]);
});

test("groupRowsByTote(): a tote with zero matching rows still gets its own entry, found:false, never silently dropped", () => {
  const result = groupRowsByTote(["TL0000025362", "TS0000018492"], [{ container: "TL0000025362-1", partition: "1" }]);
  assert.equal(result.length, 2);
  assert.equal(result[0].found, true);
  assert.equal(result[1].tote, "TS0000018492");
  assert.equal(result[1].found, false);
  assert.deepEqual(result[1].partitions, []);
});

test("groupRowsByTote(): a row whose base doesn't match any requested tote is never attributed anywhere (defensive)", () => {
  const result = groupRowsByTote(["TL0000025362"], [{ container: "TL9999999999-1" }]);
  assert.equal(result[0].found, false);
});

test("groupRowsByTote(): preserves the originally-requested tote order in its output", () => {
  const result = groupRowsByTote(["B0000000000".replace("B", "TL"), "TS0000018492"], []);
  assert.deepEqual(result.map((r) => r.tote), ["TL0000000000", "TS0000018492"]);
});

// ── checkBulkInventory() orchestration ──────────────────────────────────

function fakeQm() {
  const calls = [];
  return {
    calls,
    registerJob: () => calls.push("registerJob"),
    markRunning: async () => calls.push("markRunning"),
    completeQuery: async () => calls.push("completeQuery"),
    failQuery: async (id, reason) => calls.push(`failQuery:${reason}`),
    unregisterJob: () => calls.push("unregisterJob"),
  };
}

test("checkBulkInventory(): on success, dispatches GET_GRAFANA_TOTE_INVENTORY_CHECK with the normalized totes and returns grouped items", async () => {
  const qm = fakeQm();
  let dispatchedParams;
  const requestCapability = async ({ capabilityName, params }) => {
    dispatchedParams = { capabilityName, params };
    return { ok: true, query: { query_id: "Q-INNER" } };
  };
  const wait = async () => ({ status: "COMPLETED" });
  const getResult = () => ({ rows: [{ container: "TL0000025362-1", partition: "1", sku: "X" }] });

  const result = await checkBulkInventory({
    queryId: "Q-OUTER",
    user: { id: 1 },
    totes: ["tl0000025362"],
    requestCapability,
    wait,
    getResult,
    qm,
  });

  assert.equal(dispatchedParams.capabilityName, "GET_GRAFANA_TOTE_INVENTORY_CHECK");
  assert.deepEqual(dispatchedParams.params, { totes: ["TL0000025362"] });
  assert.equal(result.requestedCount, 1);
  assert.equal(result.foundCount, 1);
  assert.equal(result.notFoundCount, 0);
  assert.equal(result.items[0].found, true);
  assert.ok(qm.calls.includes("completeQuery"));
});

test("checkBulkInventory(): a dispatch failure fails the outer query and propagates the reason", async () => {
  const qm = fakeQm();
  const requestCapability = async () => ({ ok: false, reason: "No online runtime", code: 503 });
  await assert.rejects(
    checkBulkInventory({ queryId: "Q-OUTER", user: { id: 1 }, totes: ["TL0000025362"], requestCapability, qm }),
    (e) => e.code === 503 && /No online runtime/.test(e.message)
  );
  assert.ok(qm.calls.some((c) => c.startsWith("failQuery:")));
});

test("checkBulkInventory(): a non-COMPLETED inner query status fails loudly with that status named", async () => {
  const qm = fakeQm();
  const requestCapability = async () => ({ ok: true, query: { query_id: "Q-INNER" } });
  const wait = async () => ({ status: "TIMEOUT" });
  await assert.rejects(
    checkBulkInventory({ queryId: "Q-OUTER", user: { id: 1 }, totes: ["TL0000025362"], requestCapability, wait, qm }),
    /ended in status TIMEOUT/
  );
});

test("checkBulkInventory(): an invalid tote list fails before any capability dispatch is attempted", async () => {
  const qm = fakeQm();
  let dispatched = false;
  const requestCapability = async () => { dispatched = true; return { ok: true, query: { query_id: "Q-INNER" } }; };
  await assert.rejects(
    checkBulkInventory({ queryId: "Q-OUTER", user: { id: 1 }, totes: ["not-a-tote"], requestCapability, qm }),
    (e) => e.code === 400
  );
  assert.equal(dispatched, false, "must validate before ever attempting a dispatch");
});

test("checkBulkInventory(): multiple requested totes with a mix of found/not-found are counted correctly", async () => {
  const qm = fakeQm();
  const requestCapability = async () => ({ ok: true, query: { query_id: "Q-INNER" } });
  const wait = async () => ({ status: "COMPLETED" });
  const getResult = () => ({ rows: [{ container: "TL0000025362-1" }] });
  const result = await checkBulkInventory({
    queryId: "Q-OUTER",
    user: { id: 1 },
    totes: ["TL0000025362", "TS0000018492"],
    requestCapability,
    wait,
    getResult,
    qm,
  });
  assert.equal(result.requestedCount, 2);
  assert.equal(result.foundCount, 1);
  assert.equal(result.notFoundCount, 1);
});
