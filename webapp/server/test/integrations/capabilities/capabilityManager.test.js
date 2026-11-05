// Unit tests for server/integrations/capabilities/capabilityManager.js: request
// coalescing, the short-TTL result cache, cancellation semantics, and the
// direct (server-side) dispatch contract. All dependencies are injected fakes
// (deps option) - no real MySQL or network. requestCoalescer is the REAL
// module (already independently unit-tested) since it is pure and
// dependency-free - reset() between tests keeps them isolated.

const test = require("node:test");
const assert = require("node:assert/strict");
const capabilityManager = require("../../../integrations/capabilities/capabilityManager");
const coalescer = require("../../../integrations/capabilities/requestCoalescer");

const USER = { id: 1, role: "USER" };

test.beforeEach(() => {
  coalescer.reset();
});

// ── Fakes ────────────────────────────────────────────────────────────────

function makeFakeQueryManager() {
  const rows = new Map();
  const registry = new Map();
  let nextId = 1;
  return {
    rows,
    async createQuery({ userId, operation, parameters }) {
      const query_id = `Q-${nextId++}`;
      rows.set(query_id, { query_id, user_id: userId, operation, status: "QUEUED", parameters: JSON.stringify(parameters || {}) });
      return rows.get(query_id);
    },
    async markRunning(queryId) {
      const r = rows.get(queryId);
      if (r) r.status = "RUNNING";
    },
    async getQuery(queryId) {
      return rows.get(queryId) || null;
    },
    async completeQuery(queryId) {
      const r = rows.get(queryId);
      if (r) r.status = "COMPLETED";
    },
    async failQuery(queryId, error) {
      const r = rows.get(queryId);
      if (r) { r.status = "FAILED"; r.error = error; }
    },
    async timeoutQuery(queryId) {
      const r = rows.get(queryId);
      if (r) r.status = "TIMEOUT";
    },
    async finalizeCancelled(queryId) {
      const r = rows.get(queryId);
      if (r) r.status = "CANCELLED";
    },
    registerJob(queryId, controller) {
      const entry = { controller, cancelledByUser: false };
      registry.set(queryId, entry);
      return { signal: controller.signal, wasCancelledByUser: () => entry.cancelledByUser };
    },
    unregisterJob(queryId) {
      registry.delete(queryId);
    },
    // Test helper, not part of the real interface - simulates an operator
    // clicking Cancel on this specific query_id.
    cancelForTest(queryId) {
      const entry = registry.get(queryId);
      if (!entry) return false;
      entry.cancelledByUser = true;
      entry.controller.abort();
      return true;
    },
  };
}

function makeFakeAuditLog() {
  const calls = [];
  return { calls, async record(userId, action, detail) { calls.push({ userId, action, detail }); } };
}

// A fake capability whose directExecute() is controllable: every call is
// recorded in `calls` and stays pending until the test resolves/rejects it.
function makeFakeRegistry({ readOnly = true, timeoutMs = 5000 } = {}) {
  const calls = [];
  const capability = {
    name: readOnly ? "FAKE_READ" : "FAKE_WRITE",
    readOnly,
    write: !readOnly,
    timeoutMs,
    allowedRoles: ["ADMIN", "USER"],
    auditAction: readOnly ? "CAPABILITY_FAKE_READ" : "CAPABILITY_FAKE_WRITE",
    authService: "fake",
    // Derives its payload from params; directExecute must receive THIS
    // output, never the caller's raw params (most real callers pass none).
    buildPayload: (params) => ({ params: params || {}, fromBuildPayload: true }),
    validateResult: (result) => (result && result.invalid ? { ok: false, reason: "invalid" } : { ok: true }),
    directExecute: (appUserId, payload, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ appUserId, payload, signal, resolve, reject });
      }),
  };
  return { getCapability: (name) => (name === capability.name ? capability : null), capability, calls };
}

function makeDeps({ readOnly = true, timeoutMs = 5000 } = {}) {
  const queryManager = makeFakeQueryManager();
  const auditLog = makeFakeAuditLog();
  const registry = makeFakeRegistry({ readOnly, timeoutMs });
  return { deps: { queryManager, auditLog, registry, coalescer }, queryManager, auditLog, calls: registry.calls, capabilityName: registry.capability.name };
}

const respond = (calls, i, result) => calls[i].resolve(result);

async function flush() {
  await new Promise((r) => setImmediate(r));
}

// ── Basic pass-through ───────────────────────────────────────────────────

test("a normal read-only request executes once with buildPayload()'s output, completes, and getResult() returns the result", async () => {
  const { deps, calls, capabilityName } = makeDeps({ readOnly: true });
  const dispatch = await capabilityManager.requestCapability({ user: USER, capabilityName, params: { a: 1 }, deps });
  assert.equal(dispatch.ok, true);
  const queryId = dispatch.query.query_id;

  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].payload, { params: { a: 1 }, fromBuildPayload: true });
  assert.equal(calls[0].appUserId, USER.id);
  respond(calls, 0, { rows: ["real"] });
  await flush();

  assert.equal((await deps.queryManager.getQuery(queryId)).status, "COMPLETED");
  assert.deepEqual(capabilityManager.getResult(queryId), { rows: ["real"] });
});

// Regression: 2026-09-04 CNG Validator live run intermittently failed
// GET_QUADRON_INVENTORY with "Backend restarted before this query finished"
// even though the backend never actually restarted. Root cause: `try {
// return finalizeWithResult(...) } finally { queryManager.unregisterJob(...) }`
// runs the finally block as soon as finalizeWithResult() is CALLED, not once
// its own `await queryManager.completeQuery(...)` finishes. That left a
// window where the DB row was still RUNNING but the in-memory job was already
// unregistered; a concurrent poll then saw "ACTIVE status + no registered
// job" and reconcileStale() wrongly force-failed an otherwise-succeeding
// query.
test("unregisterJob() only fires AFTER the terminal-status write (completeQuery) has actually finished, never merely started", async () => {
  const { deps, calls, capabilityName, queryManager } = makeDeps({ readOnly: true });
  const order = [];
  const realCompleteQuery = queryManager.completeQuery.bind(queryManager);
  queryManager.completeQuery = async (queryId) => {
    order.push("completeQuery:start");
    await new Promise((r) => setTimeout(r, 20)); // simulates a real (slow/loaded) DB write
    await realCompleteQuery(queryId);
    order.push("completeQuery:end");
  };
  const realUnregisterJob = queryManager.unregisterJob.bind(queryManager);
  queryManager.unregisterJob = (queryId) => {
    order.push("unregisterJob");
    return realUnregisterJob(queryId);
  };

  await capabilityManager.requestCapability({ user: USER, capabilityName, params: { a: 1 }, deps });
  await flush();
  respond(calls, 0, { rows: ["real"] });
  await new Promise((r) => setTimeout(r, 40));

  assert.deepEqual(order, ["completeQuery:start", "completeQuery:end", "unregisterJob"]);
});

// ── Coalescing (read-only) ───────────────────────────────────────────────

test("two concurrent identical read-only requests are coalesced: directExecute runs ONCE, both queries complete with the same result", async () => {
  const { deps, calls, capabilityName } = makeDeps({ readOnly: true });

  const d1 = await capabilityManager.requestCapability({ user: USER, capabilityName, params: { a: 1 }, deps });
  const d2 = await capabilityManager.requestCapability({ user: USER, capabilityName, params: { a: 1 }, deps });
  assert.notEqual(d1.query.query_id, d2.query.query_id, "each caller still gets its own distinct query_id");

  await flush();
  assert.equal(calls.length, 1, "only the leader should have executed");

  respond(calls, 0, { rows: ["shared"] });
  await flush();
  await flush();

  assert.equal((await deps.queryManager.getQuery(d1.query.query_id)).status, "COMPLETED");
  assert.equal((await deps.queryManager.getQuery(d2.query.query_id)).status, "COMPLETED");
  assert.deepEqual(capabilityManager.getResult(d1.query.query_id), { rows: ["shared"] });
  assert.deepEqual(capabilityManager.getResult(d2.query.query_id), { rows: ["shared"] });
});

test("two concurrent requests with DIFFERENT params are never coalesced - both execute independently", async () => {
  const { deps, calls, capabilityName } = makeDeps({ readOnly: true });
  await capabilityManager.requestCapability({ user: USER, capabilityName, params: { a: 1 }, deps });
  await capabilityManager.requestCapability({ user: USER, capabilityName, params: { a: 2 }, deps });
  await flush();
  assert.equal(calls.length, 2, "different params must never share an execution");
});

// ── Short-TTL result cache ───────────────────────────────────────────────

test("a brand-new request for the same capability+params shortly after completion is served from cache - zero additional execution", async () => {
  const { deps, calls, capabilityName } = makeDeps({ readOnly: true });

  await capabilityManager.requestCapability({ user: USER, capabilityName, params: { a: 1 }, deps });
  await flush();
  respond(calls, 0, { rows: ["cached-value"] });
  await flush();

  const d2 = await capabilityManager.requestCapability({ user: USER, capabilityName, params: { a: 1 }, deps });
  await flush();

  assert.equal(calls.length, 1, "the second request must be served from cache, not executed again");
  assert.equal((await deps.queryManager.getQuery(d2.query.query_id)).status, "COMPLETED");
  assert.deepEqual(capabilityManager.getResult(d2.query.query_id), { rows: ["cached-value"] });
});

test("a FAILED execution is never cached - a subsequent request re-executes instead of reusing the failure", async () => {
  const { deps, calls, capabilityName } = makeDeps({ readOnly: true });

  const d1 = await capabilityManager.requestCapability({ user: USER, capabilityName, params: { a: 1 }, deps });
  await flush();
  calls[0].reject(new Error("boom"));
  await flush();

  const q1 = await deps.queryManager.getQuery(d1.query.query_id);
  assert.equal(q1.status, "FAILED");
  assert.equal(q1.error, "boom");

  await capabilityManager.requestCapability({ user: USER, capabilityName, params: { a: 1 }, deps });
  await flush();
  assert.equal(calls.length, 2, "a failed result must never be served to a later caller from cache");
});

// ── Write capabilities are never coalesced or cached ────────────────────

test("write capabilities (readOnly:false) always execute fresh - never coalesced even with identical params fired concurrently", async () => {
  const { deps, calls, capabilityName } = makeDeps({ readOnly: false });
  await capabilityManager.requestCapability({ user: USER, capabilityName, params: { toteId: "TL1" }, deps });
  await capabilityManager.requestCapability({ user: USER, capabilityName, params: { toteId: "TL1" }, deps });
  await flush();
  assert.equal(calls.length, 2, "every write is a real, distinct action - never shared");
});

// ── Cancellation semantics ───────────────────────────────────────────────

test("cancelling a FOLLOWER only detaches that follower - the leader still completes normally and is never aborted", async () => {
  const { deps, calls, capabilityName, queryManager } = makeDeps({ readOnly: true });

  const leader = await capabilityManager.requestCapability({ user: USER, capabilityName, params: { a: 1 }, deps });
  const follower = await capabilityManager.requestCapability({ user: USER, capabilityName, params: { a: 1 }, deps });
  await flush();

  queryManager.cancelForTest(follower.query.query_id);
  await flush();

  assert.equal((await queryManager.getQuery(follower.query.query_id)).status, "CANCELLED");
  assert.equal(calls[0].signal.aborted, false, "the shared execution must not be aborted by a follower's cancel");

  respond(calls, 0, { rows: ["still-good"] });
  await flush();
  assert.equal((await queryManager.getQuery(leader.query.query_id)).status, "COMPLETED");
  assert.deepEqual(capabilityManager.getResult(leader.query.query_id), { rows: ["still-good"] });
});

test("cancelling the LEADER aborts the real execution's signal and fails every follower too - never a fabricated success", async () => {
  const { deps, calls, capabilityName, queryManager } = makeDeps({ readOnly: true });

  const leader = await capabilityManager.requestCapability({ user: USER, capabilityName, params: { a: 1 }, deps });
  const follower = await capabilityManager.requestCapability({ user: USER, capabilityName, params: { a: 1 }, deps });
  await flush();

  queryManager.cancelForTest(leader.query.query_id);
  await flush();
  await flush();

  assert.equal(calls[0].signal.aborted, true, "cancellation must reach the in-flight request via its signal");
  assert.equal((await queryManager.getQuery(leader.query.query_id)).status, "CANCELLED");
  assert.equal((await queryManager.getQuery(follower.query.query_id)).status, "CANCELLED");
});

test("a capability that runs past its timeoutMs finalizes TIMEOUT, not CANCELLED", async () => {
  const { deps, capabilityName, queryManager } = makeDeps({ readOnly: true, timeoutMs: 20 });
  const dispatch = await capabilityManager.requestCapability({ user: USER, capabilityName, deps });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await queryManager.getQuery(dispatch.query.query_id)).status, "TIMEOUT");
});

// ── Validation / authorization ──────────────────────────────────────────

test("an unknown capability name is rejected before ever creating a query", async () => {
  const { deps } = makeDeps({ readOnly: true });
  const result = await capabilityManager.requestCapability({ user: USER, capabilityName: "NOT_REAL", deps });
  assert.equal(result.ok, false);
  assert.equal(result.code, 400);
});

test("a role not permitted for the capability is rejected", async () => {
  const { deps, capabilityName } = makeDeps({ readOnly: true });
  deps.registry.capability.allowedRoles = ["ADMIN"];
  const result = await capabilityManager.requestCapability({ user: { id: 1, role: "USER" }, capabilityName, deps });
  assert.equal(result.ok, false);
  assert.equal(result.code, 403);
});

test("a validateResult failure fails the query", async () => {
  const { deps, calls, capabilityName, queryManager } = makeDeps({ readOnly: true });
  const dispatch = await capabilityManager.requestCapability({ user: USER, capabilityName, deps });
  await flush();
  respond(calls, 0, { invalid: true });
  await flush();
  await flush();
  assert.equal((await queryManager.getQuery(dispatch.query.query_id)).status, "FAILED");
});

test("every capability in the real registry is executable server-side (authService + directExecute) with buildPayload/validateResult", () => {
  const registry = require("../../../integrations/capabilities/registry");
  for (const name of registry.listCapabilityNames()) {
    const cap = registry.getCapability(name);
    assert.ok(["grafana", "concinity", "nexs"].includes(cap.authService), `${name}: authService`);
    assert.equal(typeof cap.directExecute, "function", `${name}: directExecute`);
    assert.equal(typeof cap.buildPayload, "function", `${name}: buildPayload`);
    assert.equal(typeof cap.validateResult, "function", `${name}: validateResult`);
  }
});
