// Local-First Phase 1 tests for server/platform/queries/queryManagerMemory.js's disk
// persistence and outbox representation (added on top of the pre-existing,
// unmodified in-memory-lifecycle contract already covered exhaustively by
// server/test/queryManagerMemory.test.js). No real MySQL, no real
// Quadron/Grafana/Concinity call anywhere in this file.
//
// ASO_LOCAL_STORE_DIR isolates this suite to its own throwaway temp
// directory - never the real webapp/.local-dev-data/.

process.env.ASO_LOCAL_DEV = "true";
process.env.NODE_ENV = "development";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.ASO_LOCAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aso-qmm-persist-test-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const localStore = require("../../../platform/storage/localStore");
const outbox = require("../../../platform/audit/outbox");

test.after(() => {
  fs.rmSync(process.env.ASO_LOCAL_STORE_DIR, { recursive: true, force: true });
});

const ADMIN = { id: -1, role: "ADMIN" };

// Simulates a backend restart: clears this module's cached instance (and
// its state - the module-level `rows`/`registry`/`nextId`) and re-requires
// it fresh, exactly as a real process restart would re-run the file from
// scratch. localStore.js/outbox.js are stateless (pure file I/O per call),
// so they do not need re-requiring.
function requireFreshQueryManagerMemory() {
  delete require.cache[require.resolve("../../../platform/queries/queryManagerMemory")];
  return require("../../../platform/queries/queryManagerMemory");
}

test("createQuery persists the row to the local store immediately", async () => {
  const qmm = requireFreshQueryManagerMemory();
  const row = await qmm.createQuery({ userId: -1, operation: "TEST_PERSIST", parameters: { toteId: "TL1" } });

  const onDisk = localStore.readCollection("queries", []);
  const persisted = onDisk.find((r) => r.query_id === row.query_id);
  assert.ok(persisted, "row must be present in queries.json immediately after createQuery");
  assert.equal(persisted.operation, "TEST_PERSIST");
  assert.equal(persisted.status, "QUEUED");
});

test("a completed operation survives a simulated backend restart", async () => {
  const qmm1 = requireFreshQueryManagerMemory();
  const created = await qmm1.createQuery({ userId: -1, operation: "TEST_RESTART", parameters: {} });
  await qmm1.completeQuery(created.query_id);

  // Simulate restart.
  const qmm2 = requireFreshQueryManagerMemory();
  const reloaded = await qmm2.getQuery(created.query_id);
  assert.ok(reloaded, "the completed query must still exist after a simulated restart");
  assert.equal(reloaded.status, "COMPLETED");
});

test("nextId does not collide across a simulated restart", async () => {
  const qmm1 = requireFreshQueryManagerMemory();
  const first = await qmm1.createQuery({ userId: -1, operation: "TEST_NEXTID", parameters: {} });

  const qmm2 = requireFreshQueryManagerMemory();
  const second = await qmm2.createQuery({ userId: -1, operation: "TEST_NEXTID", parameters: {} });

  assert.notEqual(first.query_id, second.query_id, "query_id must never repeat across a restart");
  const firstNum = parseInt(first.query_id.slice(2), 10);
  const secondNum = parseInt(second.query_id.slice(2), 10);
  assert.ok(secondNum > firstNum, "ids must keep increasing after a restart, never reset to Q-000001");
});

test("a QUEUED row reconciled to FAILED after restart (no live registry entry) is still outboxed", async () => {
  const qmm1 = requireFreshQueryManagerMemory();
  const created = await qmm1.createQuery({ userId: -1, operation: "TEST_RECONCILE", parameters: {} });
  // Never completed, never registered - simulates a process killed mid-job.

  const qmm2 = requireFreshQueryManagerMemory();
  const reconciled = await qmm2.getQuery(created.query_id); // triggers reconcileStale -> FAILED
  assert.equal(reconciled.status, "FAILED");

  const entries = outbox.list();
  const match = entries.find((e) => e.entity_type === "query" && e.payload.query_id === created.query_id);
  assert.ok(match, "the reconciled-to-FAILED row must have produced an outbox entry");
  assert.equal(match.payload.status, "FAILED");
  assert.equal(match.sync_status, "PENDING");
});

for (const [name, run] of [
  ["completeQuery", async (qmm, id) => qmm.completeQuery(id)],
  ["failQuery", async (qmm, id) => qmm.failQuery(id, "boom")],
  ["timeoutQuery", async (qmm, id) => qmm.timeoutQuery(id)],
]) {
  test(`${name} appends exactly one outbox entry with entity_type "query"`, async () => {
    const qmm = requireFreshQueryManagerMemory();
    const created = await qmm.createQuery({ userId: -1, operation: `TEST_OUTBOX_${name}`, parameters: {} });
    const before = outbox.list().length;
    await run(qmm, created.query_id);
    const after = outbox.list();
    assert.equal(after.length, before + 1);
    const entry = after[after.length - 1];
    assert.equal(entry.entity_type, "query");
    assert.equal(entry.payload.query_id, created.query_id);
    assert.equal(entry.sync_status, "PENDING");
    assert.equal(entry.retry_count, 0);
    assert.equal(entry.synced_at, null);
    assert.match(entry.operation_id, /^[0-9a-f-]{36}$/, "operation_id must be a UUID");
  });
}

test("finalizeCancelled (via cancelQuery with no registered job) also appends an outbox entry", async () => {
  const qmm = requireFreshQueryManagerMemory();
  const created = await qmm.createQuery({ userId: -1, operation: "TEST_CANCEL_OUTBOX", parameters: {} });
  const before = outbox.list().length;
  const result = await qmm.cancelQuery(created.query_id, ADMIN);
  assert.equal(result.ok, true);
  assert.equal(result.query.status, "CANCELLED");
  const after = outbox.list();
  assert.equal(after.length, before + 1);
  assert.equal(after[after.length - 1].payload.status, "CANCELLED");
});

test("createQuery (non-terminal) does NOT append an outbox entry", async () => {
  const qmm = requireFreshQueryManagerMemory();
  const before = outbox.list().length;
  await qmm.createQuery({ userId: -1, operation: "TEST_NO_OUTBOX_ON_CREATE", parameters: {} });
  assert.equal(outbox.list().length, before, "QUEUED is not a terminal status and must not be synced yet");
});
