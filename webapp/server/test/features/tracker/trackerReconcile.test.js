// Pure unit tests for server/features/tracker/trackerReconcile.js - Outside Tote
// Analysis's reconciliation logic. No database, no network, no capability
// dispatch of any kind.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isCandidateStatus,
  isVirtualTote,
  VIRTUAL_TOTE_IDS,
  buildBaseRows,
  applyLastGood,
  buildSkuToTotes,
  skusForTote,
  computePurgeSafety,
  applyBlockedAndPurgeSafety,
  pickOutCandidates,
  filterStaleByFinder,
  mergeContainerTrackingFields,
} = require("../../../features/tracker/trackerReconcile");

test("isCandidateStatus: only Outside Tote and Bad Tracker are candidates for blocked/purge-safety", () => {
  assert.equal(isCandidateStatus("Outside Tote"), true);
  assert.equal(isCandidateStatus("Bad Tracker"), true);
  assert.equal(isCandidateStatus("On Location"), false);
  assert.equal(isCandidateStatus("Buffer"), false);
  assert.equal(isCandidateStatus("—"), false);
});

test("buildBaseRows: derives status from the finder row's location, keeps input tote order, caps scans at 5", () => {
  const finderRows = [{ tracker: "T1", container: "TL0000000001", location: "OUTBOUND_1", lane: "L1", updated_timestamp: "2026-01-01" }];
  const scanRows = Array.from({ length: 7 }, (_, i) => ({ scanner: `SC${i}`, container: "TL0000000001", create_time: `t${i}`, decision: "OK", decision_reason: null }));
  const rows = buildBaseRows(["TL0000000001", "TL0000000002"], finderRows, scanRows);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tote, "TL0000000001");
  assert.equal(rows[0].status, "Outside Tote");
  assert.equal(rows[0].scans.length, 5, "must cap at 5 most recent scans");
  assert.equal(rows[1].tote, "TL0000000002");
  assert.equal(rows[1].status, "", "a tote with no finder row has no location to classify");
});

test("isVirtualTote: matches the operator-provided exception list case-insensitively and trims whitespace, never matches an arbitrary tote", () => {
  assert.equal(isVirtualTote("TL0000005366"), true);
  assert.equal(isVirtualTote("tl0000005366"), true, "case-insensitive");
  assert.equal(isVirtualTote("  TL0000005366  "), true, "trims whitespace");
  assert.equal(isVirtualTote("TS0000013844"), true, "last id in the list");
  assert.equal(isVirtualTote("TL0000000001"), false);
  assert.equal(isVirtualTote(""), false);
  assert.equal(isVirtualTote(null), false);
  assert.equal(VIRTUAL_TOTE_IDS.size, 27, "the operator's own pasted list had 27 ids");
});

test("buildBaseRows: a Virtual Tote exception overrides whatever classifyStatus() would have said (even a genuine Location=OUT), on Manual AND Auto Mode alike since both share this function", () => {
  const finderRows = [{ tracker: "T1", container: "TL0000005366", location: "OUTBOUND_1", lane: "L1", updated_timestamp: "2026-01-01" }];
  const [row] = buildBaseRows(["TL0000005366"], finderRows, []);
  assert.equal(row.status, "Virtual Tote", "would otherwise classify as Outside Tote - the exact case the operator flagged");
  assert.equal(isCandidateStatus(row.status), false, "never treated as a purge/blocked-inventory candidate");
});

test("buildBaseRows: a tote NOT on the exception list still classifies normally", () => {
  const finderRows = [{ tracker: "T1", container: "TL0000000001", location: "OUTBOUND_1", lane: "L1", updated_timestamp: "2026-01-01" }];
  const [row] = buildBaseRows(["TL0000000001"], finderRows, []);
  assert.equal(row.status, "Outside Tote");
});

test("buildBaseRows: a tote with no finder row still gets a full row shape, not undefined fields", () => {
  const [row] = buildBaseRows(["TL0000000001"], [], []);
  assert.equal(row.tracker, "");
  assert.equal(row.location, "");
  assert.equal(row.lastGood, "");
  assert.deepEqual(row.scans, []);
  assert.equal(row.latestScan, null);
});

test("applyLastGood: only Bad Tracker rows get a lastGood value, from the rn=2 tracker_history entry", () => {
  const rows = [
    { tote: "T1", status: "Bad Tracker", tracker: "TR1", lastGood: "" },
    { tote: "T2", status: "On Location", tracker: "TR2", lastGood: "" },
  ];
  const history = [
    { tracker: "TR1", destination: "007-01", rn: 1 },
    { tracker: "TR1", destination: "007-02", rn: 2 }, // the LAST GOOD one
  ];
  const updated = applyLastGood(rows, history);
  assert.equal(updated[0].lastGood, "007-02");
  assert.equal(updated[1].lastGood, "", "a non-Bad-Tracker row is never given a lastGood value");
});

test("applyLastGood: a Bad Tracker tote with no matching rn=2 history entry gets an empty lastGood, never throws", () => {
  const rows = [{ tote: "T1", status: "Bad Tracker", tracker: "TR9", lastGood: "" }];
  const updated = applyLastGood(rows, []);
  assert.equal(updated[0].lastGood, "");
});

test("buildSkuToTotes: maps every SKU to the SET of distinct base totes holding it, across ALL rows (not just candidates)", () => {
  const quadronRows = [
    { toteId: "T1", partitions: [{ part: 1, qty: 5, sku: "SKU_A" }] },
    { toteId: "T2", partitions: [{ part: 1, qty: 2, sku: "SKU_A" }, { part: 2, qty: 1, sku: "SKU_B" }] },
  ];
  const map = buildSkuToTotes(quadronRows);
  assert.deepEqual([...map.get("SKU_A")].sort(), ["T1", "T2"]);
  assert.deepEqual([...map.get("SKU_B")], ["T2"]);
});

test("skusForTote: returns the deduplicated SKU list for one tote, empty if the tote isn't in Quadron's rows", () => {
  const quadronRows = [{ toteId: "T1", partitions: [{ part: 1, sku: "SKU_A" }, { part: 2, sku: "SKU_A" }, { part: 3, sku: "SKU_B" }] }];
  assert.deepEqual(skusForTote(quadronRows, "T1").sort(), ["SKU_A", "SKU_B"]);
  assert.deepEqual(skusForTote(quadronRows, "T9"), []);
});

test("computePurgeSafety: safe only when EVERY PID's facility-wide tote count is > 2", () => {
  const skuToTotes = new Map([
    ["SKU_A", new Set(["T1", "T2", "T3"])], // count 3 - safe on its own
    ["SKU_B", new Set(["T1", "T2"])], // count 2 - unsafe (scarce)
  ]);
  const result = computePurgeSafety(["SKU_A", "SKU_B"], skuToTotes);
  assert.equal(result.safe, false, "one scarce PID makes the whole tote unsafe");
  assert.equal(result.min, 2);
  assert.deepEqual(result.unsafe.map((u) => u.pid), ["SKU_B"]);
});

test("computePurgeSafety: safe when every PID exceeds the scarcity threshold", () => {
  const skuToTotes = new Map([["SKU_A", new Set(["T1", "T2", "T3"])]]);
  const result = computePurgeSafety(["SKU_A"], skuToTotes);
  assert.equal(result.safe, true);
  assert.deepEqual(result.unsafe, []);
});

test("computePurgeSafety: no known SKUs at all -> nothing to say (null/empty), never a fabricated verdict", () => {
  const result = computePurgeSafety([], new Map());
  assert.equal(result.safe, null);
  assert.equal(result.min, null);
  assert.deepEqual(result.unsafe, []);
});

test("applyBlockedAndPurgeSafety: non-candidate rows are returned completely unchanged", () => {
  const rows = [{ tote: "T1", status: "On Location", blocked: undefined }];
  const result = applyBlockedAndPurgeSafety(rows, [], new Map());
  assert.equal(result[0].blocked, undefined);
});

test("applyBlockedAndPurgeSafety: a candidate with no known SKUs reports null/empty, not a crash", () => {
  const rows = [{ tote: "T1", status: "Outside Tote" }];
  const result = applyBlockedAndPurgeSafety(rows, [], new Map());
  assert.equal(result[0].blocked, null);
  assert.equal(result[0].purgeSafe, null);
  assert.deepEqual(result[0].unsafePids, []);
});

test("applyBlockedAndPurgeSafety: blocked is the SUM of blockedInventory across the tote's own SKUs, null if none resolved", () => {
  const quadronRows = [{ toteId: "T1", partitions: [{ part: 1, sku: "SKU_A" }, { part: 2, sku: "SKU_B" }] }];
  const blockedBySku = new Map([["SKU_A", 3], ["SKU_B", 4]]);
  const rows = [{ tote: "T1", status: "Outside Tote" }];
  const result = applyBlockedAndPurgeSafety(rows, quadronRows, blockedBySku);
  assert.equal(result[0].blocked, 7);
});

test("applyBlockedAndPurgeSafety: a SKU with no resolved blocked value is excluded from the sum, not treated as 0", () => {
  const quadronRows = [{ toteId: "T1", partitions: [{ part: 1, sku: "SKU_A" }, { part: 2, sku: "SKU_B" }] }];
  const blockedBySku = new Map([["SKU_A", 3]]); // SKU_B never resolved (e.g. NexS lookup failed)
  const rows = [{ tote: "T1", status: "Outside Tote" }];
  const result = applyBlockedAndPurgeSafety(rows, quadronRows, blockedBySku);
  assert.equal(result[0].blocked, 3);
});

// ── Auto Mode (discovery via GET_GRAFANA_CONTAINER_TRACKING) ──────────────

test("pickOutCandidates: only Location='OUT' rows are candidates, deduplicated by container", () => {
  const containerRows = [
    { container: "T1", location: "OUT" },
    { container: "T2", location: "007-01" },
    { container: "T1", location: "OUT" }, // duplicate - must not appear twice
    { container: "T3", location: "OUT" },
  ];
  assert.deepEqual(pickOutCandidates(containerRows), ["T1", "T3"]);
});

test("pickOutCandidates: an empty/missing input never throws", () => {
  assert.deepEqual(pickOutCandidates([]), []);
  assert.deepEqual(pickOutCandidates(undefined), []);
});

// NOTE on these fixtures: updated_timestamp's raw digits are IST wall-clock
// time (see istTimestamp.js) - filterStaleByFinder converts them to true
// UTC (raw digits - 5.5h) before comparing against staleBeforeMs, which is
// itself already a genuine UTC value. So a raw digit reading of "X:30"
// converts to a true-UTC instant of "X-5:00" (e.g. raw 12:00 -> true UTC
// 06:30) - these fixtures are written as the RAW (pre-correction) digits
// Grafana would actually deliver, not the true UTC instant directly.
test("filterStaleByFinder: keeps only totes with a finder row whose updated_timestamp is at/before the cutoff", () => {
  const cutoff = new Date("2026-01-01T12:00:00Z").getTime();
  const finderRows = [
    { container: "T1", updated_timestamp: "2026-01-01T00:00:00Z" }, // raw digits -> true UTC 2025-12-31T18:30:00Z - well before cutoff
    { container: "T2", updated_timestamp: "2026-01-01T18:00:00Z" }, // raw digits -> true UTC 2026-01-01T12:30:00Z - after cutoff
  ];
  assert.deepEqual(filterStaleByFinder(["T1", "T2"], finderRows, cutoff), ["T1"]);
});

test("filterStaleByFinder: a tote with no finder row or no timestamp is excluded, never guessed stale", () => {
  const cutoff = Date.now();
  const finderRows = [{ container: "T2", updated_timestamp: null }];
  assert.deepEqual(filterStaleByFinder(["T1", "T2"], finderRows, cutoff), []);
});

test("filterStaleByFinder: a timestamp exactly at the cutoff counts as stale (<=)", () => {
  const cutoff = new Date("2026-01-01T12:00:00Z").getTime();
  // raw digits 17:30 -> true UTC 17:30 - 5.5h = 12:00:00Z, exactly the cutoff.
  const finderRows = [{ container: "T1", updated_timestamp: "2026-01-01T17:30:00Z" }];
  assert.deepEqual(filterStaleByFinder(["T1"], finderRows, cutoff), ["T1"]);
});

// Regression test for the bug this pass fixed (operator-reported "confirm
// the credibility of Auto Mode"): a tote whose TRUE age is 14h (inside the
// documented ">12h" window Auto Mode is supposed to catch) was previously
// missed entirely, because comparing the RAW (uncorrected) digits against a
// true-UTC cutoff made every tote look ~5.5h fresher than it really was -
// silently requiring ~17.5h of true staleness instead of 12h.
test("filterStaleByFinder: a tote genuinely 14h stale IS caught (previously silently missed by the pre-fix naive parse)", () => {
  const assumedNow = Date.UTC(2026, 0, 2, 12, 0, 0); // 2026-01-02T12:00:00Z
  const cutoff = assumedNow - 12 * 3600000; // Auto Mode's own ">12h" threshold, in true UTC
  // True last-updated instant: 14h before assumedNow = 2026-01-01T22:00:00Z.
  // Grafana relays this facility's IST wall-clock digits for that instant
  // (true UTC + 5:30) = 2026-01-02T03:30:00.
  const finderRows = [{ container: "T1", updated_timestamp: "2026-01-02T03:30:00Z" }];
  assert.deepEqual(filterStaleByFinder(["T1"], finderRows, cutoff), ["T1"]);
});

test("mergeContainerTrackingFields: joins zone/shuttle/health/stock-check-blocked/bin-blocked onto rows by tote id", () => {
  const rows = [{ tote: "T1", status: "Outside Tote" }];
  const containerRows = [
    { container: "T1", zone: "aisle_03_zone_03", shuttle: "QD_Shuttle_03_03", shuttleHealthStatus: "HEALTHY", stockCheckBlocked: "NO", binBlocked: "NO" },
  ];
  const [merged] = mergeContainerTrackingFields(rows, containerRows);
  assert.equal(merged.zone, "aisle_03_zone_03");
  assert.equal(merged.shuttle, "QD_Shuttle_03_03");
  assert.equal(merged.shuttleHealthStatus, "HEALTHY");
  assert.equal(merged.stockCheckBlocked, "NO");
  assert.equal(merged.binBlocked, "NO");
});

test("mergeContainerTrackingFields: a row with no matching container-tracking entry is returned unchanged", () => {
  const rows = [{ tote: "T9", status: "Outside Tote" }];
  const [merged] = mergeContainerTrackingFields(rows, []);
  assert.equal(merged.zone, undefined);
});
