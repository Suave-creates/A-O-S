const test = require("node:test");
const assert = require("node:assert/strict");
const { runPass, afterSession, judge, stockOf, readIsDue, WINDOW_MS } = require("../../../features/tote-puller/purgeTracking");

const T0 = Date.UTC(2026, 9, 15, 7, 0, 0);
const q = (toteId, quadronQty, skus) => ({ toteId, quadronQty, partitions: skus.map((s, i) => ({ part: i + 1, qty: 1, sku: s })) });
const inv = (rows) => async () => ({ ok: true, rows });
const open = (o) => ({ id: 1, tote: "TL0000000001", pulledAtMs: T0, doneAtMs: T0, snapshotAt: null, baselineQty: null, baselineSkus: null, ...o });

function fakeMarks(rows) {
  const log = { baseline: [], status: [], done: [] };
  return { log, async loadOpen() { return rows; }, async setBaseline(id, qty, skus) { log.baseline.push([id, qty, skus]); }, async setStatus(id, s) { log.status.push([id, s]); }, async markSessionDone(id) { log.done.push(id); } };
}

test("judge: empty -> PURGED; same PIDs with fewer or equal units -> PENDING; a new PID or more units -> RESTOCKED", () => {
  const row = open({ baselineQty: 6, baselineSkus: ["111", "222"] });
  assert.equal(judge(row, undefined), "PURGED");
  assert.equal(judge(row, { qty: 0, skus: new Set() }), "PURGED");
  assert.equal(judge(row, { qty: 6, skus: new Set(["111", "222"]) }), "PENDING");
  assert.equal(judge(row, { qty: 2, skus: new Set(["111"]) }), "PENDING", "partly counted down is still a normal CC");
  assert.equal(judge(row, { qty: 5, skus: new Set(["111", "999"]) }), "RESTOCKED");
  assert.equal(judge(row, { qty: 9, skus: new Set(["111"]) }), "RESTOCKED");
});

test("the first pass after calling takes the baseline from Quadron (units + PIDs) and decides nothing", async () => {
  const marks = fakeMarks([open({})]);
  const r = await runPass({ marks, now: () => T0 + 60000, force: true, fetchInventory: inv([q("TL0000000001", 6, ["111", "222"])]) });
  assert.deepEqual(marks.log.baseline, [[1, 6, ["111", "222"]]]);
  assert.deepEqual(marks.log.status, []);
  assert.deepEqual(r, { watched: 1, purged: 0, restocked: 0, expired: 0 });
});

test("a baselined tote that Quadron later shows empty is PURGED; one decanted with new PIDs first is RESTOCKED", async () => {
  const marks = fakeMarks([
    open({ id: 1, tote: "TL0000000001", baselineQty: 6, baselineSkus: ["111"] }),
    open({ id: 2, tote: "TL0000000002", baselineQty: 4, baselineSkus: ["222"] }),
    open({ id: 3, tote: "TL0000000003", baselineQty: 4, baselineSkus: ["333"] }),
  ]);
  const r = await runPass({ marks, now: () => T0 + 3600000, force: true, fetchInventory: inv([q("TL0000000002", 8, ["222", "777"]), q("TL0000000003", 4, ["333"]), q("TL0000000099", 1, ["1"])]) });
  assert.deepEqual(marks.log.status, [[1, "PURGED"], [2, "RESTOCKED"]]);
  assert.deepEqual(r, { watched: 3, purged: 1, restocked: 1, expired: 0 });
});

test("a tote already empty at its first look is PURGED straight away", async () => {
  const marks = fakeMarks([open({})]);
  await runPass({ marks, now: () => T0 + 60000, force: true, fetchInventory: inv([q("TL0000000099", 1, ["1"])]) });
  assert.deepEqual(marks.log.status, [[1, "PURGED"]]);
});

test("nothing decided inside 2 days -> EXPIRED, and no Quadron read is made for it", async () => {
  const marks = fakeMarks([open({ baselineQty: 6, baselineSkus: ["111"] })]);
  let reads = 0;
  const r = await runPass({ marks, now: () => T0 + WINDOW_MS + 1000, force: true, fetchInventory: async () => { reads += 1; return { ok: true, rows: [] }; } });
  assert.deepEqual(marks.log.status, [[1, "EXPIRED"]]);
  assert.equal(reads, 0);
  assert.equal(r.expired, 1);
});

test("a failed or empty Quadron read never marks anything", async () => {
  for (const fetchInventory of [async () => ({ ok: false, rows: [] }), inv([])]) {
    const marks = fakeMarks([open({ baselineQty: 6, baselineSkus: ["111"] })]);
    await runPass({ marks, now: () => T0 + 3600000, force: true, fetchInventory });
    assert.deepEqual(marks.log.status, []);
  }
});

test("readIsDue: always soon after the calling, then only every 30 minutes; never with nothing watched", () => {
  const fresh = [open({ doneAtMs: T0 })];
  assert.equal(readIsDue(fresh, T0, T0 + 10 * 60000), true);
  assert.equal(readIsDue(fresh, T0 + 7 * 3600000 - 60000, T0 + 7 * 3600000), false, "a read 1 minute ago, call finished 7 h ago");
  assert.equal(readIsDue(fresh, T0 + 6 * 3600000, T0 + 7 * 3600000), true, "last read an hour ago");
  assert.equal(readIsDue([], 0, T0), false);
});

test("afterSession marks the calling done and baselines at once", async () => {
  // afterSession reads the real clock (it takes no `now`), so the row must be recent or the 2-day window expires it.
  const marks = fakeMarks([open({ pulledAtMs: Date.now(), doneAtMs: Date.now() })]);
  await afterSession("S1", { marks, fetchInventory: inv([q("TL0000000001", 3, ["111"])]) });
  assert.deepEqual(marks.log.done, ["S1"]);
  assert.equal(marks.log.baseline.length, 1);
});

test("stockOf sums a tote's lines and collects the PIDs that hold units", () => {
  const m = stockOf([q("TL0000000001-1", 2, ["111"]), { toteId: "TL0000000001", quadronQty: 3, partitions: [{ part: 2, qty: 3, sku: "222" }, { part: 3, qty: 0, sku: "333" }] }]);
  assert.equal(m.get("TL0000000001").qty, 5);
  assert.deepEqual([...m.get("TL0000000001").skus].sort(), ["111", "222"]);
});
