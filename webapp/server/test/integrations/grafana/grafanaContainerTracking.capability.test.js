// Unit tests for server/integrations/grafana/grafanaContainerTracking.js -
// buildPayload/validateResult only. No network, no runtime, no real Grafana
// call.

const test = require("node:test");
const assert = require("node:assert/strict");
const cap = require("../../../integrations/grafana/grafanaContainerTracking");

test("buildPayload embeds the fixed datasource and the fixed all-totes SQL, no params needed", () => {
  const payload = cap.buildPayload("https://grafana.example");
  assert.equal(payload.datasourceUid, "rerQ11pVk");
  assert.equal(payload.datasourceType, "mssql");
  assert.equal(payload.datasourceId, 1);
  assert.match(payload.sql, /lenskart_wes\.dbo\.tote_details/);
  assert.match(payload.sql, /AS location/);
  assert.doesNotMatch(payload.sql, /@containerId/, "the always-empty @containerId filter is dropped, not carried over dead");
});

test("validateResult accepts a well-shaped row", () => {
  const r = cap.validateResult({
    rows: [
      {
        container: "TL0000000001",
        tracker: 12345,
        location: "OUT",
        zone: "aisle_03_zone_03",
        shuttle: "QD_Shuttle_03_03",
        shuttleHealthStatus: "HEALTHY",
        stockCheckBlocked: "NO",
        binBlocked: "NO",
        badTracker: "NO",
      },
    ],
  });
  assert.equal(r.ok, true);
});

test("validateResult rejects missing/non-array rows", () => {
  assert.equal(cap.validateResult({}).ok, false);
  assert.equal(cap.validateResult({ rows: "nope" }).ok, false);
});

test("validateResult rejects a row missing container", () => {
  assert.equal(cap.validateResult({ rows: [{ location: "OUT" }] }).ok, false);
});

test("validateResult rejects an unexpected field in a row", () => {
  assert.equal(cap.validateResult({ rows: [{ container: "T1", extra: "x" }] }).ok, false);
});
