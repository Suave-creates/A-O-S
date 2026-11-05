// Auto Mode's priority queue - SD/P0/P1/P2. Faithful port of the existing
// extension's _pq (background/index.js:110-157: pqInsert/pqRemove/
// pqUpdatePriority/pqNext/pqShouldPreempt). Pure, dependency-free.
//
// This is Auto's OWN queue/selection state - structurally separate from
// Classification's snapshot (server/features/locked-tote-info/classification.js,
// classificationEngine.js) and from classification_tote_state (Locked
// Since persistence). A tote being classified P0 by Classification does
// NOT mean it is in this queue; nothing in this file reads or writes
// Classification's state, and nothing in Classification reads this queue.

const PRIORITY_LEVELS = ["SD", "P0", "P1", "P2"];
const MAX_QUEUE_SIZE = 2000; // mirrors the existing extension's LIMITS.MAX_QUEUE_SIZE
const STARVATION_THRESHOLD = 10; // mirrors LIMITS.STARVATION_THRESHOLD

function makeEntryId(toteId) {
  return `${toteId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

class AutoQueue {
  constructor() {
    this._buckets = { SD: new Map(), P0: new Map(), P1: new Map(), P2: new Map() };
    this._starvation = 0;
    this._preempt = false;
  }

  has(toteId) {
    return PRIORITY_LEVELS.some((lvl) => this._buckets[lvl].has(toteId));
  }

  totalSize() {
    return PRIORITY_LEVELS.reduce((s, lvl) => s + this._buckets[lvl].size, 0);
  }

  isEmpty() {
    return this.totalSize() === 0;
  }

  // Mirrors pqShouldPreempt() exactly: true only while the flag is set AND
  // there's actually SD or P0 work waiting to preempt with. Cleared by
  // next() (batch construction consumes the flag), never by this getter.
  shouldPreempt() {
    return this._preempt && (this._buckets.SD.size > 0 || this._buckets.P0.size > 0);
  }

  // insert(toteId, priority, source, meta) -> "inserted" | "duplicate" | "invalid" | "full"
  // Rejects a tote already present in ANY bucket - duplicates across
  // buckets are structurally impossible, matching pqInsert's has() check.
  insert(toteId, priority, source, meta = {}) {
    if (!toteId || typeof toteId !== "string") return "invalid";
    if (this.has(toteId)) return "duplicate";
    if (this.totalSize() >= MAX_QUEUE_SIZE) return "full";
    const level = this._buckets[priority] ? priority : "P2";
    this._buckets[level].set(toteId, {
      toteId,
      priority: level,
      source: source || null,
      addedAt: meta.addedAt || new Date().toISOString(),
      worstPid: meta.worstPid ?? null,
      scarcityCount: meta.scarcityCount ?? null,
      entryId: meta.entryId || makeEntryId(toteId),
    });
    if (level === "P0" || level === "SD") this._preempt = true;
    return "inserted";
  }

  remove(toteId) {
    for (const lvl of PRIORITY_LEVELS) {
      if (this._buckets[lvl].has(toteId)) {
        this._buckets[lvl].delete(toteId);
        return true;
      }
    }
    return false;
  }

  // updatePriority(toteId, newPriority, source, meta) -> true if the tote
  // actually moved buckets, false if it stayed put or wasn't found. Always
  // refreshes source/worstPid/scarcityCount metadata when found, even if
  // the bucket didn't change - mirrors pqUpdatePriority exactly.
  updatePriority(toteId, newPriority, source, meta = {}) {
    let currentLevel = null;
    let entry = null;
    for (const lvl of PRIORITY_LEVELS) {
      if (this._buckets[lvl].has(toteId)) {
        currentLevel = lvl;
        entry = this._buckets[lvl].get(toteId);
        break;
      }
    }
    if (!entry) return false;

    if (source) entry.source = source;
    if (meta.worstPid !== undefined) entry.worstPid = meta.worstPid;
    if (meta.scarcityCount !== undefined) entry.scarcityCount = meta.scarcityCount;

    const target = this._buckets[newPriority] ? newPriority : "P2";
    if (currentLevel === target) return false;

    this._buckets[currentLevel].delete(toteId);
    entry.priority = target;
    this._buckets[target].set(toteId, entry);
    if (target === "P0" || target === "SD") this._preempt = true;
    return true;
  }

  // Pure selection - determines which entries a batch draw would contain
  // RIGHT NOW, without deleting anything from any bucket and without
  // touching _starvation/_preempt. The one and only place the SD/P0/P1/P2 +
  // starvation-guard selection algorithm is decided - both next() and
  // peekNext() below call this, so there is exactly one implementation,
  // never two that could drift apart.
  //
  // Starvation guard: if the counter has reached STARVATION_THRESHOLD and
  // P2 has anything queued, a P2 tote is selected FIRST (via ordinary Map
  // iteration order - never deleted here) before the normal priority fill
  // runs; `selectedIds` prevents the fill loop from picking that same tote
  // again when it reaches P2.
  _selectBatch(batchSize) {
    const batch = [];
    const selectedIds = new Set();
    if (this._starvation >= STARVATION_THRESHOLD && this._buckets.P2.size > 0) {
      const first = this._buckets.P2.values().next().value;
      if (first) {
        batch.push(first);
        selectedIds.add(first.toteId);
      }
    }
    for (const lvl of PRIORITY_LEVELS) {
      if (batch.length >= batchSize) break;
      for (const [id, entry] of this._buckets[lvl]) {
        if (batch.length >= batchSize) break;
        if (selectedIds.has(id)) continue;
        batch.push(entry);
        selectedIds.add(id);
      }
    }
    return batch;
  }

  // next(batchSize) -> array of entries, REMOVED from the queue. This is
  // what makes "queued" and "in the current batch" mutually exclusive: an
  // entry returned here no longer exists in any bucket, so a later
  // differential merge (autoDiff.js) cannot see or touch it even if it
  // vanishes from the source dump mid-batch.
  //
  // The counter increments on any batch that ends up with zero P2 totes
  // (starved or not), and resets to 0 whenever a P2 tote is included by
  // either path - mirrors pqNext exactly.
  next(batchSize = 1) {
    const batch = this._selectBatch(batchSize);
    for (const entry of batch) this._buckets[entry.priority].delete(entry.toteId);
    const hasP2 = batch.some((e) => e.priority === "P2");
    if (!hasP2 && batch.length > 0) this._starvation++;
    else if (hasP2) this._starvation = 0;
    this._preempt = false;
    return batch;
  }

  // peekNext(batchSize) -> the SAME batch next() would return right now,
  // WITHOUT removing anything from the queue and WITHOUT touching the
  // starvation counter or the preempt flag. For Auto Preview/Dry-Run only
  // (see server/features/tote-puller/autoPreview.js) - calling this can never change what a
  // subsequent real next() call would return, and never affects a real
  // AutoEngine session's queue (Preview operates on its own separate
  // AutoQueue instance entirely).
  peekNext(batchSize = 1) {
    return this._selectBatch(batchSize);
  }

  // requeue(entries) - reinsert the unused remainder of a preempted batch,
  // preserving each entry's original priority/source/metadata exactly
  // (mirrors callNextInBatch()'s own preemption handling: "for(const e of
  // A.currentBatch.slice(A.batchIdx)) pqInsert(e.toteId, e.priority, ...)").
  // Safe to call with entries that were just removed by next() - they are
  // guaranteed not to collide with anything still queued.
  requeue(entries) {
    for (const entry of entries) {
      this.insert(entry.toteId, entry.priority, entry.source, {
        worstPid: entry.worstPid,
        scarcityCount: entry.scarcityCount,
        addedAt: entry.addedAt,
        entryId: entry.entryId,
      });
    }
  }

  snapshot() {
    return {
      sd: [...this._buckets.SD.values()],
      p0: [...this._buckets.P0.values()],
      p1: [...this._buckets.P1.values()],
      p2: [...this._buckets.P2.values()],
      total: this.totalSize(),
      sdCount: this._buckets.SD.size,
      p0Count: this._buckets.P0.size,
      p1Count: this._buckets.P1.size,
      p2Count: this._buckets.P2.size,
      starvationCounter: this._starvation,
      preemptFlag: this._preempt,
    };
  }
}

module.exports = { AutoQueue, PRIORITY_LEVELS, MAX_QUEUE_SIZE, STARVATION_THRESHOLD };
