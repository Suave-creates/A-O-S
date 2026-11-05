// Pure unit tests for server/features/tote-puller/autoQueue.js - Auto Mode's SD/P0/P1/P2
// priority queue. No database, no network, no capability call, no Quadron
// mutation anywhere in this file.

const test = require("node:test");
const assert = require("node:assert/strict");
const { AutoQueue, MAX_QUEUE_SIZE, STARVATION_THRESHOLD } = require("../../../features/tote-puller/autoQueue");

test("insert: adds a tote to the correct priority bucket", () => {
  const q = new AutoQueue();
  assert.equal(q.insert("TS0000000001", "P0", "Quadron API"), "inserted");
  const snap = q.snapshot();
  assert.equal(snap.p0Count, 1);
  assert.equal(snap.p0[0].toteId, "TS0000000001");
});

test("insert: duplicate protection - a tote already in ANY bucket cannot be re-inserted", () => {
  const q = new AutoQueue();
  q.insert("TS0000000001", "P2", "Locked Tote Dump");
  const outcome = q.insert("TS0000000001", "SD", "Supervisor Dump"); // even a different priority
  assert.equal(outcome, "duplicate");
  assert.equal(q.totalSize(), 1);
  assert.equal(q.snapshot().p2Count, 1, "the tote must stay in its original bucket, not move via insert()");
});

test("insert: rejects an invalid (empty/non-string) tote id", () => {
  const q = new AutoQueue();
  assert.equal(q.insert("", "P2"), "invalid");
  assert.equal(q.insert(null, "P2"), "invalid");
  assert.equal(q.totalSize(), 0);
});

test("insert: rejects once the queue is at MAX_QUEUE_SIZE", () => {
  const q = new AutoQueue();
  for (let i = 0; i < MAX_QUEUE_SIZE; i++) q.insert(`TS${String(1000000 + i).padStart(10, "0")}`, "P2");
  assert.equal(q.totalSize(), MAX_QUEUE_SIZE);
  assert.equal(q.insert("TS0000099999", "P2"), "full");
});

test("insert: an unknown priority string falls back to P2", () => {
  const q = new AutoQueue();
  q.insert("TS0000000001", "NOT_A_REAL_PRIORITY");
  assert.equal(q.snapshot().p2Count, 1);
});

test("remove: deletes from whichever bucket currently holds the tote", () => {
  const q = new AutoQueue();
  q.insert("TS0000000001", "SD");
  assert.equal(q.remove("TS0000000001"), true);
  assert.equal(q.totalSize(), 0);
  assert.equal(q.remove("TS0000000001"), false, "removing an absent tote returns false, not an error");
});

test("reprioritize: relocates an already-queued tote to a new bucket and reports true", () => {
  const q = new AutoQueue();
  q.insert("TS0000000001", "P2", "Locked Tote Dump");
  const moved = q.updatePriority("TS0000000001", "P0", "Quadron API", { worstPid: "SKU-A", scarcityCount: 1 });
  assert.equal(moved, true);
  const snap = q.snapshot();
  assert.equal(snap.p2Count, 0);
  assert.equal(snap.p0Count, 1);
  assert.equal(snap.p0[0].source, "Quadron API");
  assert.equal(snap.p0[0].worstPid, "SKU-A");
});

test("reprioritize: same bucket - metadata is still refreshed, but reports false (no relocation)", () => {
  const q = new AutoQueue();
  q.insert("TS0000000001", "P2", "Locked Tote Dump", { worstPid: null, scarcityCount: null });
  const moved = q.updatePriority("TS0000000001", "P2", "Quadron API", { worstPid: "SKU-B", scarcityCount: 9 });
  assert.equal(moved, false);
  const snap = q.snapshot();
  assert.equal(snap.p2Count, 1, "must not duplicate or move within the same bucket");
  assert.equal(snap.p2[0].source, "Quadron API", "metadata refresh happens even when the bucket is unchanged");
  assert.equal(snap.p2[0].worstPid, "SKU-B");
});

test("reprioritize: relocating an already-queued tote to P0 sets the preempt flag", () => {
  const q = new AutoQueue();
  q.insert("TS0000000001", "P1"); // P1 insert does not set preempt
  q.insert("TS0000000002", "P2");
  q.next(2); // drain and clear the preempt flag entirely
  q.insert("TS0000000003", "P1"); // still no preempt
  assert.equal(q.shouldPreempt(), false);
  q.updatePriority("TS0000000003", "P0");
  assert.equal(q.shouldPreempt(), true);
});

test("reprioritize: unknown tote id returns false and touches nothing", () => {
  const q = new AutoQueue();
  assert.equal(q.updatePriority("TS0000009999", "P0"), false);
  assert.equal(q.totalSize(), 0);
});

// ── Starvation guard ─────────────────────────────────────────────────────

test("starvation: forces one P2 tote AHEAD of a still-waiting higher-priority tote once the counter reaches the threshold", () => {
  const q = new AutoQueue();
  q.insert("TS0000000002", "P2");
  // One MORE P0 tote than the threshold, so a P0 tote is still waiting when
  // injection should fire - this is what proves true forced injection
  // rather than P2 merely being picked because nothing else was left.
  for (let i = 0; i < STARVATION_THRESHOLD + 1; i++) {
    q.insert(`TL${String(2000000 + i).padStart(10, "0")}`, "P0");
  }
  // Drain STARVATION_THRESHOLD P0-only batches (size 1) - none contain P2,
  // so the counter climbs from 0 to STARVATION_THRESHOLD across these
  // calls (checked BEFORE each call's own fill, so injection only fires on
  // the NEXT call after the counter has already reached the threshold).
  for (let i = 0; i < STARVATION_THRESHOLD; i++) {
    const batch = q.next(1);
    assert.equal(batch[0].priority, "P0");
  }
  assert.equal(q.snapshot().starvationCounter, STARVATION_THRESHOLD);
  assert.equal(q.snapshot().p0Count, 1, "one P0 tote must still be waiting, unclaimed");

  // This call must force the P2 tote to the front, AHEAD of the still-
  // waiting P0 tote - proof of real injection, not just "nothing else left".
  const finalBatch = q.next(1);
  assert.equal(finalBatch[0].toteId, "TS0000000002");
  assert.equal(finalBatch[0].priority, "P2");
  assert.equal(q.snapshot().starvationCounter, 0, "counter resets the instant a P2 tote is included");
  assert.equal(q.snapshot().p0Count, 1, "the still-waiting P0 tote must remain queued, untouched by injection");
});

test("starvation: counter resets to 0 whenever a batch naturally includes a P2 tote (no injection needed)", () => {
  const q = new AutoQueue();
  q.insert("TS0000000001", "P2");
  q.next(5); // batch of 1 (only tote), includes P2 naturally
  assert.equal(q.snapshot().starvationCounter, 0);
});

test("starvation: a batch that legitimately empties the queue with zero totes does not increment the counter", () => {
  const q = new AutoQueue();
  const batch = q.next(5); // nothing queued at all
  assert.deepEqual(batch, []);
  assert.equal(q.snapshot().starvationCounter, 0);
});

// ── Batch construction / ordering ────────────────────────────────────────

test("batch construction: fills strictly in SD -> P0 -> P1 -> P2 order", () => {
  const q = new AutoQueue();
  q.insert("P2-A", "P2");
  q.insert("P1-A", "P1");
  q.insert("P0-A", "P0");
  q.insert("SD-A", "SD");
  const batch = q.next(4);
  assert.deepEqual(batch.map((e) => e.toteId), ["SD-A", "P0-A", "P1-A", "P2-A"]);
});

test("batch construction: stops exactly at batchSize even with more totes queued", () => {
  const q = new AutoQueue();
  for (let i = 0; i < 10; i++) q.insert(`TS${String(3000000 + i).padStart(10, "0")}`, "P2");
  const batch = q.next(3);
  assert.equal(batch.length, 3);
  assert.equal(q.totalSize(), 7);
});

test("batch extraction removes entries from queued state - next() results are gone from snapshot()", () => {
  const q = new AutoQueue();
  q.insert("TS0000000001", "P0");
  const batch = q.next(1);
  assert.equal(batch.length, 1);
  assert.equal(q.has("TS0000000001"), false);
  assert.equal(q.totalSize(), 0);
});

// ── Preemption flag ───────────────────────────────────────────────────────

test("preempt flag: set by inserting P0 or SD, not by P1/P2", () => {
  const q = new AutoQueue();
  q.insert("TS0000000001", "P1");
  assert.equal(q.shouldPreempt(), false);
  q.insert("TS0000000002", "P2");
  assert.equal(q.shouldPreempt(), false);
  q.insert("TS0000000003", "P0");
  assert.equal(q.shouldPreempt(), true);
});

test("preempt flag: shouldPreempt() is false if the flag is set but SD/P0 are both actually empty (already drained)", () => {
  const q = new AutoQueue();
  q.insert("TS0000000001", "P0");
  q.next(1); // drains the only P0 tote and clears the flag via next()
  assert.equal(q.shouldPreempt(), false);
});

test("preempt flag: cleared by next(), even if it wasn't SD/P0 that got drained", () => {
  const q = new AutoQueue();
  q.insert("TS0000000001", "P0");
  q.insert("TS0000000002", "P2");
  q.next(1); // only drains SD/P0-first, i.e. the P0 tote - flag clears regardless
  assert.equal(q.shouldPreempt(), false);
});

test("isEmpty()/totalSize() reflect the sum across all four buckets", () => {
  const q = new AutoQueue();
  assert.equal(q.isEmpty(), true);
  q.insert("A", "SD");
  q.insert("B", "P0");
  q.insert("C", "P1");
  q.insert("D", "P2");
  assert.equal(q.isEmpty(), false);
  assert.equal(q.totalSize(), 4);
});

// ── requeue() - preempted-batch remainder ────────────────────────────────

test("requeue: reinserts entries preserving their original priority/source/metadata", () => {
  const q = new AutoQueue();
  q.insert("TS0000000001", "P1", "Locked Tote Dump", { worstPid: "SKU-X", scarcityCount: 2 });
  const [entry] = q.next(1);
  assert.equal(q.has("TS0000000001"), false);

  q.requeue([entry]);
  const snap = q.snapshot();
  assert.equal(snap.p1Count, 1);
  assert.equal(snap.p1[0].toteId, "TS0000000001");
  assert.equal(snap.p1[0].source, "Locked Tote Dump");
  assert.equal(snap.p1[0].worstPid, "SKU-X");
  assert.equal(snap.p1[0].scarcityCount, 2);
});

test("requeue: multiple entries all land back in their own original buckets", () => {
  const q = new AutoQueue();
  q.insert("A", "P0");
  q.insert("B", "P1");
  q.insert("C", "P2");
  const batch = q.next(3);
  q.requeue(batch);
  const snap = q.snapshot();
  assert.equal(snap.p0Count, 1);
  assert.equal(snap.p1Count, 1);
  assert.equal(snap.p2Count, 1);
});

// ── peekNext() - Auto Preview/Dry-Run's non-mutating sibling to next() ───

test("peekNext: returns exactly what next() would return, for identical queue state", () => {
  const a = new AutoQueue();
  const b = new AutoQueue();
  for (const q of [a, b]) {
    q.insert("SD1", "SD");
    q.insert("P0-1", "P0");
    q.insert("P1-1", "P1");
    q.insert("P2-1", "P2");
    q.insert("P2-2", "P2");
  }
  const peeked = a.peekNext(3);
  const real = b.next(3);
  // entryId is randomly generated per insert() call (see makeEntryId), so
  // two independently-populated queues never share literal entryId values
  // even for "the same" tote - compare everything ELSE structurally instead.
  const strip = (arr) => arr.map(({ entryId, ...rest }) => rest);
  assert.deepEqual(strip(peeked), strip(real));
});

test("peekNext: does NOT remove anything from the queue", () => {
  const q = new AutoQueue();
  q.insert("A", "P0");
  q.insert("B", "P1");
  const before = q.totalSize();
  const peeked = q.peekNext(5);
  assert.equal(peeked.length, 2);
  assert.equal(q.totalSize(), before, "totalSize must be unchanged after peekNext()");
  assert.equal(q.has("A"), true);
  assert.equal(q.has("B"), true);
});

test("peekNext: does NOT touch the starvation counter", () => {
  const q = new AutoQueue();
  for (let i = 0; i < STARVATION_THRESHOLD; i++) {
    q.insert(`P0-${i}`, "P0");
    q.next(1); // real draws, no P2 present - increments the counter each time
  }
  const snapBefore = q.snapshot();
  assert.equal(snapBefore.starvationCounter, STARVATION_THRESHOLD);

  q.insert("P2-late", "P2");
  q.peekNext(1); // must NOT consume the starvation injection or reset the counter
  const snapAfter = q.snapshot();
  assert.equal(snapAfter.starvationCounter, STARVATION_THRESHOLD, "peekNext() must never mutate the starvation counter");
  assert.equal(q.has("P2-late"), true, "peekNext() must never remove the tote it looked at");
});

test("peekNext: does NOT clear the preempt flag", () => {
  const q = new AutoQueue();
  q.insert("SD1", "SD"); // sets the preempt flag
  assert.equal(q.shouldPreempt(), true);
  q.peekNext(1);
  assert.equal(q.shouldPreempt(), true, "peekNext() must never clear the preempt flag - only next() may");
});

test("peekNext: calling it repeatedly always returns the same result until a real next()/insert/remove changes the queue", () => {
  const q = new AutoQueue();
  q.insert("A", "P0");
  q.insert("B", "P1");
  const first = q.peekNext(1);
  const second = q.peekNext(1);
  const third = q.peekNext(1);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  assert.equal(q.totalSize(), 2, "the queue must still contain both totes after three peeks");
});

test("peekNext: respects the SAME SD -> P0 -> P1 -> P2 fill order as next()", () => {
  const q = new AutoQueue();
  q.insert("P2-1", "P2");
  q.insert("P1-1", "P1");
  q.insert("SD-1", "SD");
  q.insert("P0-1", "P0");
  const peeked = q.peekNext(4);
  assert.deepEqual(peeked.map((e) => e.priority), ["SD", "P0", "P1", "P2"]);
});
