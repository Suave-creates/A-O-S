// Unit tests for server/features/tote-puller/autoPreview.js - Auto Preview/Dry-Run. No real
// MySQL, no real runtime, no real Quadron/Grafana/Concinity call anywhere in
// this file - requestCapability/wait/getResult are fully injected fakes,
// same pattern as autoEngine.test.js. classify/diff/queue selection use the
// REAL classification.js/autoDiff.js/autoQueue.js (already exhaustively
// tested elsewhere) so these tests exercise real preview orchestration, not
// a second copy of that logic.
//
// A calling station is REQUIRED for every preview (matching real Auto's own
// /start requirement, via the SAME validateZoneConfig()) - ZONE below is
// the valid single-zone config most tests use as a baseline so each test
// can focus on the thing it's actually testing.
//
// ASO_LOCAL_DEV/NODE_ENV=development + ASO_LOCAL_STORE_DIR isolate this
// file to a throwaway local store, so classificationTimestamps.getMany()
// (Locked Since, read-only) resolves to the local memory adapter instead of
// attempting a real MySQL connection - lets a few tests pre-seed and assert
// real Locked Since values without any database.

process.env.ASO_LOCAL_DEV = "true";
process.env.NODE_ENV = "development";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.ASO_LOCAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aso-autopreview-test-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const { runPreview } = require("../../../features/tote-puller/autoPreview");
const { AutoQueue } = require("../../../features/tote-puller/autoQueue");
const localStore = require("../../../platform/storage/localStore");

test.after(() => {
  fs.rmSync(process.env.ASO_LOCAL_STORE_DIR, { recursive: true, force: true });
});

const USER = { id: 1, role: "USER", employeeId: "EMP001" };
const ZONE = { zone: "5", instanceCode: "LK-069" };

function locked(toteId, overrides = {}) {
  return { toteId, zone: "aisle_01_zone_08", location: "004-08-1-029-1-01", tracker: "T1", shuttle: "S1", ...overrides };
}
function invEntry(toteId, partitions) {
  return { toteId, quadronQty: partitions.reduce((s, p) => s + p.qty, 0), partitions };
}

// Controllable capability trio - mirrors autoEngine.test.js's own helper.
function makeControllableCapabilities(initial) {
  let sources = { GET_GRAFANA_LOCKED_TOTES: [], GET_GRAFANA_SUPERVISOR_DUMP: [], GET_QUADRON_INVENTORY: [], ...initial };
  const results = new Map();
  let counter = 0;
  const requestCapability = async ({ capabilityName }) => {
    const outcome = sources[capabilityName];
    if (outcome instanceof Error) return { ok: false, code: 502, reason: outcome.message };
    counter++;
    const queryId = `Q-FAKE-${counter}`;
    results.set(queryId, outcome || []);
    return { ok: true, query: { query_id: queryId, status: "RUNNING" } };
  };
  const wait = async (queryId) => ({ query_id: queryId, status: "COMPLETED" });
  const getResult = (queryId) => ({ rows: results.get(queryId) || [] });
  return { requestCapability, wait, getResult, setSources: (next) => { sources = { ...sources, ...next }; } };
}

// ── Calling station is REQUIRED, same model as real Auto ────────────────

test("preview REQUIRES a calling station - no zone/multiZone at all fails exactly like /start would, before any capability fetch", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("A")] });
  const result = await runPreview({ user: USER, ...caps, queue: new AutoQueue() });
  assert.equal(result.ok, false);
  assert.equal(result.code, 400);
  assert.match(result.reason, /zone is required/);
});

test("preview REQUIRES a calling station - an invalid multi-zone config (percentages != 100) fails with the SAME validateZoneConfig() reason /start would give, never guesses a station", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("A")] });
  const result = await runPreview({
    user: USER,
    ...caps,
    multiZone: true,
    zones: [{ id: "z1", zone: "1", instanceCode: "LK-069", percentage: 50 }],
    queue: new AutoQueue(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 400);
  assert.match(result.reason, /100/);
});

test("calling station reflects real pickNextZone() for a single-zone config, verbatim", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("A")] });
  const result = await runPreview({ user: USER, ...caps, zone: "12", instanceCode: "LK-069", queue: new AutoQueue() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.preview.callingStation, { zone: "12", instanceCode: "LK-069" });
});

test("calling station reflects real pickNextZone() weighted selection for a multi-zone config", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("A")] });
  const zones = [
    { id: "z1", zone: "1", instanceCode: "LK-069", percentage: 70 },
    { id: "z2", zone: "2", instanceCode: "LK-069", percentage: 30 },
  ];
  const result = await runPreview({ user: USER, ...caps, multiZone: true, zones, queue: new AutoQueue() });
  assert.equal(result.ok, true);
  // Fresh credits: both start at 0, both get +percentage, 70 > 30 -> zone "1" wins on the very first pick.
  assert.deepEqual(result.preview.callingStation, { zone: "1", instanceCode: "LK-069" });
});

// ── Core orchestration ────────────────────────────────────────────────────

test("basic preview: composes classify + diff + queue correctly for a simple SD/P2 scenario", async () => {
  const caps = makeControllableCapabilities({
    GET_GRAFANA_LOCKED_TOTES: [locked("TL0000000001"), locked("TL0000000002")],
    GET_GRAFANA_SUPERVISOR_DUMP: [{ toteId: "TL0000000001" }],
    GET_QUADRON_INVENTORY: [invEntry("TL0000000001", [{ part: 1, qty: 5, sku: "SKU-A" }])],
  });

  const result = await runPreview({ user: USER, ...ZONE, ...caps, queue: new AutoQueue() });

  assert.equal(result.ok, true);
  const p = result.preview;
  assert.equal(p.totalLockedTotes, 2);
  assert.equal(p.sdCount, 1);
  assert.equal(p.p2Count, 1); // TL0000000002 has no SKUs at all -> P2 default
  assert.equal(p.totalQueueCount, 2);
  assert.ok(p.generatedAt);
  assert.equal(typeof p.previewId, "number");
  assert.deepEqual(p.callingStation, { zone: "5", instanceCode: "LK-069" });
});

test("Locked Dump failure short-circuits the whole preview and never touches the queue", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: new Error("runtime offline") });
  const queue = new AutoQueue();
  const result = await runPreview({ user: USER, ...ZONE, ...caps, queue });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Locked Tote Dump unavailable/);
  assert.equal(queue.totalSize(), 0);
});

test("degraded mode: Supervisor Dump / Quadron Inventory failures still produce a preview, matching Auto's own graceful degradation", async () => {
  const caps = makeControllableCapabilities({
    GET_GRAFANA_LOCKED_TOTES: [locked("TL0000000003")],
    GET_GRAFANA_SUPERVISOR_DUMP: new Error("supervisor down"),
    GET_QUADRON_INVENTORY: new Error("inventory down"),
  });
  const result = await runPreview({ user: USER, ...ZONE, ...caps, queue: new AutoQueue() });
  assert.equal(result.ok, true);
  assert.equal(result.preview.sdCount, 0);
  assert.equal(result.preview.degraded.supervisor, true);
  assert.equal(result.preview.degraded.inventory, true);
  assert.match(result.preview.degradedReasons.supervisor, /supervisor down/);
});

test("queue rows carry priority/location/totalToteInv/reason/source, sourced from classifyLockedTotes' own output", async () => {
  const caps = makeControllableCapabilities({
    GET_GRAFANA_LOCKED_TOTES: [locked("TL0000000004", { location: "007-06-1-217-1-02" })],
    GET_QUADRON_INVENTORY: [invEntry("TL0000000004", [{ part: 1, qty: 9, sku: "SKU-Z" }])],
  });
  const result = await runPreview({ user: USER, ...ZONE, ...caps, queue: new AutoQueue() });
  const row = result.preview.queue.find((r) => r.toteId === "TL0000000004");
  assert.ok(row);
  assert.equal(row.location, "007-06-1-217-1-02");
  assert.equal(row.totalToteInv, 9);
  assert.ok(row.reason);
  assert.equal(row.source, "Quadron API");
});

test("peekNext never drains the preview queue - totalQueueCount is unchanged after computing firstBatch", async () => {
  const caps = makeControllableCapabilities({
    GET_GRAFANA_LOCKED_TOTES: [locked("A"), locked("B"), locked("C")],
  });
  const queue = new AutoQueue();
  const result = await runPreview({ user: USER, ...ZONE, ...caps, batchSize: 2, queue });
  assert.equal(result.preview.firstBatch.length, 2);
  assert.equal(result.preview.totalQueueCount, 3, "the queue must still contain all 3 totes after computing the first batch");
  assert.equal(queue.totalSize(), 3, "the underlying AutoQueue itself must be untouched");
});

test("calling a second preview with the SAME queue instance and unchanged data does not shrink the queue", async () => {
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("X"), locked("Y")] });
  const queue = new AutoQueue();
  const first = await runPreview({ user: USER, ...ZONE, ...caps, queue });
  const second = await runPreview({ user: USER, ...ZONE, ...caps, queue });
  assert.equal(first.preview.totalQueueCount, 2);
  assert.equal(second.preview.totalQueueCount, 2);
});

test("differential across two previews: NEW on first call, then REMOVED/reprioritized/still-there tracked correctly on the second", async () => {
  const caps = makeControllableCapabilities({
    GET_GRAFANA_LOCKED_TOTES: [locked("TL0000000010"), locked("TL0000000011")],
    GET_QUADRON_INVENTORY: [
      invEntry("TL0000000010", [{ part: 1, qty: 1, sku: "SKU-RARE" }]), // 1 tote holding this SKU -> P0 (<=1)
      invEntry("TL0000000011", [{ part: 1, qty: 1, sku: "SKU-COMMON" }]),
    ],
  });
  const queue = new AutoQueue();
  const firstPreview = await runPreview({ user: USER, ...ZONE, ...caps, queue });
  assert.deepEqual(firstPreview.preview.diff.inserted.sort(), ["TL0000000010", "TL0000000011"]);
  assert.deepEqual(firstPreview.preview.diff.removed, []);

  // Round 2: TL0000000010 vanishes from Locked Dump, TL0000000012 appears
  // new, and TL0000000011 gains a second tote holding SKU-COMMON so its
  // scarcity count changes.
  caps.setSources({
    GET_GRAFANA_LOCKED_TOTES: [locked("TL0000000011"), locked("TL0000000012")],
    GET_QUADRON_INVENTORY: [
      invEntry("TL0000000011", [{ part: 1, qty: 1, sku: "SKU-COMMON" }]),
      invEntry("TL0000000012", [{ part: 1, qty: 1, sku: "SKU-COMMON" }]),
    ],
  });
  const secondPreview = await runPreview({ user: USER, ...ZONE, ...caps, queue });
  assert.deepEqual(secondPreview.preview.diff.removed, ["TL0000000010"]);
  assert.deepEqual(secondPreview.preview.diff.inserted, ["TL0000000012"]);
  assert.deepEqual(secondPreview.preview.diff.reprioritized, ["TL0000000011"], "worst-count went from 1 tote to 2 totes holding SKU-COMMON, so priority changes P0->P1");
  assert.equal(secondPreview.preview.totalQueueCount, 2);
});

test("batchSize defaults to config.autoBatchSize when omitted, honors an explicit override", async () => {
  const config = require("../../../config");
  const caps = makeControllableCapabilities({
    GET_GRAFANA_LOCKED_TOTES: Array.from({ length: 10 }, (_, i) => locked(`TL${String(i).padStart(10, "0")}`)),
  });
  const defaultResult = await runPreview({ user: USER, ...ZONE, ...caps, queue: new AutoQueue() });
  assert.equal(defaultResult.preview.batchSize, config.autoBatchSize);

  const overrideResult = await runPreview({ user: USER, ...ZONE, ...caps, batchSize: 3, queue: new AutoQueue() });
  assert.equal(overrideResult.preview.batchSize, 3);
  assert.equal(overrideResult.preview.firstBatch.length, 3);
});

test("Locked Since is populated read-only from the local store for a tote already tracked by Classification, null otherwise", async () => {
  localStore.writeCollection("classification_tote_state", [
    { tote_id: "TL0000000099", first_seen_at: "2026-08-20T10:00:00.000Z", last_seen_at: "2026-08-23T10:00:00.000Z", discrepancy_marked_at: null },
  ]);
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("TL0000000099"), locked("TL0000000098")] });
  const result = await runPreview({ user: USER, ...ZONE, ...caps, queue: new AutoQueue() });
  const tracked = result.preview.queue.find((r) => r.toteId === "TL0000000099");
  const untracked = result.preview.queue.find((r) => r.toteId === "TL0000000098");
  assert.equal(tracked.lockedSince, "2026-08-20T10:00:00.000Z");
  assert.equal(untracked.lockedSince, null);
});

test("Preview never writes to classification_tote_state - reading it before and after a preview shows no change", async () => {
  const before = localStore.readCollection("classification_tote_state", []);
  const caps = makeControllableCapabilities({ GET_GRAFANA_LOCKED_TOTES: [locked("TL0000000097")] });
  await runPreview({ user: USER, ...ZONE, ...caps, queue: new AutoQueue() });
  const after = localStore.readCollection("classification_tote_state", []);
  assert.deepEqual(before, after);
});

// ── Structural safety proofs ───────────────────────────────────────────────

const BANNED_DISPATCH_IMPORTS = /require\(\s*["'][^"']*(quadronPull|quadronPullLock|totePullEngine|toteDispatchLoop|pullQuadronTote)["']\s*\)/;
const AUTOENGINE_IMPORT = /require\(\s*["'][^"']*[/\\]autoEngine["']\s*\)/;

test("autoPreview.js has no code path touching pull/dispatch modules or autoEngine.js's own session state", () => {
  const src = fs.readFileSync(require.resolve("../../../features/tote-puller/autoPreview.js"), "utf8");
  assert.doesNotMatch(src, BANNED_DISPATCH_IMPORTS);
  assert.doesNotMatch(src, AUTOENGINE_IMPORT);
});

test("autoPreview.js never imports queryManager or auditLog - it creates no operation/session record", () => {
  const src = fs.readFileSync(require.resolve("../../../features/tote-puller/autoPreview.js"), "utf8");
  assert.doesNotMatch(src, /require\(\s*["'][^"']*\/queryManager["']\s*\)/);
  assert.doesNotMatch(src, /require\(\s*["'][^"']*\/auditLog["']\s*\)/);
});

test("autoPreview.js only ever requests the three GET_* capabilities - PULL_QUADRON_TOTE never appears as functional code (comments aside)", () => {
  const src = fs.readFileSync(require.resolve("../../../features/tote-puller/autoPreview.js"), "utf8");
  const codeOnly = src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert.doesNotMatch(codeOnly, /PULL_QUADRON_TOTE/);
});

test("autoPreview.js calls queue.peekNext(), never queue.next() - the preview queue is never drained", () => {
  const src = fs.readFileSync(require.resolve("../../../features/tote-puller/autoPreview.js"), "utf8");
  assert.match(src, /queue\.peekNext\(/);
  assert.doesNotMatch(src, /queue\.next\(/);
});

test("autoPreview.js validates via the SAME validateZoneConfig()/pickNextZone() zonePicker.js exports - no second station-selection implementation", () => {
  const src = fs.readFileSync(require.resolve("../../../features/tote-puller/autoPreview.js"), "utf8");
  assert.match(src, /require\(\s*["'][^"']*\/zonePicker["']\s*\)/);
  assert.match(src, /validateZoneConfig\(/);
  assert.match(src, /pickNextZone\(/);
});
