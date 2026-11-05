// Pure reconciliation logic for Outside Tote Analysis (Tracker) - status
// derivation, last-good-location assembly, and purge-safety arithmetic. No
// I/O here at all - see trackerEngine.js for the async capability dispatch.
//
// Scope note (deliberate, not an oversight): PID resolution for the
// blocked-on-tote/purge-safety sections uses Quadron's live inventory ONLY
// (Source A of the legacy extension's own 3-source fallback chain - ASRS
// dump and a Grafana WES tote_details fallback are NOT implemented in this
// pass). When Quadron has no live inventory for a candidate tote's SKUs,
// blocked/purgeSafe/pidToteMin/unsafePids all report as unavailable (null),
// never a fabricated guess.

const { classifyStatus } = require("../../platform/domain/toteStatus");
const { parseIstRawDigitsToUtcMs } = require("../../platform/time/istTimestamp");

function isCandidateStatus(status) {
  return status === "Outside Tote" || status === "Bad Tracker";
}

// Virtual Tote exceptions (operator-provided, 2026-09-03) - totes whose
// raw location would otherwise classify as "Outside Tote" (most of them
// genuinely are Location=OUT, which is exactly why an operator working
// this list directly noticed them) but are known NOT to be real outside
// totes needing physical follow-up - test/placeholder ids, the operator's
// own words: "count them as virtual totes not outside totes". Always
// overrides whatever classifyStatus() would have said, on both Manual and
// Auto Mode runs, since buildBaseRows() below is the ONE place every row's
// status gets set for both - no second code path to keep in sync. Never
// treated as a purge/blocked-inventory candidate either (isCandidateStatus()
// above only matches "Outside Tote"/"Bad Tracker") - a virtual tote isn't a
// real one to run that analysis against.
const VIRTUAL_TOTE_IDS = new Set([
  "TL0000005366", "TL0000014194", "TL0000014351", "TL0000009684", "TL0000013540",
  "TL0000020187", "TL0000009225", "TL0000018090", "TL0000017731", "TL0000004622",
  "TL0000032880", "TL0000020556", "TL0000007118", "TL0000013831", "TL0000005029",
  "TL0000021479", "TL0000000511", "TL0000002296", "TL0000021506", "TS0000002565",
  "TS0000017439", "TS0000017416", "TS0000020522", "TS0000017477", "TS0000021042",
  "TS0000018019", "TS0000013844",
]);

function isVirtualTote(toteId) {
  return VIRTUAL_TOTE_IDS.has(String(toteId || "").trim().toUpperCase());
}

// One row per requested tote, in the caller's own input order - status,
// tracker/location/lane/updated, and up to 5 recent scans. lastGood/blocked/
// purgeSafe fields are added later (they need a second/third dispatch).
function buildBaseRows(totes, finderRows, scanRows) {
  const finderByContainer = new Map((finderRows || []).map((r) => [r.container, r]));
  const scansByContainer = new Map();
  for (const s of scanRows || []) {
    if (!scansByContainer.has(s.container)) scansByContainer.set(s.container, []);
    scansByContainer.get(s.container).push(s);
  }

  return totes.map((tote) => {
    const f = finderByContainer.get(tote);
    const scans = (scansByContainer.get(tote) || []).slice(0, 5);
    const status = isVirtualTote(tote) ? "Virtual Tote" : classifyStatus(f ? f.location : null);
    return {
      tote,
      tracker: f ? f.tracker : "",
      location: f ? f.location : "",
      status,
      lastGood: "",
      lane: f ? f.lane : "",
      updated: f ? f.updated_timestamp : null,
      latestScan: scans[0] ? scans[0].create_time : null,
      scans: scans.map((s) => ({ scanner: s.scanner, reason: s.decision_reason, decision: s.decision })),
      blocked: undefined,
      purgeSafe: undefined,
      pidToteMin: undefined,
      unsafePids: undefined,
    };
  });
}

// Applies resolved last-good-location (tracker_history rn=2 destination) to
// every Bad Tracker row that has one - all other rows keep lastGood: "".
function applyLastGood(rows, trackerHistoryRows) {
  const lastGoodByTracker = new Map();
  for (const r of trackerHistoryRows || []) {
    if (Number(r.rn) === 2) lastGoodByTracker.set(String(r.tracker), r.destination || "");
  }
  return rows.map((r) => (r.status === "Bad Tracker" && r.tracker ? { ...r, lastGood: lastGoodByTracker.get(String(r.tracker)) || "" } : r));
}

// Facility-wide SKU -> Set<base tote id> map, built from EVERY Quadron
// inventory row (not just candidates) - needed for the "how many distinct
// totes hold this PID, anywhere" scarcity check.
function buildSkuToTotes(quadronRows) {
  const map = new Map();
  for (const row of quadronRows || []) {
    const skus = new Set((row.partitions || []).map((p) => p.sku).filter(Boolean));
    for (const sku of skus) {
      if (!map.has(sku)) map.set(sku, new Set());
      map.get(sku).add(row.toteId);
    }
  }
  return map;
}

function skusForTote(quadronRows, toteId) {
  const row = (quadronRows || []).find((r) => r.toteId === toteId);
  return row ? [...new Set((row.partitions || []).map((p) => p.sku).filter(Boolean))] : [];
}

// A tote is unsafe to purge if ANY of its PIDs exists in <=2 totes
// facility-wide (scarce inventory) - safe only if every PID's facility-wide
// tote count is > 2. No known SKUs at all -> nothing to say (null/empty).
function computePurgeSafety(skus, skuToTotes) {
  if (!skus.length) return { safe: null, min: null, unsafe: [] };
  const counts = skus.map((sku) => ({ pid: sku, count: (skuToTotes.get(sku) || new Set()).size }));
  const min = Math.min(...counts.map((c) => c.count));
  const unsafe = counts.filter((c) => c.count <= 2).sort((a, b) => a.count - b.count);
  return { safe: min > 2, min, unsafe };
}

// Applies blocked-inventory + purge-safety to every Outside Tote/Bad Tracker
// candidate row, using Quadron's rows (for SKU resolution + facility-wide
// scarcity) and a SKU->blockedInventory map (from GET_NEXS_BLOCKED_INVENTORY_BATCH).
// Non-candidate rows are returned unchanged (their 4 fields stay undefined).
function applyBlockedAndPurgeSafety(rows, quadronRows, blockedBySku) {
  const skuToTotes = buildSkuToTotes(quadronRows);
  return rows.map((r) => {
    if (!isCandidateStatus(r.status)) return r;
    const skus = skusForTote(quadronRows, r.tote);
    if (!skus.length) return { ...r, blocked: null, purgeSafe: null, pidToteMin: null, unsafePids: [] };
    const blockedVals = skus.map((s) => blockedBySku.get(s)).filter((v) => v != null);
    const blocked = blockedVals.length ? blockedVals.reduce((a, b) => a + b, 0) : null;
    const pg = computePurgeSafety(skus, skuToTotes);
    return { ...r, blocked, purgeSafe: pg.safe, pidToteMin: pg.min, unsafePids: pg.unsafe };
  });
}

// ── Auto Mode (discovery via GET_GRAFANA_CONTAINER_TRACKING) ──────────────

// Dedupes and returns the container ids GET_GRAFANA_CONTAINER_TRACKING
// reported as Location='OUT' - Auto Mode's discovery candidate set, before
// any staleness filtering.
function pickOutCandidates(containerRows) {
  const seen = new Set();
  const out = [];
  for (const r of containerRows || []) {
    if (r && r.location === "OUT" && r.container && !seen.has(r.container)) {
      seen.add(r.container);
      out.push(r.container);
    }
  }
  return out;
}

// Keeps only the totes that have a GET_GRAFANA_TOTE_FINDER row with a
// parsable updated_timestamp older than (<=) staleBeforeMs. A tote with no
// finder match or no timestamp is excluded - staleness can't be confirmed,
// so it's never guessed.
//
// BUG FIX (operator-reported, credibility check on Auto Mode): this
// previously compared `new Date(f.updated_timestamp).getTime()` directly
// against staleBeforeMs (a genuine UTC `Date.now() - 12h`). But
// updated_timestamp's raw digits are this facility's own IST wall-clock
// time relayed by Grafana as if they were already UTC (see
// istTimestamp.js) - a plain `new Date(...)` never corrects for that, so
// the comparison was effectively reading every tote's Updated time about
// 5.5h LATER than it really was. Net effect: the documented "stale >12h"
// threshold (AUTO_STALE_MS in trackerEngine.js) was actually enforcing
// something close to 17.5h, silently excluding every tote whose true age
// fell in the 12-17.5h band from Auto Mode's discovered/reclassified set
// on every run. Fixed by routing through parseIstRawDigitsToUtcMs(), the
// same IST->UTC correction shiftWindows.js already applies elsewhere in
// this app.
function filterStaleByFinder(totes, finderRows, staleBeforeMs) {
  const finderByContainer = new Map((finderRows || []).map((r) => [r.container, r]));
  return (totes || []).filter((tote) => {
    const f = finderByContainer.get(tote);
    if (!f || !f.updated_timestamp) return false;
    const ts = parseIstRawDigitsToUtcMs(f.updated_timestamp);
    return ts != null && ts <= staleBeforeMs;
  });
}

// Joins GET_GRAFANA_CONTAINER_TRACKING's own fields (zone/shuttle/health/
// stock-check-blocked/bin-blocked) onto already-classified rows by tote id -
// Auto-Mode-only columns, never present on a Manual Mode row.
function mergeContainerTrackingFields(rows, containerRows) {
  const byContainer = new Map((containerRows || []).map((r) => [r.container, r]));
  return rows.map((r) => {
    const c = byContainer.get(r.tote);
    if (!c) return r;
    return {
      ...r,
      zone: c.zone,
      shuttle: c.shuttle,
      shuttleHealthStatus: c.shuttleHealthStatus,
      stockCheckBlocked: c.stockCheckBlocked,
      binBlocked: c.binBlocked,
    };
  });
}

module.exports = {
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
};
