// Pure unit tests for server/features/tote-puller/autoDiff.js - the differential merge
// between a freshly classified tote list and Auto's still-queued state.
// No database, no network, no capability call, no Quadron mutation.

const test = require("node:test");
const assert = require("node:assert/strict");
const { AutoQueue } = require("../../../features/tote-puller/autoQueue");
const { diffAndMerge } = require("../../../features/tote-puller/autoDiff");

function classified(toteId, priority, overrides = {}) {
  return { toteId, priority, source: "Quadron API", worstPid: null, scarcityCount: null, ...overrides };
}

test("insert: a brand-new classified tote not already queued is inserted", () => {
  const q = new AutoQueue();
  const result = diffAndMerge(q, [classified("TS0000000001", "P1")]);
  assert.deepEqual(result.inserted, ["TS0000000001"]);
  assert.equal(q.snapshot().p1Count, 1);
});

test("vanished: a queued tote absent from the fresh classification is removed", () => {
  const q = new AutoQueue();
  q.insert("TS0000000001", "P2", "Locked Tote Dump");
  const result = diffAndMerge(q, []); // fresh dump no longer contains it
  assert.deepEqual(result.removed, ["TS0000000001"]);
  assert.equal(q.totalSize(), 0);
});

test("reappearing tote: removed on one merge, then treated as a brand-new insert on a later merge (not a special-cased reappearance)", () => {
  const q = new AutoQueue();
  diffAndMerge(q, [classified("TS0000000001", "P2")]);
  assert.equal(q.has("TS0000000001"), true);

  const gone = diffAndMerge(q, []); // disappears
  assert.deepEqual(gone.removed, ["TS0000000001"]);
  assert.equal(q.has("TS0000000001"), false);

  const back = diffAndMerge(q, [classified("TS0000000001", "P2")]); // reappears
  assert.deepEqual(back.inserted, ["TS0000000001"], "reappearance is a fresh insert, not a reprioritize");
  assert.deepEqual(back.reprioritized, []);
  assert.equal(q.has("TS0000000001"), true);
});

test("priority change: an already-queued tote whose priority changed is relocated, not duplicated", () => {
  const q = new AutoQueue();
  diffAndMerge(q, [classified("TS0000000001", "P2")]);
  const result = diffAndMerge(q, [classified("TS0000000001", "P1")]);
  assert.deepEqual(result.reprioritized, ["TS0000000001"]);
  assert.deepEqual(result.inserted, []);
  const snap = q.snapshot();
  assert.equal(snap.p2Count, 0);
  assert.equal(snap.p1Count, 1);
});

test("priority unchanged: an already-queued tote reclassified at the SAME priority is neither inserted nor reported as reprioritized", () => {
  const q = new AutoQueue();
  diffAndMerge(q, [classified("TS0000000001", "P2")]);
  const result = diffAndMerge(q, [classified("TS0000000001", "P2", { worstPid: "SKU-NEW" })]);
  assert.deepEqual(result.inserted, []);
  assert.deepEqual(result.reprioritized, []);
  assert.equal(q.snapshot().p2[0].worstPid, "SKU-NEW", "metadata still refreshes even without a bucket change");
});

test("SD/P0 arrival: a merge that promotes a tote to SD or P0 sets the preempt flag", () => {
  const q = new AutoQueue();
  diffAndMerge(q, [classified("TS0000000001", "P2")]);
  assert.equal(q.shouldPreempt(), false);
  diffAndMerge(q, [classified("TS0000000001", "SD", { source: "Supervisor Dump" })]);
  assert.equal(q.shouldPreempt(), true);
});

test("SD/P0 arrival: a merge that INSERTS a new SD/P0 tote (not a reprioritize) also sets the preempt flag", () => {
  const q = new AutoQueue();
  assert.equal(q.shouldPreempt(), false, "a fresh queue starts with preempt false");
  diffAndMerge(q, [classified("TS0000000001", "P0")]);
  assert.equal(q.shouldPreempt(), true);
});

test("in-flight/already-batched tote is completely outside merge scope, even if it vanishes from the source dump", () => {
  const q = new AutoQueue();
  diffAndMerge(q, [classified("TS0000000001", "P0"), classified("TS0000000002", "P1")]);
  const batch = q.next(1); // pulls TS0000000001 (P0) out of the queue - now "in flight"
  assert.deepEqual(batch.map((e) => e.toteId), ["TS0000000001"]);

  // A merge that no longer sees either tote in the fresh dump must only
  // affect what's STILL queued (TS0000000002) - the in-flight tote is
  // untouched, structurally invisible to this function.
  const result = diffAndMerge(q, []);
  assert.deepEqual(result.removed, ["TS0000000002"], "only the still-queued tote is removed");
  assert.ok(!result.removed.includes("TS0000000001"), "the in-flight tote must never appear in a merge's removed list");
});

test("a merge with multiple simultaneous changes reports each correctly: one insert, one remove, one reprioritize", () => {
  const q = new AutoQueue();
  diffAndMerge(q, [classified("STAYS-SAME", "P2"), classified("VANISHES", "P2"), classified("CHANGES", "P2")]);

  const result = diffAndMerge(q, [
    classified("STAYS-SAME", "P2"),
    classified("CHANGES", "P0"),
    classified("NEW-ONE", "P1"),
  ]);

  assert.deepEqual(result.removed, ["VANISHES"]);
  assert.deepEqual(result.inserted, ["NEW-ONE"]);
  assert.deepEqual(result.reprioritized, ["CHANGES"]);
});

test("empty classification against an empty queue is a true no-op", () => {
  const q = new AutoQueue();
  const result = diffAndMerge(q, []);
  assert.deepEqual(result, { removed: [], inserted: [], reprioritized: [] });
  assert.equal(q.totalSize(), 0);
});
