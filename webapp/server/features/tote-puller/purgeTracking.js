// Purge tracking: decides which totes pulled with the Manual Puller's Purge toggle were REALLY purged.
//
// When the calling of a purge session finishes, every tote gets a Quadron inventory BASELINE (units + PIDs).
// For the next 2 days each pass compares Quadron with the baseline, one inventory read for all pending totes:
//   - tote EMPTY in Quadron            -> PURGED, remembering the moment it was first seen empty (final)
//   - new PIDs / more units, never empty -> RESTOCKED (decanted again; not a purge)
//   - same PIDs, same or fewer units   -> still PENDING (unchanged, or only partly counted down = a normal CC)
//   - nothing decided after 2 days     -> EXPIRED (not a purge)
// The cycle count that belongs to a purge is only the one inside [pull, purged_at]; stockCheck.js applies that
// window, so a later CC on the same tote (re-decanted, called for a discrepancy) stays a normal CC.

const purgeMarks = require("../../platform/storage/purgeMarks");
const { baseToteId } = require("../../platform/domain/classification");

const WINDOW_MS = 2 * 24 * 3600 * 1000;
const FAST_FOR_MS = 6 * 3600 * 1000; // read Quadron every pass for this long after the calling...
const SLOW_EVERY_MS = 30 * 60 * 1000; // ...then only this often while a purge is still being watched

// Quadron inventory rows -> Map(baseTote -> { qty, skus:Set })
function stockOf(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const base = baseToteId(r && r.toteId);
    if (!base) continue;
    const e = m.get(base) || { qty: 0, skus: new Set() };
    e.qty += Number(r.quadronQty) || 0;
    for (const p of r.partitions || []) if (p && p.sku != null && Number(p.qty) > 0) e.skus.add(String(p.sku));
    m.set(base, e);
  }
  return m;
}

// What Quadron shows for a watched tote, against its baseline -> "PURGED" | "RESTOCKED" | "PENDING"
function judge(row, current) {
  const qty = current ? current.qty : 0;
  if (!(qty > 0)) return "PURGED";
  if (row.baselineQty == null || !row.baselineSkus) return "PENDING"; // no baseline to compare with yet
  const known = new Set(row.baselineSkus);
  for (const sku of current.skus) if (!known.has(sku)) return "RESTOCKED"; // a PID that was not there before
  if (qty > row.baselineQty) return "RESTOCKED";
  return "PENDING";
}

// Is a Quadron read worth doing now? Always shortly after calling; later on only every SLOW_EVERY_MS.
function readIsDue(open, lastReadAt, now) {
  if (!open.length) return false;
  if (open.some((r) => now - r.doneAtMs < FAST_FOR_MS)) return true;
  return !lastReadAt || now - lastReadAt >= SLOW_EVERY_MS;
}

let lastReadAt = 0;

// One pass. Everything external is injectable for tests. Returns { watched, purged, restocked, expired }.
async function runPass({ marks = purgeMarks, fetchInventory, now = () => Date.now(), force = false } = {}) {
  const t = now();
  const open = await marks.loadOpen();
  const result = { watched: 0, purged: 0, restocked: 0, expired: 0 };

  const live = [];
  for (const r of open) {
    if (t - r.doneAtMs > WINDOW_MS) { await marks.setStatus(r.id, "EXPIRED"); result.expired += 1; } else live.push(r);
  }
  result.watched = live.length;
  if (!live.length || (!force && !readIsDue(live, lastReadAt, t))) return result;

  const inv = await fetchInventory();
  if (!inv.ok || !inv.rows.length) return result; // a failed or empty read must never mean "no inventory"
  lastReadAt = t;
  const stock = stockOf(inv.rows);

  for (const r of live) {
    const current = stock.get(r.tote);
    if (r.baselineQty == null) {
      // First sight after the calling: this IS the baseline (unless the tote is already empty).
      if (current && current.qty > 0) { await marks.setBaseline(r.id, current.qty, [...current.skus]); continue; }
      await marks.setStatus(r.id, "PURGED");
      result.purged += 1;
      continue;
    }
    const verdict = judge(r, current);
    if (verdict === "PENDING") continue;
    await marks.setStatus(r.id, verdict);
    if (verdict === "PURGED") result.purged += 1; else result.restocked += 1;
  }
  return result;
}

// Called by the engine when a purge session's calling has finished: start watching its totes (baseline now).
async function afterSession(sessionId, { fetchInventory, marks = purgeMarks } = {}) {
  await marks.markSessionDone(sessionId);
  return runPass({ marks, fetchInventory, force: true });
}

module.exports = { runPass, afterSession, judge, stockOf, readIsDue, WINDOW_MS };
