// Local-First Phase 1 - tiny record of when server/scripts/syncToCompany.js
// last ran, for the LOCAL DEV UI indicator (see auth.routes.js's /me and
// public/js/app.js). Deliberately separate from outbox.js: this is "when
// did a sync attempt last happen," not operation data, and has no bearing
// on idempotency or what gets synced.

const localStore = require("../storage/localStore");

const COLLECTION = "sync_meta";

function get() {
  return localStore.readCollection(COLLECTION, { lastSyncAt: null, lastSyncSummary: null });
}

function set(meta) {
  localStore.writeCollection(COLLECTION, meta);
}

module.exports = { get, set };
