// Local-First Phase 1 - the local sync outbox. One entry per locally
// completed operation that must eventually reach company MySQL. Populated
// by two producers, each for its own reason (see their own comments):
//   - server/platform/queries/queryManagerMemory.js  (entity_type "query")
//   - server/platform/audit/auditLog.js            (entity_type "audit_log")
//
// Read and transitioned ONLY by server/scripts/syncToCompany.js, which is
// the sole consumer that ever moves an entry PENDING -> SYNCED. Nothing in
// this file talks to MySQL, Quadron, Grafana, Concinity, NexS, or any
// capability/runtime code - it is pure local file I/O over localStore.js.
//
// operation_id is a fresh crypto.randomUUID() per entry - NOT derived from
// any in-memory counter (query_id, audit row id, etc.), so it stays
// globally unique across backend restarts and is safe to use as the
// idempotency key server/platform/db/migrations/0004_local_sync_ledger.sql enforces.

const crypto = require("node:crypto");
const localStore = require("../storage/localStore");

const COLLECTION = "outbox";

function loadAll() {
  return localStore.readCollection(COLLECTION, []);
}

function saveAll(entries) {
  localStore.writeCollection(COLLECTION, entries);
}

// append({ entityType, payload }) -> the created entry.
function append({ entityType, payload }) {
  const entries = loadAll();
  const entry = {
    operation_id: crypto.randomUUID(),
    entity_type: entityType,
    created_at: new Date().toISOString(),
    payload,
    sync_status: "PENDING",
    synced_at: null,
    retry_count: 0,
    last_sync_error: null,
  };
  entries.push(entry);
  saveAll(entries);
  return { ...entry };
}

// list({ status }) -> entries, optionally filtered by sync_status.
function list({ status } = {}) {
  const entries = loadAll();
  return status ? entries.filter((e) => e.sync_status === status) : entries.slice();
}

function get(operationId) {
  return loadAll().find((e) => e.operation_id === operationId) || null;
}

function markSynced(operationId) {
  const entries = loadAll();
  const entry = entries.find((e) => e.operation_id === operationId);
  if (!entry) return null;
  entry.sync_status = "SYNCED";
  entry.synced_at = new Date().toISOString();
  entry.last_sync_error = null;
  saveAll(entries);
  return { ...entry };
}

// A failed sync attempt NEVER changes sync_status away from PENDING - the
// operation is retained, retry_count is incremented, and the error is
// recorded, so nothing is ever silently lost.
function markFailed(operationId, errorMessage) {
  const entries = loadAll();
  const entry = entries.find((e) => e.operation_id === operationId);
  if (!entry) return null;
  entry.retry_count += 1;
  entry.last_sync_error = String((errorMessage && errorMessage.message) || errorMessage || "Unknown sync error");
  saveAll(entries);
  return { ...entry };
}

module.exports = { append, list, get, markSynced, markFailed };
