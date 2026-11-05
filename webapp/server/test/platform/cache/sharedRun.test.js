const test = require("node:test");
const assert = require("node:assert/strict");
const { createSharedRun, listKey } = require("../../../platform/cache/sharedRun");

test("two callers with the same key while it runs share ONE run and get the same result", async () => {
  const runs = createSharedRun();
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const fn = async () => { calls++; await gate; return { n: calls }; };
  const a = runs.run("k", {}, fn);
  const b = runs.run("k", {}, fn);
  assert.equal(runs.isRunning("k"), true);
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(ra, rb);
  assert.equal(runs.isRunning("k"), false);
});

test("within freshMs a finished result is reused; after it, the next caller runs again", async () => {
  let t = 1000;
  const runs = createSharedRun({ now: () => t });
  let calls = 0;
  const fn = async () => ++calls;
  assert.equal(await runs.run("k", { freshMs: 500 }, fn), 1);
  t += 400;
  assert.equal(await runs.run("k", { freshMs: 500 }, fn), 1, "reused inside the window");
  t += 200;
  assert.equal(await runs.run("k", { freshMs: 500 }, fn), 2, "re-run once stale");
});

test("a failure is never cached and different keys never share", async () => {
  const runs = createSharedRun();
  let calls = 0;
  await assert.rejects(runs.run("k", { freshMs: 10000 }, async () => { calls++; throw new Error("upstream down"); }));
  assert.equal(await runs.run("k", { freshMs: 10000 }, async () => ++calls), 2);
  assert.equal(await runs.run("other", { freshMs: 10000 }, async () => "x"), "x");
});

test("listKey ignores order, case, blanks and duplicates", () => {
  assert.equal(listKey(["tl2", "TL1", " tl2 ", ""]), listKey(["TL1", "TL2"]));
});
