const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../../../platform/storage/sharedResults");

function fakeDb(rows = []) {
  const writes = [];
  return { writes, query: async () => rows, execute: async (sql, params) => { writes.push(params); } };
}

test("the latest run is shared: who, when, a version that rises with every run, and the full result", async () => {
  const db = fakeDb();
  const store = create({ db });
  assert.equal(await store.header("tracker"), null, "nothing run yet");
  await store.set("tracker", { result: { rows: [1] }, runBy: "E1", meta: { mode: "auto" } });
  const h1 = await store.header("tracker");
  assert.equal(h1.version, 1);
  assert.equal(h1.runBy, "E1");
  assert.equal(h1.result, undefined, "the header never carries the (large) result");
  await store.set("tracker", { result: { rows: [1, 2] }, runBy: "E2" });
  assert.equal((await store.header("tracker")).version, 2);
  assert.deepEqual((await store.get("tracker")).result, { rows: [1, 2] });
  assert.equal(db.writes.length, 2, "stored in MySQL so a restart keeps it");
});

test("after a restart the stored run is served again", async () => {
  const db = fakeDb([{ result_json: JSON.stringify({ items: [] }), meta_json: JSON.stringify({ count: 3 }), run_by: "E7", run_at: "2026-11-04T10:00:00.000Z" }]);
  const last = await create({ db }).get("bulkInventoryCheck");
  assert.equal(last.runBy, "E7");
  assert.deepEqual(last.meta, { count: 3 });
  assert.deepEqual(last.result, { items: [] });
});
