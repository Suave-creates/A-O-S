// Pure unit tests for the PULL_QUADRON_TOTE capability's backend-side logic
// (server/integrations/quadron/pullQuadronTote.js). No database, no network, no live
// runtime, and NEVER a real Quadron call - buildPayload/validateResult are
// plain functions.

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPayload, validateResult, TOTE_ID_REGEX } = require("../../../integrations/quadron/pullQuadronTote");

test("buildPayload returns exactly {quadronOrigin, toteId, zone, instanceCode}", () => {
  const payload = buildPayload("https://192.168.24.230", { toteId: "TL0000002607", zone: "12", instanceCode: "LK-069" });
  assert.deepEqual(payload, {
    quadronOrigin: "https://192.168.24.230",
    toteId: "TL0000002607",
    zone: "12",
    instanceCode: "LK-069",
  });
});

test("buildPayload tolerates missing params (defensive, backend route validates first)", () => {
  const payload = buildPayload("https://192.168.24.230", undefined);
  assert.equal(payload.quadronOrigin, "https://192.168.24.230");
  assert.equal(payload.toteId, undefined);
});

test("TOTE_ID_REGEX matches the existing extension's own TOTE_ID_REGEX exactly", () => {
  assert.ok(TOTE_ID_REGEX.test("TL0000002607"));
  assert.ok(TOTE_ID_REGEX.test("TS0000000001"));
  assert.ok(!TOTE_ID_REGEX.test("TL000000260"));   // too short
  assert.ok(!TOTE_ID_REGEX.test("TX0000002607"));  // wrong prefix
  assert.ok(!TOTE_ID_REGEX.test("TL0000002607-1")); // partition suffix not allowed
});

test("validateResult accepts each of the four real verdicts", () => {
  for (const verdict of ["INSERTED", "ALREADY_QUEUED", "RELEASED", "NOT_AVAILABLE"]) {
    const result = { verdict, rawMessage: "ok", toteId: "TL0000002607", zone: "12", instanceCode: "LK-069", completedAt: "2026-01-01T00:00:00.000Z" };
    assert.deepEqual(validateResult(result), { ok: true }, `verdict ${verdict} should validate`);
  }
});

test("validateResult rejects a fabricated/unknown verdict", () => {
  const v = validateResult({ verdict: "SUCCESS", toteId: "TL0000002607" });
  assert.equal(v.ok, false);
  assert.match(v.reason, /unexpected verdict/);
});

test("validateResult rejects a missing or malformed toteId", () => {
  assert.equal(validateResult({ verdict: "INSERTED", toteId: "not-a-tote" }).ok, false);
  assert.equal(validateResult({ verdict: "INSERTED" }).ok, false);
  assert.equal(validateResult(null).ok, false);
});

// Directly enforces "never expose JWTs in ... CAPABILITY_RESULT": any
// unexpected field - including something that looks like an accidentally
// attached token - is rejected, not passed through.
test("validateResult rejects a result carrying an unexpected field (e.g. an accidental token)", () => {
  const v = validateResult({
    verdict: "INSERTED",
    toteId: "TL0000002607",
    zone: "12",
    instanceCode: "LK-069",
    completedAt: "2026-01-01T00:00:00.000Z",
    token: "abc.def.ghi",
  });
  assert.equal(v.ok, false);
  assert.match(v.reason, /unexpected field in result: token/);
});
