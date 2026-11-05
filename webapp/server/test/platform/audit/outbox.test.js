// Tests for server/platform/audit/outbox.js - the Local-First Phase 1 sync outbox.
// Pure file I/O over localStore.js, no MySQL, no Quadron/Grafana/
// Concinity/NexS call anywhere in this file.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.ASO_LOCAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aso-outbox-test-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const outbox = require("../../../platform/audit/outbox");

test.after(() => {
  fs.rmSync(process.env.ASO_LOCAL_STORE_DIR, { recursive: true, force: true });
});

test("append() produces an entry with exactly the required field set, PENDING by default", () => {
  const entry = outbox.append({ entityType: "query", payload: { foo: "bar" } });
  assert.deepEqual(
    Object.keys(entry).sort(),
    ["created_at", "entity_type", "last_sync_error", "operation_id", "payload", "retry_count", "sync_status", "synced_at"].sort()
  );
  assert.equal(entry.entity_type, "query");
  assert.deepEqual(entry.payload, { foo: "bar" });
  assert.equal(entry.sync_status, "PENDING");
  assert.equal(entry.synced_at, null);
  assert.equal(entry.retry_count, 0);
  assert.equal(entry.last_sync_error, null);
  assert.match(entry.operation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "operation_id must be a UUID");
});

test("each append() gets a distinct, globally-unique operation_id", () => {
  const a = outbox.append({ entityType: "query", payload: {} });
  const b = outbox.append({ entityType: "query", payload: {} });
  assert.notEqual(a.operation_id, b.operation_id);
});

test("list() with no filter returns every entry, list({status}) filters", () => {
  const before = outbox.list().length;
  const pending = outbox.append({ entityType: "audit_log", payload: {} });
  outbox.markSynced(pending.operation_id);
  const pending2 = outbox.append({ entityType: "audit_log", payload: {} });

  assert.equal(outbox.list().length, before + 2);
  const pendingOnly = outbox.list({ status: "PENDING" });
  assert.ok(pendingOnly.some((e) => e.operation_id === pending2.operation_id));
  assert.ok(!pendingOnly.some((e) => e.operation_id === pending.operation_id));
  const syncedOnly = outbox.list({ status: "SYNCED" });
  assert.ok(syncedOnly.some((e) => e.operation_id === pending.operation_id));
});

test("get() returns the exact entry by operation_id, or null", () => {
  const entry = outbox.append({ entityType: "query", payload: { x: 1 } });
  assert.deepEqual(outbox.get(entry.operation_id), entry);
  assert.equal(outbox.get("00000000-0000-0000-0000-000000000000"), null);
});

test("markSynced() sets sync_status=SYNCED, synced_at, clears last_sync_error - and persists", () => {
  const entry = outbox.append({ entityType: "query", payload: {} });
  outbox.markFailed(entry.operation_id, "transient error");
  const synced = outbox.markSynced(entry.operation_id);
  assert.equal(synced.sync_status, "SYNCED");
  assert.ok(synced.synced_at);
  assert.equal(synced.last_sync_error, null);

  const reread = outbox.get(entry.operation_id);
  assert.equal(reread.sync_status, "SYNCED");
});

test("markFailed() increments retry_count, records last_sync_error, and NEVER changes sync_status away from PENDING", () => {
  const entry = outbox.append({ entityType: "audit_log", payload: {} });
  const once = outbox.markFailed(entry.operation_id, new Error("first failure"));
  assert.equal(once.retry_count, 1);
  assert.equal(once.last_sync_error, "first failure");
  assert.equal(once.sync_status, "PENDING", "a failed sync must retain the entry as PENDING - never lost");

  const twice = outbox.markFailed(entry.operation_id, "second failure");
  assert.equal(twice.retry_count, 2);
  assert.equal(twice.last_sync_error, "second failure");
  assert.equal(twice.sync_status, "PENDING");
});

test("markSynced()/markFailed() on an unknown operation_id return null without throwing", () => {
  assert.equal(outbox.markSynced("00000000-0000-0000-0000-000000000000"), null);
  assert.equal(outbox.markFailed("00000000-0000-0000-0000-000000000000", "x"), null);
});
