// Locked Tote Analytics - pure: joins the cycle-count trail (reports + GTP stock checks), AOS pulls, purges and the
// latest locked list, and classifies every count. Definitions (operator-confirmed 2026-11-03):
//
//   REPORT     a SHORT discrepancy event on a tote - that locks it and asks for a cycle count
//   CHECK      one GTP stock check of a tote: its lines share the tote and the check time
//   PROPER     a check with a report on that tote in the REPORT_WINDOW before it (and after the tote's previous
//              check, so one report never justifies two counts) - reported -> counted
//   PURGED     a check inside a Manual Puller purge (pulled with Purge on, then Quadron showed it empty) - its own
//              class, never a ghost
//   GHOST      a check with no report before it - the tote was called manually. Split by who called it:
//              AOS Manual Puller, AOS Auto Puller (a pull session with that tote shortly before the count) or
//              outside AOS (Quadron / GTP directly)
//   REPEAT TOTE a check of a tote that was already counted in the REPEAT_WINDOW before it
//   REPEAT SKU  a check of another tote holding a SKU that came up SHORT in a PROPER count (a reported tote) in the
//               REPEAT_WINDOW before it - the reported SKU being counted again elsewhere
// Each repeat keeps its own class (PROPER / GHOST), so it shows whether it was reported or called manually.
//
// Outcome of a check, from its lines: ALL_ALRIGHT (matched the system - a false report / needless call),
// BERMUDA (every line SHORT - contents not found), SHORT (some lines less than system), EXCESS (some lines more),
// SHORT_EXCESS (both). The latest locked list says which counted totes are STILL LOCKED afterwards.

const { istStringToMs } = require("../../platform/domain/stockCheck");

const HOUR = 3600000;
const REPORT_WINDOW_MS = 3 * 24 * HOUR;
const REPEAT_WINDOW_MS = 48 * HOUR;
const PULL_BEFORE_MS = 24 * HOUR; // an AOS pull up to a day before the count explains it
const PULL_AFTER_MS = 15 * 60000; // ... or just after (a session is logged when it finishes)
const PURGE_GRACE_MS = 60 * 1000;
const LIST_MAX = 400;

// site day (06:00 -> 06:00 IST) of an epoch ms
const siteDay = (ms) => new Date(ms + 5.5 * HOUR - 6 * HOUR).toISOString().slice(0, 10);

function outcomeOf(lines) {
  let s = 0, e = 0, a = 0;
  for (const l of lines) { if (l.r === "SHORT") s++; else if (l.r === "EXCESS") e++; else a++; }
  if (s && !e && !a) return "BERMUDA";
  if (s && e) return "SHORT_EXCESS";
  if (s) return "SHORT";
  if (e) return "EXCESS";
  return "ALL_ALRIGHT";
}

// stock lines -> checks, oldest first: { tote, ms, day, station, user, lines, skus, shortQty }
function buildChecks(lines) {
  const by = new Map();
  for (const l of lines) {
    const key = l.c + "|" + l.t;
    let c = by.get(key);
    if (!c) {
      const ms = istStringToMs(l.t);
      if (ms == null) continue;
      c = { tote: l.c, ms, station: l.st, user: l.u, lines: [] };
      by.set(key, c);
    }
    c.lines.push(l);
  }
  const out = [...by.values()];
  for (const c of out) {
    c.day = siteDay(c.ms);
    c.skus = [...new Set(c.lines.map((l) => l.sku).filter(Boolean))];
    c.shortQty = c.lines.filter((l) => l.r === "SHORT").reduce((a, l) => a + l.q, 0);
    c.outcome = outcomeOf(c.lines);
  }
  return out.sort((x, y) => x.ms - y.ms);
}

const groupBy = (arr, key) => { const m = new Map(); for (const x of arr) { const k = x[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const median = (vals) => { if (!vals.length) return null; const v = [...vals].sort((a, b) => a - b); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

// input: { reports, lines, pulls: [{tote, ms, kind, employee, purpose}], purges: {tote: {from, to}},
//          locked: { at: ms|null, totes: Map(tote -> {priority, lockedSinceMs}) }, fromMs, toMs, now }
// reports/lines must reach back REPORT_WINDOW_MS / REPEAT_WINDOW_MS before fromMs so the first days are judged fully.
function analyse({ reports, lines, pulls = [], purges = {}, locked = { at: null, totes: new Map() }, fromMs, toMs, now = Date.now() }) {
  const allChecks = buildChecks(lines);
  const reportsByTote = groupBy([...reports].sort((a, b) => a.ms - b.ms), "c");
  const checksByTote = groupBy(allChecks, "tote");
  const pullsByTote = groupBy(pulls, "tote");

  // classify every check (lookback ones too: a repeat may point at one), keep the ones in range
  for (const c of allChecks) {
    const prior = (checksByTote.get(c.tote) || []).filter((x) => x.ms < c.ms);
    const prevMs = prior.length ? prior[prior.length - 1].ms : -Infinity;
    const rep = (reportsByTote.get(c.tote) || []).filter((r) => r.ms <= c.ms && r.ms >= c.ms - REPORT_WINDOW_MS && r.ms > prevMs).pop();
    const pm = purges[c.tote];
    if (pm && c.ms > pm.from && c.ms <= pm.to + PURGE_GRACE_MS) c.cls = "PURGED";
    else if (rep) { c.cls = "PROPER"; c.report = rep; c.reportToCcMs = c.ms - rep.ms; }
    else {
      c.cls = "GHOST";
      const pull = (pullsByTote.get(c.tote) || []).filter((p) => p.ms >= c.ms - PULL_BEFORE_MS && p.ms <= c.ms + PULL_AFTER_MS).pop();
      c.via = pull ? (pull.kind === "AUTO" ? "AOS_AUTO" : "AOS_MANUAL") : "OUTSIDE";
      if (pull) c.pull = pull;
    }
  }
  // SKUs that came up SHORT in a proper (reported) count: sku -> [{tote, ms}] oldest first
  const reportedSku = new Map();
  for (const c of allChecks) {
    if (c.cls !== "PROPER") continue;
    for (const l of c.lines) if (l.r === "SHORT" && l.sku) { if (!reportedSku.has(l.sku)) reportedSku.set(l.sku, []); reportedSku.get(l.sku).push({ tote: c.tote, ms: c.ms }); }
  }
  for (const c of allChecks) {
    const prev = (checksByTote.get(c.tote) || []).filter((x) => x.ms < c.ms && x.ms >= c.ms - REPEAT_WINDOW_MS).pop();
    if (prev) c.toteRepeat = { ms: prev.ms, cls: prev.cls, outcome: prev.outcome };
    const from = [];
    for (const s of c.skus) {
      for (const o of reportedSku.get(s) || []) {
        if (o.ms >= c.ms) break;
        if (o.tote !== c.tote && o.ms >= c.ms - REPEAT_WINDOW_MS) from.push({ sku: s, tote: o.tote, ms: o.ms });
      }
    }
    if (from.length) c.skuRepeat = from;
    const l = locked.totes.get(c.tote);
    c.stillLocked = !!(l && locked.at != null && locked.at > c.ms && (l.lockedSinceMs == null || l.lockedSinceMs <= c.ms));
    if (l) c.priority = l.priority;
  }
  const checks = allChecks.filter((c) => c.ms >= fromMs && c.ms < toMs);

  // reports in range: answered by a count later, or still waiting
  const inRange = reports.filter((r) => r.ms >= fromMs && r.ms < toMs);
  const pending = [];
  const reported = new Set();
  for (const [tote, rs] of reportsByTote) {
    const last = rs[rs.length - 1];
    if (last.ms < fromMs || last.ms >= toMs) continue;
    reported.add(tote);
    const counted = (checksByTote.get(tote) || []).some((c) => c.ms >= last.ms);
    if (!counted) {
      const l = locked.totes.get(tote);
      pending.push({ tote, reportedMs: last.ms, ageMs: now - last.ms, station: last.st, user: last.u, reports: rs.filter((r) => r.ms >= fromMs).length, locked: !!l, priority: l ? l.priority : null });
    }
  }
  // reported again within the window after a proper count: the count did not fix it
  const reReported = [];
  for (const c of checks.filter((x) => x.cls === "PROPER")) {
    const again = (reportsByTote.get(c.tote) || []).find((r) => r.ms > c.ms && r.ms <= c.ms + REPORT_WINDOW_MS);
    if (again) reReported.push({ tote: c.tote, countedMs: c.ms, outcome: c.outcome, reportedAgainMs: again.ms, station: again.st });
  }

  const count = (f) => checks.filter(f).length;
  const proper = checks.filter((c) => c.cls === "PROPER");
  const ghosts = checks.filter((c) => c.cls === "GHOST");
  const summary = {
    reports: inRange.length,
    reportedTotes: reported.size,
    checks: checks.length,
    proper: proper.length,
    ghost: ghosts.length,
    ghostOutside: count((c) => c.cls === "GHOST" && c.via === "OUTSIDE"),
    ghostAosManual: count((c) => c.cls === "GHOST" && c.via === "AOS_MANUAL"),
    ghostAosAuto: count((c) => c.cls === "GHOST" && c.via === "AOS_AUTO"),
    purged: count((c) => c.cls === "PURGED"),
    repeatTote: count((c) => c.toteRepeat),
    repeatSku: count((c) => c.skuRepeat),
    pending: pending.length,
    stillLocked: count((c) => c.cls === "PROPER" && c.stillLocked),
    reReported: reReported.length,
    falseReports: count((c) => c.cls === "PROPER" && c.outcome === "ALL_ALRIGHT"),
    falseReportPct: pct(count((c) => c.cls === "PROPER" && c.outcome === "ALL_ALRIGHT"), proper.length),
    ghostPct: pct(ghosts.length, checks.length),
    medianReportToCcMin: proper.length ? Math.round(median(proper.map((c) => c.reportToCcMs)) / 60000) : null,
    lockedAt: locked.at,
  };

  // per site day
  const days = new Map();
  const day = (d) => { if (!days.has(d)) days.set(d, { day: d, reports: 0, checks: 0, proper: 0, ghost: 0, purged: 0, repeatTote: 0, repeatSku: 0, falseReports: 0 }); return days.get(d); };
  for (const r of inRange) day(siteDay(r.ms)).reports++;
  for (const c of checks) {
    const d = day(c.day);
    d.checks++;
    d[c.cls === "PROPER" ? "proper" : c.cls === "GHOST" ? "ghost" : "purged"]++;
    if (c.toteRepeat) d.repeatTote++;
    if (c.skuRepeat) d.repeatSku++;
    if (c.cls === "PROPER" && c.outcome === "ALL_ALRIGHT") d.falseReports++;
  }

  // class x outcome
  const OUTCOMES = ["ALL_ALRIGHT", "SHORT", "EXCESS", "SHORT_EXCESS", "BERMUDA"];
  const matrix = {};
  for (const cls of ["PROPER", "GHOST", "PURGED"]) {
    matrix[cls] = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
    for (const c of checks) if (c.cls === cls) matrix[cls][c.outcome]++;
  }

  // reporting stations (how often their reports turn out ALL_ALRIGHT) and GTP stations / users that count ghosts
  const repSt = new Map();
  for (const r of inRange) { const k = r.st || "-"; if (!repSt.has(k)) repSt.set(k, { station: k, reports: 0, counted: 0, falseReports: 0 }); repSt.get(k).reports++; }
  for (const c of proper) { const k = c.report.st || "-"; const s = repSt.get(k); if (!s) continue; s.counted++; if (c.outcome === "ALL_ALRIGHT") s.falseReports++; }
  const reportingStations = [...repSt.values()].map((s) => ({ ...s, falsePct: pct(s.falseReports, s.counted) })).sort((a, b) => b.reports - a.reports);
  const gtp = new Map();
  for (const c of checks) { const k = c.station || "-"; if (!gtp.has(k)) gtp.set(k, { station: k, checks: 0, proper: 0, ghost: 0, ghostOutside: 0, repeatTote: 0, repeatSku: 0 }); const g = gtp.get(k); g.checks++; if (c.cls === "PROPER") g.proper++; if (c.cls === "GHOST") { g.ghost++; if (c.via === "OUTSIDE") g.ghostOutside++; } if (c.toteRepeat) g.repeatTote++; if (c.skuRepeat) g.repeatSku++; }
  const gtpStations = [...gtp.values()].map((g) => ({ ...g, ghostPct: pct(g.ghost, g.checks) })).sort((a, b) => b.ghost - a.ghost);

  const row = (c) => ({ tote: c.tote, ms: c.ms, station: c.station, user: c.user, outcome: c.outcome, shortQty: c.shortQty, lines: c.lines.length, cls: c.cls, via: c.via || null, pulledBy: c.pull ? c.pull.employee : null, reportedMs: c.report ? c.report.ms : null, reportStation: c.report ? c.report.st : null, reportToCcMin: c.reportToCcMs != null ? Math.round(c.reportToCcMs / 60000) : null, stillLocked: c.stillLocked, priority: c.priority || null });
  const newest = (arr) => arr.sort((a, b) => b.ms - a.ms).slice(0, LIST_MAX);
  return {
    summary,
    daily: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
    matrix,
    reportingStations,
    gtpStations,
    lists: {
      ghosts: newest(ghosts.map(row)),
      repeatTotes: newest(checks.filter((c) => c.toteRepeat).map((c) => ({ ...row(c), prevMs: c.toteRepeat.ms, prevCls: c.toteRepeat.cls, prevOutcome: c.toteRepeat.outcome, gapMin: Math.round((c.ms - c.toteRepeat.ms) / 60000) }))),
      repeatSkus: newest(checks.filter((c) => c.skuRepeat).map((c) => ({ ...row(c), skus: [...new Set(c.skuRepeat.map((r) => r.sku))].slice(0, 8), reportedTotes: [...new Set(c.skuRepeat.map((r) => r.tote))].slice(0, 5), firstReportedMs: Math.min(...c.skuRepeat.map((r) => r.ms)) }))),
      pending: pending.sort((a, b) => a.reportedMs - b.reportedMs).slice(0, LIST_MAX),
      stillLocked: newest(proper.filter((c) => c.stillLocked).map(row)),
      reReported: reReported.sort((a, b) => b.reportedAgainMs - a.reportedAgainMs).slice(0, LIST_MAX),
    },
  };
}

module.exports = { analyse, buildChecks, outcomeOf, siteDay, REPORT_WINDOW_MS, REPEAT_WINDOW_MS };
