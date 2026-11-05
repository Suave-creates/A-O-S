// Pure state-transition logic for "Locked Since" (Classification's
// two-stage timestamp model). Storage-agnostic - operates on a plain
// Map<toteId, {firstSeenAt, lastSeenAt, discrepancyMarkedAt}> passed in by
// the caller, so the actual first-seen semantics are fully unit-testable
// without a database. server/features/locked-tote-info/classificationTimestamps.js is the thin
// MySQL-backed adapter that loads/persists that same Map shape in
// production - it delegates to these functions rather than re-implementing
// the policy in SQL, so there is exactly one place this logic can drift.
//
// Two-stage model (per the Classification design):
//   Priority 1 - a real discrepancy-history timestamp (discrepancyMarkedAt),
//     not built yet - this phase only ever writes/reads it as null, but the
//     shape exists so a later phase can populate it without any change to
//     this module's callers or the Classification UI.
//   Priority 2 - firstSeenAt: the earliest Classification refresh at which
//     this tote was observed. Used whenever discrepancyMarkedAt is null.
//
// DELIBERATE DECISION - documented, not a default: firstSeenAt is set once,
// on a tote's very first observation, and is NEVER reset afterwards - not
// even if the tote later disappears from Locked Dump for one or more
// refreshes and then genuinely reappears. lastSeenAt advances on every
// observation regardless. This makes "Locked Since" mean "the first time
// Classification ever saw this tote locked," not "since its most recent
// unbroken lock episode" - the latter would require tracking episode
// boundaries (when a gap counts as a real disappearance vs. a missed
// refresh), which this phase does not build. Revisit this policy once
// discrepancyMarkedAt is real: a genuinely new discrepancy is an explicit,
// unambiguous "new episode" signal that firstSeenAt reappearance-tracking
// would only be approximating.

function lockedSinceOf(entry) {
  if (!entry) return null;
  return entry.discrepancyMarkedAt || entry.firstSeenAt;
}

// Mutates `store` in place (matches the Map-of-mutable-records shape the
// MySQL adapter also uses), returns this tote's resulting Locked Since value.
function touchTote(store, toteId, seenAtIso) {
  const existing = store.get(toteId);
  if (!existing) {
    store.set(toteId, { firstSeenAt: seenAtIso, lastSeenAt: seenAtIso, discrepancyMarkedAt: null });
  } else {
    existing.lastSeenAt = seenAtIso;
    // firstSeenAt intentionally left untouched - see module comment above.
  }
  return lockedSinceOf(store.get(toteId));
}

// touchMany(store, toteIds, seenAtIso) -> Map<toteId, lockedSinceIso>
// Totes NOT present in `toteIds` this round are left entirely alone in
// `store` - a disappearance is never itself recorded as an event here (no
// "lastDisappearedAt"); only presence is recorded, on observation.
function touchMany(store, toteIds, seenAtIso) {
  const result = new Map();
  for (const toteId of toteIds) {
    result.set(toteId, touchTote(store, toteId, seenAtIso));
  }
  return result;
}

// ── Lock episodes (operator rules, 2026-11-04) ─────────────────────────────
// A lock lasts while the tote stays in the locked list. observe() keeps one record per tote and restarts it when:
//   - the tote was CLEARED: it was missing from the previous refresh (lastSeenAt older than that refresh), so this
//     sighting is a new lock - e.g. reported 2:53 PM, cleared, locked again tomorrow 5:56 -> locked since 5:56;
//   - or it was refilled: more than half of its SKUs differ from the SKUs it held when last seen locked (a backup
//     for a clear the refreshes missed). Unknown SKUs (old rows, no Quadron data) never restart it.
// Locked Since of a lock = the SHORT report that caused it (the latest report after the previous lock ended, up to
// REPORT_LEAD before the tote appeared, and not after it appeared - a report made while already locked does not
// move it); without such a report (a ghost / unreported lock), the moment it first appeared in the locked list.
const REPORT_LEAD_MS = 3 * 24 * 3600000;

function mostlyDifferent(oldSkus, newSkus) {
  const a = new Set(oldSkus || []);
  const b = new Set(newSkus || []);
  if (!a.size || !b.size) return false;
  let common = 0;
  for (const x of b) if (a.has(x)) common++;
  const union = a.size + b.size - common;
  return 1 - common / union > 0.5;
}

// observation: { toteId, skus?: string[]|null, reports?: iso[] }; previousRefreshAt: iso of the refresh before this
// one (null when unknown). Mutates `store`, returns the Locked Since.
function observeTote(store, { toteId, skus = null, reports = [] }, seenAtIso, previousRefreshAt = null) {
  const cleanSkus = Array.isArray(skus) && skus.length ? [...new Set(skus.map(String))].sort() : null;
  let e = store.get(toteId);
  let after = -Infinity; // reports must come after the previous lock ended
  if (!e) {
    e = { firstSeenAt: seenAtIso, lastSeenAt: seenAtIso, discrepancyMarkedAt: null, skus: cleanSkus };
    store.set(toteId, e);
  } else {
    const cleared = previousRefreshAt != null && e.lastSeenAt < previousRefreshAt;
    const refilled = cleanSkus && e.skus && mostlyDifferent(e.skus, cleanSkus);
    if (cleared || refilled) {
      after = Date.parse(e.lastSeenAt);
      e.firstSeenAt = seenAtIso;
      e.discrepancyMarkedAt = null;
    }
    e.lastSeenAt = seenAtIso;
    if (cleanSkus) e.skus = cleanSkus;
  }
  if (!e.discrepancyMarkedAt) {
    const start = Date.parse(e.firstSeenAt);
    const own = (reports || []).filter((r) => { const ms = Date.parse(r); return ms > after && ms >= start - REPORT_LEAD_MS && ms <= start; }).sort();
    if (own.length) e.discrepancyMarkedAt = own[own.length - 1]; // the report that locked it (latest before it appeared)
  }
  return lockedSinceOf(e);
}

function observeMany(store, observations, seenAtIso, previousRefreshAt = null) {
  const result = new Map();
  for (const o of observations) result.set(o.toteId, observeTote(store, o, seenAtIso, previousRefreshAt));
  return result;
}

module.exports = { touchTote, touchMany, lockedSinceOf, observeTote, observeMany, mostlyDifferent };
