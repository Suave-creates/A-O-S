// Unit tests for server/integrations/grafana/grafanaAisleOccupancy.js -
// buildPayload/validateResult only. No network, no runtime, no real
// Grafana call.

const test = require("node:test");
const assert = require("node:assert/strict");
const grafanaAisleOccupancy = require("../../../integrations/grafana/grafanaAisleOccupancy");

test("buildPayload embeds the fixed SQL/datasource (rerQ11pVk/1, same as CC Metrics) with no required params", () => {
  const payload = grafanaAisleOccupancy.buildPayload("https://grafana.example");
  assert.equal(payload.grafanaOrigin, "https://grafana.example");
  assert.equal(payload.datasourceUid, "rerQ11pVk");
  assert.equal(payload.datasourceType, "mssql");
  assert.equal(payload.datasourceId, 1);
  assert.match(payload.occupancySql, /TotalTotes/);
  assert.match(payload.occupancySql, /lenskart_quadron/);
  assert.match(payload.longShortSql, /buffer_category/);
});

function validResult() {
  return {
    occupancy: [
      { aisle: "001", value: 81.8234 },
      { aisle: "002", value: 73.1252 },
      { aisle: "003", value: 83.1741 },
      { aisle: "004", value: 39.1825 },
      { aisle: "005", value: 81.36061 },
      { aisle: "006", value: 43.51954 },
    ],
    longShort: [
      { aisle: "001", category: "TALL", occupancy: 81.5 },
      { aisle: "001", category: "SHORT", occupancy: 82.6 },
    ],
  };
}

test("validateResult accepts a well-shaped result with real aisle numbers and TALL/SHORT categories", () => {
  assert.deepEqual(grafanaAisleOccupancy.validateResult(validResult()), { ok: true });
});

test("validateResult rejects an occupancy entry with an aisle outside 001-006", () => {
  const r = validResult();
  r.occupancy[0].aisle = "007";
  const v = grafanaAisleOccupancy.validateResult(r);
  assert.equal(v.ok, false);
  assert.match(v.reason, /unexpected aisle/);
});

test("validateResult rejects a longShort entry with a category other than TALL/SHORT", () => {
  const r = validResult();
  r.longShort[0].category = "MEDIUM";
  const v = grafanaAisleOccupancy.validateResult(r);
  assert.equal(v.ok, false);
  assert.match(v.reason, /unexpected category/);
});

test("validateResult rejects non-numeric value/occupancy fields", () => {
  const r1 = validResult();
  r1.occupancy[0].value = "81.8";
  assert.equal(grafanaAisleOccupancy.validateResult(r1).ok, false);

  const r2 = validResult();
  r2.longShort[0].occupancy = "81.5";
  assert.equal(grafanaAisleOccupancy.validateResult(r2).ok, false);
});

test("validateResult accepts null value/occupancy (a real, honest 'no data for this aisle' reading, not fabricated)", () => {
  const r = validResult();
  r.occupancy[0].value = null;
  assert.deepEqual(grafanaAisleOccupancy.validateResult(r), { ok: true });
});

test("validateResult rejects when occupancy/longShort is missing or not an array", () => {
  assert.equal(grafanaAisleOccupancy.validateResult({ occupancy: "x", longShort: [] }).ok, false);
  assert.equal(grafanaAisleOccupancy.validateResult({ occupancy: [], longShort: "x" }).ok, false);
  assert.equal(grafanaAisleOccupancy.validateResult(null).ok, false);
  assert.equal(grafanaAisleOccupancy.validateResult({}).ok, false);
});
