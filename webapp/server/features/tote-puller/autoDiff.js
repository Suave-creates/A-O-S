// Auto Mode's differential merge - reconciles the AutoQueue's still-queued
// state against a freshly classified tote list. Faithful port of the
// remove/insert/reprioritize block in the existing extension's
// runGrafanaFetchCycle() (background/index.js:498-521).
//
// Scope is deliberately limited to what's still queued (queue.snapshot()).
// An in-flight/already-batched tote has already been removed from the
// queue by AutoQueue.next() and is therefore completely outside this
// function's reach - it cannot be cancelled or re-classified mid-flight by
// a merge, exactly matching the legacy behavior this replicates.
//
// Reappearance note: if a tote is removed here (vanished from the source
// dump) and a LATER merge sees it again, it is treated as a brand-new
// insert with a fresh addedAt - this is Auto's OWN queue-level "first
// seen," and is deliberately different from Classification's firstSeenAt
// (server/features/locked-tote-info/lockedSinceTracker.js), which never resets on reappearance.
// These are two separate pieces of state serving two separate purposes:
// Classification answers "how long has this tote been locked, ever";
// Auto's queue only cares "is this tote currently something I should act
// on" - a gap and a reappearance in Auto's queue is not an audit event.

// diffAndMerge(queue, classifiedTotes) -> { removed, inserted, reprioritized }
// classifiedTotes: the array from classification.js's classifyLockedTotes()
// { totes }, i.e. [{toteId, priority, source, worstPid, scarcityCount, ...}]
function diffAndMerge(queue, classifiedTotes) {
  const snap = queue.snapshot();
  const currentIds = new Set();
  for (const entry of [...snap.sd, ...snap.p0, ...snap.p1, ...snap.p2]) currentIds.add(entry.toteId);

  const newIds = new Set((classifiedTotes || []).map((t) => t.toteId));

  const removed = [];
  for (const id of currentIds) {
    if (!newIds.has(id)) {
      queue.remove(id);
      removed.push(id);
    }
  }

  const inserted = [];
  const reprioritized = [];
  for (const t of classifiedTotes || []) {
    const meta = { worstPid: t.worstPid, scarcityCount: t.scarcityCount };
    if (!queue.has(t.toteId)) {
      const outcome = queue.insert(t.toteId, t.priority, t.source, meta);
      if (outcome === "inserted") inserted.push(t.toteId);
    } else {
      const relocated = queue.updatePriority(t.toteId, t.priority, t.source, meta);
      if (relocated) reprioritized.push(t.toteId);
    }
  }

  return { removed, inserted, reprioritized };
}

module.exports = { diffAndMerge };
