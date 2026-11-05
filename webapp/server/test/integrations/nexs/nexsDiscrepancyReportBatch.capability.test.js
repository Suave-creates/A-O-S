// Unit tests for server/integrations/nexs/nexsDiscrepancyReportBatch.js -
// buildPayload/validateResult only. No network, no runtime, no real NexS call.

const test = require("node:test");
const assert = require("node:assert/strict");
const cap = require("../../../integrations/nexs/nexsDiscrepancyReportBatch");

test("buildPayload embeds nexsOrigin/items/facilityCode, defaulting facilityCode to NXS1", () => {
  const payload = cap.buildPayload("https://nexs.example", { items: [{ base: "TS0000018492", part: 6 }] });
  assert.equal(payload.nexsOrigin, "https://nexs.example");
  assert.deepEqual(payload.items, [{ base: "TS0000018492", part: 6 }]);
  assert.equal(payload.facilityCode, "NXS1");
});

test("buildPayload preserves an explicit facilityCode", () => {
  const payload = cap.buildPayload("https://nexs.example", { items: [{ base: "TS0000018492", part: 1 }], facilityCode: "NXS2" });
  assert.equal(payload.facilityCode, "NXS2");
});

test("buildPayload rejects an empty or missing items array", () => {
  assert.throws(() => cap.buildPayload("https://nexs.example", { items: [] }), /non-empty items array/);
  assert.throws(() => cap.buildPayload("https://nexs.example", {}), /non-empty items array/);
});

test("buildPayload rejects an invalid base tote id", () => {
  assert.throws(() => cap.buildPayload("https://nexs.example", { items: [{ base: "not-a-tote", part: 1 }] }), /invalid base tote id/);
});

test("buildPayload rejects a non-positive-integer partition number", () => {
  assert.throws(() => cap.buildPayload("https://nexs.example", { items: [{ base: "TS0000018492", part: 0 }] }), /invalid partition number/);
  assert.throws(() => cap.buildPayload("https://nexs.example", { items: [{ base: "TS0000018492", part: 1.5 }] }), /invalid partition number/);
  assert.throws(() => cap.buildPayload("https://nexs.example", { items: [{ base: "TS0000018492", part: "6" }] }), /invalid partition number/);
});

test("validateResult accepts a well-shaped results array (mixed ok/failed)", () => {
  const r = cap.validateResult({
    results: [
      { base: "TS0000018492", part: 6, status: "ok", imsCount: 3, error: null },
      { base: "TS0000018493", part: 1, status: "failed", imsCount: null, error: "timeout" },
    ],
  });
  assert.equal(r.ok, true);
});

test("validateResult rejects a missing/non-array results field", () => {
  assert.equal(cap.validateResult({}).ok, false);
  assert.equal(cap.validateResult({ results: "nope" }).ok, false);
});

test("validateResult rejects an entry with an invalid status or non-integer part", () => {
  assert.equal(cap.validateResult({ results: [{ base: "TS0000018492", part: 6, status: "weird" }] }).ok, false);
  assert.equal(cap.validateResult({ results: [{ base: "TS0000018492", part: 6.5, status: "ok" }] }).ok, false);
});

test("validateResult rejects a non-numeric imsCount", () => {
  assert.equal(cap.validateResult({ results: [{ base: "TS0000018492", part: 6, status: "ok", imsCount: "3" }] }).ok, false);
});
