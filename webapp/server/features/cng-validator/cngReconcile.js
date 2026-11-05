// Pure reconciliation logic for the CNG Inv Validator - three-way tote-
// partition comparison (Quadron vs NexS vs Grafana). Ported from the legacy
// extension's own background/cng-validator.js algorithm, verified against
// its actual code (not its UI copy, which slightly overstates the rule -
// the real algorithm: PARTIAL means 1-or-2-of-3 totals present regardless
// of whether the ones present agree; MISMATCH requires all 3 present and
// disagreeing).
//
// Focus Mode (focusMode: true, threaded through unionPartitionItems() and
// computeRows() below) is the one deliberate exception to "NexS is
// lookup-only, never discovery": it swaps the Quadron+Grafana union for the
// fixed PR1..PR8/PR20 ceiling per tote type, so NexS gets queried for every
// possible partition even when Quadron/Grafana show nothing at all.
//
// No I/O here at all - see cngValidator.js for the async capability
// dispatch/orchestration that feeds this.

const { TOTE_ID_REGEX } = require("../../integrations/quadron/pullQuadronTote");

// "TS0000018492-6" -> {base:"TS0000018492", part:6}, or null if malformed -
// mirrors the legacy extension's own cngSplitTote().
function parseContainer(container) {
  const s = String(container || "");
  const i = s.lastIndexOf("-");
  if (i < 0) return null;
  const base = s.slice(0, i);
  const part = parseInt(s.slice(i + 1), 10);
  if (!TOTE_ID_REGEX.test(base) || Number.isNaN(part)) return null;
  return { base, part };
}

// GET_QUADRON_INVENTORY's rows are {toteId, quadronQty, partitions:[{part,qty,sku}]} -
// already base-keyed, one row per base tote, no parsing needed. Filtered to
// only the bases this run actually asked about (the capability itself
// always returns the FULL live inventory, unfiltered).
function indexQuadronByBase(rows, basesOfInterest) {
  const wanted = new Set(basesOfInterest);
  const map = new Map();
  for (const row of rows || []) {
    if (!row || !wanted.has(row.toteId)) continue;
    const partMap = new Map();
    for (const p of row.partitions || []) {
      partMap.set(p.part, { qty: p.qty, sku: p.sku });
    }
    map.set(row.toteId, partMap);
  }
  return map;
}

// GET_GRAFANA_TOTE_PARTITION_COUNTS's rows are {container, qty} - container
// is "BASE-PART" and must be parsed here.
function indexGrafanaByBase(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const parsed = row && parseContainer(row.container);
    if (!parsed) continue;
    if (!map.has(parsed.base)) map.set(parsed.base, new Map());
    map.get(parsed.base).set(parsed.part, row.qty);
  }
  return map;
}

// GET_NEXS_DISCREPANCY_REPORT_BATCH's results are {base, part, status, imsCount, error} -
// already base+part keyed, no parsing needed. A "failed" item counts as
// absent data (null), not a fabricated zero.
function indexNexsByBase(results) {
  const map = new Map();
  for (const r of results || []) {
    if (!r) continue;
    if (!map.has(r.base)) map.set(r.base, new Map());
    map.get(r.base).set(r.part, r.status === "ok" ? r.imsCount : null);
  }
  return map;
}

// The union of every partition number seen for `base` across Quadron AND
// Grafana (NexS is never used to DISCOVER partitions, only to look up a
// count for ones already known - mirrors the legacy extension exactly).
function unionPartsForBase(base, quadronByBase, grafanaByBase) {
  const parts = new Set();
  for (const p of (quadronByBase.get(base) || new Map()).keys()) parts.add(p);
  for (const p of (grafanaByBase.get(base) || new Map()).keys()) parts.add(p);
  return [...parts].sort((a, b) => a - b);
}

// Focus Mode: the fixed per-tote-type partition ceiling implied by the
// ASRS location-naming scheme itself (NXS1-ASRS-<base>_PR1 .. _PR<n>), NOT
// derived from what Quadron/Grafana happen to report. TL totes top out at
// 8 partitions, TS totes at 20 - keyed by TOTE_ID_REGEX's own 2-char prefix.
// This exists specifically to defeat the normal "NexS is lookup-only, never
// discovery" limitation above: when a tote has genuinely zero rows in both
// Quadron and Grafana right now, the normal union is empty and NexS is
// never even queried - Focus Mode instead sweeps every possible partition
// location directly against NexS regardless of what the other two sources
// show, so real NexS data isn't hidden just because Quadron/Grafana are
// currently blank for that tote.
const FOCUS_MAX_PARTITIONS_BY_PREFIX = { TL: 8, TS: 20 };

function focusPartsForBase(base) {
  const max = FOCUS_MAX_PARTITIONS_BY_PREFIX[String(base || "").slice(0, 2)] || 0;
  return Array.from({ length: max }, (_, i) => i + 1);
}

function partsForBase(base, quadronByBase, grafanaByBase, focusMode) {
  return focusMode ? focusPartsForBase(base) : unionPartsForBase(base, quadronByBase, grafanaByBase);
}

// Every (base, part) pair whose count needs to be looked up in NexS - the
// exact worklist for GET_NEXS_DISCREPANCY_REPORT_BATCH's `items`. In Focus
// Mode this is every possible partition per tote type, not just the ones
// Quadron/Grafana already revealed.
function unionPartitionItems(bases, quadronByBase, grafanaByBase, focusMode = false) {
  const items = [];
  for (const base of bases) {
    for (const part of partsForBase(base, quadronByBase, grafanaByBase, focusMode)) items.push({ base, part });
  }
  return items;
}

// true/false if >=2 of the (up to 3) values are present and can be
// compared; null if fewer than 2 are present (nothing meaningful to say).
function allEqual(vals) {
  const present = vals.filter((v) => v != null);
  if (present.length < 2) return null;
  return present.every((v) => v === present[0]);
}

function sum(vals) {
  const present = vals.filter((v) => v != null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

// MATCH: all 3 totals present and equal. MISMATCH: all 3 present, not all
// equal. PARTIAL: exactly 1 or 2 of the 3 present (regardless of whether the
// ones present agree). MISSING: none present. This is the tote-LEVEL
// verdict, computed from summed totals - NOT derived from per-partition
// `match` flags (those are display-only, for the drill-down matrix).
function verdictOf(vals) {
  const present = vals.filter((v) => v != null);
  if (present.length === 0) return "MISSING";
  if (present.length < 3) return "PARTIAL";
  return present.every((v) => v === present[0]) ? "MATCH" : "MISMATCH";
}

// bases: the ordered tote-base list this run asked about (preserves input
// order in the output, same convention as totePullEngine.js's own totes list).
function computeRows(bases, quadronByBase, grafanaByBase, nexsByBase, focusMode = false) {
  return bases.map((base) => {
    const parts = partsForBase(base, quadronByBase, grafanaByBase, focusMode);
    const partitions = parts.map((part) => {
      const q = quadronByBase.get(base)?.get(part)?.qty ?? null;
      const g = grafanaByBase.get(base)?.get(part) ?? null;
      const n = nexsByBase.get(base)?.get(part) ?? null;
      return { part, quadron: q, nexs: n, grafana: g, match: allEqual([q, n, g]) };
    });

    const quadron = sum(partitions.map((p) => p.quadron));
    const nexs = sum(partitions.map((p) => p.nexs));
    const grafana = sum(partitions.map((p) => p.grafana));

    return { base, quadron, nexs, grafana, verdict: verdictOf([quadron, nexs, grafana]), partitions };
  });
}

module.exports = {
  parseContainer,
  indexQuadronByBase,
  indexGrafanaByBase,
  indexNexsByBase,
  unionPartitionItems,
  computeRows,
  focusPartsForBase,
  FOCUS_MAX_PARTITIONS_BY_PREFIX,
};
