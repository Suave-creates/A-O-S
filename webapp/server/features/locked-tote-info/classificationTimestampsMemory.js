// DEVELOPMENT-ONLY, local-store-backed implementation of "Locked Since"
// persistence. Selected only when config.localStoreMode === "local" (see
// server/features/locked-tote-info/classificationTimestamps.js, the selector). Delegates the
// actual touch/merge policy to lockedSinceTracker.js - the SAME pure
// functions classificationTimestampsMysql.js's SQL emulates - so there is
// exactly one place the "never reset first_seen_at" policy lives.
//
// Persisted row shape mirrors the classification_tote_state MySQL table
// exactly (tote_id, first_seen_at, last_seen_at, discrepancy_marked_at) so
// server/scripts/syncToCompany.js can apply the same
// first_seen_at=MIN / last_seen_at=MAX merge rule against company MySQL
// without any shape translation, and so this file's persisted data can
// round-trip through a future company sync unmodified in shape.
//
// Not registered in queryManagerMemory.js's/auditLog.js's outbox at all -
// per the Phase 1 report, Locked Since state syncs via its own explicit
// merge in server/scripts/syncToCompany.js, not via a generic outbox
// entry (a MIN/MAX merge is not an idempotent single INSERT the way a
// completed session record is).

const localStore = require("../../platform/storage/localStore");
const lockedSinceTracker = require("./lockedSinceTracker");

const COLLECTION = "classification_tote_state";

function loadStore() {
  const rows = localStore.readCollection(COLLECTION, []);
  const map = new Map();
  for (const row of rows) {
    map.set(row.tote_id, {
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      discrepancyMarkedAt: row.discrepancy_marked_at,
      skus: row.sku_sig || null,
    });
  }
  return map;
}

function saveStore(map) {
  const rows = [...map.entries()].map(([tote_id, v]) => ({
    tote_id,
    first_seen_at: v.firstSeenAt,
    last_seen_at: v.lastSeenAt,
    discrepancy_marked_at: v.discrepancyMarkedAt,
    sku_sig: v.skus || null,
  }));
  localStore.writeCollection(COLLECTION, rows);
}

async function touchMany(toteIds, seenAtIso) {
  if (!toteIds.length) return new Map();
  const store = loadStore();
  const result = lockedSinceTracker.touchMany(store, toteIds, seenAtIso);
  saveStore(store);
  return result;
}

// getMany(toteIds) -> Promise<Map<toteId, lockedSinceIso>> - pure, read-only
// lookup (never calls saveStore/writeCollection). Mirrors
// classificationTimestampsMysql.js's own getMany() exactly - see that
// file's comment for why this exists (Auto Preview/Dry-Run).
async function getMany(toteIds) {
  if (!toteIds.length) return new Map();
  const store = loadStore();
  const result = new Map();
  for (const id of toteIds) {
    if (store.has(id)) result.set(id, lockedSinceTracker.lockedSinceOf(store.get(id)));
  }
  return result;
}

// observeMany - the lock-episode rules (lockedSinceTracker.observeTote), same as the MySQL adapter
async function observeMany(observations, seenAtIso, previousRefreshAt = null) {
  const store = loadStore();
  const result = lockedSinceTracker.observeMany(store, observations, seenAtIso, previousRefreshAt);
  saveStore(store);
  return result;
}

module.exports = { touchMany, getMany, observeMany };
