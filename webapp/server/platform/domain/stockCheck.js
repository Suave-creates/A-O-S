// Stock-check (cycle count) classification shared by the Dashboard / One Pager (ccMetrics.js) and
// the Alerts module - one definition of "a tote's latest check", so every screen agrees.
// Definitions: see features/dashboard/ccMetrics.js's header (Bermuda = latest check marked every
// line SHORT; shortQty = units on the SHORT lines of the latest check; allAlright = every line of the
// latest check matched the system (ALRIGHT) - nothing was wrong, so the tote was wrongly reported / called
// unnecessarily. It still counts as CC Done (the operator completed the count) but is flagged).
//
// PURGED: a tote pulled with the Manual Puller's Purge toggle on that Quadron then showed EMPTY (see
// features/tote-puller/purgeTracking.js). purgeMarks is { BASE_TOTE: { from, to } } (epoch ms) for those totes
// only: from = the pull, to = the moment it was first seen empty. Only a latest check INSIDE that window is the
// purge - a later count on the same tote (decanted again, called for a discrepancy) is a normal CC. A purge-mode
// tote that Quadron still shows stock for was a normal cycle count. Purged is taken out of Bermuda and CC Done
// whatever lines the check had.

const { baseToteId } = require("./classification");

const PURGE_GRACE_MS = 60 * 1000; // the count's timestamp can sit a moment after Quadron already showed the tote empty

// stockRows -> Map(baseTote -> { latest, lines, bermuda, station })
function classifyChecks(stockRows, purgeMarks = {}) {
  const byTote = new Map();
  for (const r of stockRows || []) {
    const base = baseToteId(r.container);
    const t = String(r.createTime == null ? "" : r.createTime);
    let e = byTote.get(base);
    if (!e) {
      e = { latest: t, rows: [] };
      byTote.set(base, e);
    }
    if (t > e.latest) { e.latest = t; e.rows = []; }
    if (t === e.latest) e.rows.push(r);
  }
  const out = new Map();
  for (const [base, e] of byTote) {
    const checkMs = istStringToMs(e.latest);
    const pulledAt = purgeMarks && purgeMarks[base];
    const purged = !!pulledAt && checkMs != null && checkMs > pulledAt.from && checkMs <= pulledAt.to + PURGE_GRACE_MS;
    const bermuda = !purged && e.rows.length > 0 && e.rows.every((r) => r.resultType === "SHORT");
    let shortQty = 0;
    let shortLines = 0;
    for (const r of e.rows) if (r.resultType === "SHORT") { shortQty += Number(r.quantity) || 0; shortLines += 1; }
    const allAlright = e.rows.length > 0 && e.rows.every((r) => r.resultType === "ALRIGHT");
    out.set(base, { latest: e.latest, lines: e.rows.length, bermuda, purged, allAlright, shortQty, shortLines, station: (e.rows[0] && e.rows[0].station) || null });
  }
  return out;
}

// "2026-10-13 13:59:22.157" is an IST wall-clock string (stock-check rows) -> epoch ms; null if unreadable.
function istStringToMs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || ""));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 5.5 * 3600000;
}

// A GTP row's createTime -> epoch ms. The GTP database keeps IST wall-clock time: a stock-check line carries it as
// IST text, a verification (discrepancy) event as a number that Grafana built by reading that IST time as UTC -
// 5h30m ahead of the real moment.
function rowMs(createTime) {
  if (typeof createTime === "number" && Number.isFinite(createTime)) return createTime - 5.5 * 3600000;
  return istStringToMs(createTime);
}

module.exports = { classifyChecks, istStringToMs, rowMs };
