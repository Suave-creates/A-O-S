// Unit tests for server/features/asrs-locations/asrsLocationsEngine.js - orchestration only (the
// occupancy math itself is covered directly in asrsLocationModel.test.js).
// requestCapability/wait/getResult/qm are all injected fakes - no real
// capability dispatch, no runtime, no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const asrsLocationsEngine = require("../../../features/asrs-locations/asrsLocationsEngine");

const USER = { id: 1, employeeId: "EMP001", role: "USER" };

function makeFakeQueryManager() {
  const calls = [];
  return {
    calls,
    async markRunning(queryId) { calls.push({ fn: "markRunning", queryId }); },
    async completeQuery(queryId) { calls.push({ fn: "completeQuery", queryId }); },
    async failQuery(queryId, error) { calls.push({ fn: "failQuery", queryId, error }); },
    registerJob(queryId, controller) {
      calls.push({ fn: "registerJob", queryId });
      return { signal: controller.signal, wasCancelledByUser: () => false };
    },
    unregisterJob(queryId) { calls.push({ fn: "unregisterJob", queryId }); },
  };
}

function makeFakeCapabilities(result) {
  const dispatched = [];
  return {
    dispatched,
    requestCapability: async ({ capabilityName, params }) => {
      dispatched.push({ capabilityName, params });
      return { ok: true, query: { query_id: "CAP-1" } };
    },
    wait: async (queryId) => ({ query_id: queryId, status: "COMPLETED" }),
    getResult: () => result,
  };
}

test("getAsrsLocations(): dispatches GET_GRAFANA_CONTAINER_TRACKING with no params and returns the built occupancy model", async () => {
  const fake = makeFakeCapabilities({ rows: [{ container: "T1", location: "006-03-1-183-1-02" }] });
  const qm = makeFakeQueryManager();
  const result = await asrsLocationsEngine.getAsrsLocations({
    queryId: "Q-1", user: USER,
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });
  assert.equal(fake.dispatched.length, 1);
  assert.equal(fake.dispatched[0].capabilityName, "GET_GRAFANA_CONTAINER_TRACKING");
  assert.deepEqual(fake.dispatched[0].params, {});
  assert.equal(result.occupiedSlots.length, 1);
  assert.equal(result.occupiedSlots[0].container, "T1");
  assert.ok(result.generatedAt);
  assert.equal(result.aisles.length, 6);
});

test("getAsrsLocations(): registers/unregisters the Query Manager job, completes on success", async () => {
  const fake = makeFakeCapabilities({ rows: [] });
  const qm = makeFakeQueryManager();
  await asrsLocationsEngine.getAsrsLocations({
    queryId: "Q-2", user: USER,
    requestCapability: fake.requestCapability, wait: fake.wait, getResult: fake.getResult, qm,
  });
  assert.deepEqual(qm.calls.map((c) => c.fn), ["registerJob", "markRunning", "completeQuery", "unregisterJob"]);
});

test("getAsrsLocations(): a capability dispatch failure fails the query and rethrows", async () => {
  const qm = makeFakeQueryManager();
  await assert.rejects(
    asrsLocationsEngine.getAsrsLocations({
      queryId: "Q-3", user: USER,
      requestCapability: async () => ({ ok: false, code: 503, reason: "No online runtime" }),
      wait: async () => ({ status: "COMPLETED" }),
      getResult: () => null,
      qm,
    }),
    /No online runtime/
  );
  assert.ok(qm.calls.some((c) => c.fn === "failQuery"));
});

test("getAsrsLocations(): a non-COMPLETED terminal status fails the query", async () => {
  const qm = makeFakeQueryManager();
  await assert.rejects(
    asrsLocationsEngine.getAsrsLocations({
      queryId: "Q-4", user: USER,
      requestCapability: async () => ({ ok: true, query: { query_id: "X" } }),
      wait: async () => ({ status: "TIMEOUT" }),
      getResult: () => null,
      qm,
    }),
    /TIMEOUT/
  );
});
