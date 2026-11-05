// Pure unit tests for the GET_QUADRON_INVENTORY capability's backend-side
// logic (server/integrations/quadron/quadronInventory.js). No database, no network,
// no live runtime - buildPayload/validateResult/reconcileWithGrafana are
// plain functions. Complements server/test/api.test.js (which needs a real
// MySQL test database and is not run in this environment - see its header).

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPayload, validateResult, reconcileWithGrafana } = require("../../../integrations/quadron/quadronInventory");

test("buildPayload returns exactly {quadronOrigin, instanceCode}", () => {
  const payload = buildPayload("https://192.168.24.230", "LK-069");
  assert.deepEqual(payload, { quadronOrigin: "https://192.168.24.230", instanceCode: "LK-069" });
});

test("validateResult accepts a well-formed result", () => {
  const result = {
    rows: [
      { toteId: "TL0000003490", quadronQty: 3, partitions: [{ part: 1, qty: 2, sku: "SKU1" }, { part: 2, qty: 1, sku: "SKU2" }] },
      { toteId: "TS0000018492", quadronQty: 0, partitions: [] },
    ],
  };
  assert.deepEqual(validateResult(result), { ok: true });
});

test("validateResult rejects a missing rows array", () => {
  assert.equal(validateResult({}).ok, false);
  assert.equal(validateResult(null).ok, false);
  assert.equal(validateResult({ rows: "not-an-array" }).ok, false);
});

test("validateResult rejects a row with an empty/missing toteId", () => {
  const v = validateResult({ rows: [{ toteId: "", quadronQty: 1, partitions: [] }] });
  assert.equal(v.ok, false);
  assert.match(v.reason, /toteId/);
});

test("validateResult rejects a non-numeric quadronQty", () => {
  const v = validateResult({ rows: [{ toteId: "TL0000003490", quadronQty: "3", partitions: [] }] });
  assert.equal(v.ok, false);
});

// Directly enforces the "no credentials/tokens in results" requirement: a
// row (or partition) carrying any field this capability doesn't expect -
// including something that looks like an accidentally-attached token - is
// rejected, not passed through.
test("validateResult rejects an unexpected field on a row (e.g. an accidental token)", () => {
  const v = validateResult({
    rows: [{ toteId: "TL0000003490", quadronQty: 1, partitions: [], token: "abc.def.ghi" }],
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /unexpected field in row: token/);
});

test("validateResult rejects an unexpected field on a partition", () => {
  const v = validateResult({
    rows: [{ toteId: "TL0000003490", quadronQty: 1, partitions: [{ part: 1, qty: 1, sku: null, authHeader: "Bearer x" }] }],
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /unexpected field in partition/);
});

// ── reconcileWithGrafana ────────────────────────────────────────────────

const grafanaResult = {
  rows: [
    { toteId: "TL0000000001", tracker: "T1", location: "L1", zone: "Z1", shuttle: "S1" },
    { toteId: "TL0000000002", tracker: "T2", location: "L2", zone: "Z2", shuttle: "S2" },
    { toteId: "TL0000000003", tracker: "T3", location: "L3", zone: "Z3", shuttle: "S3" },
  ],
};

test("reconcileWithGrafana: MATCH when Quadron shows a positive quantity", () => {
  const quadronResult = { rows: [{ toteId: "TL0000000001", quadronQty: 2, partitions: [] }] };
  const { rows } = reconcileWithGrafana(grafanaResult, quadronResult);
  assert.equal(rows.find((r) => r.toteId === "TL0000000001").verdict, "MATCH");
});

test("reconcileWithGrafana: MISMATCH when Quadron shows zero quantity", () => {
  const quadronResult = { rows: [{ toteId: "TL0000000002", quadronQty: 0, partitions: [] }] };
  const { rows } = reconcileWithGrafana(grafanaResult, quadronResult);
  assert.equal(rows.find((r) => r.toteId === "TL0000000002").verdict, "MISMATCH");
});

test("reconcileWithGrafana: MISSING_IN_QUADRON when the tote isn't in the Quadron result at all", () => {
  const quadronResult = { rows: [] };
  const { rows } = reconcileWithGrafana(grafanaResult, quadronResult);
  assert.equal(rows.find((r) => r.toteId === "TL0000000003").verdict, "MISSING_IN_QUADRON");
});

test("reconcileWithGrafana: summary counts match the per-row verdicts", () => {
  const quadronResult = {
    rows: [
      { toteId: "TL0000000001", quadronQty: 2, partitions: [] },
      { toteId: "TL0000000002", quadronQty: 0, partitions: [] },
    ],
  };
  const { rows, summary } = reconcileWithGrafana(grafanaResult, quadronResult);
  assert.equal(rows.length, 3);
  assert.deepEqual(summary, { MATCH: 1, MISMATCH: 1, MISSING_IN_QUADRON: 1 });
});
