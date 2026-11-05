const test = require("node:test");
const assert = require("node:assert/strict");
const { pack, unpack } = require("../../../platform/storage/jsonBlob");

test("small values stay plain JSON and round-trip", async () => {
  const text = await pack({ a: 1 });
  assert.equal(text, '{"a":1}');
  assert.deepEqual(await unpack(text), { a: 1 });
});

test("a large value is stored gzipped (much smaller) and round-trips exactly", async () => {
  const value = { detail: Array.from({ length: 20000 }, (_, i) => ({ toteId: "TL" + String(i).padStart(10, "0"), quantity: i % 50, utilisation: 0.5 })) };
  const raw = JSON.stringify(value);
  const text = await pack(value);
  assert.ok(text.startsWith("gz1:"));
  assert.ok(text.length < raw.length / 4, `packed ${text.length} vs raw ${raw.length}`);
  assert.deepEqual(await unpack(text), value);
});

test("unpack reads rows written before packing existed, and tolerates null / pre-parsed values", async () => {
  assert.deepEqual(await unpack('{"old":true}'), { old: true });
  assert.equal(await unpack(null), null);
  assert.deepEqual(await unpack({ already: "parsed" }), { already: "parsed" });
});
