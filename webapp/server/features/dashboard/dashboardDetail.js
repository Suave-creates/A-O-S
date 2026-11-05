// Pure builders for the Dashboard's detail popups ("click a tile -> everything
// since 06:00 IST, hour by hour"). No I/O here: the live layer
// (server/live/dashboardFeeds.js) fetches the data and these shape it, so each
// popup is unit-testable. The numbers in a popup always agree with its tile -
// shift totals come from the same shift-level sections the tile uses.

const { baseToteId } = require("../../platform/domain/classification");
const { ccMetricsFor, classifyChecks } = require("./ccMetrics");

// A station counts as "running now" when it logged a stock check this recently.
const RUNNING_WINDOW_MS = 10 * 60 * 1000;

const IST_OFFSET_MS = 5.5 * 3600000;

// Two timestamp shapes come back from Grafana, and BOTH are IST wall-clock:
//   - stock-check rows: a string "2026-10-13 13:59:22.157"
//   - discrepancy rows: a number whose UTC clock reads the IST time (the SQL does
//     "AT TIME ZONE 'India Standard Time'"), i.e. 11:30 IST arrives as 11:30 "UTC".
// Verified against live data: bucketing discrepancies this way sums to exactly the
// shift totals the tiles show. Both are converted to a true epoch here.
function istStringToMs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || ""));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - IST_OFFSET_MS;
}
const { rowMs } = require("../../platform/domain/stockCheck"); // the shared reader of a GTP row's create_time
function hourIndexFor(hours, ms) {
  if (ms == null) return -1;
  return hours.findIndex((h) => ms >= h.from && ms < h.to);
}
const istClock = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 19);

// Cycle-count data (the CC capability's rows for all three shifts) -> per-hour
// series for CC Done / Stations running / Discrepancies, plus the station
// table and the latest discrepancies. Same definitions as the tiles
// (ccMetrics.js): CC Done = distinct BASE totes; discrepancies = SHORT events.
function ccHourly(windowRows, hours, now = Date.now(), purgeMarks = {}) {
  const stock = [];
  const disc = [];
  for (const k of ["A", "B", "C"]) {
    const w = (windowRows && windowRows[k]) || {};
    for (const r of w.stockRows || []) stock.push(r);
    for (const r of w.discRows || []) disc.push(r);
  }
  const hourRows = hours.map(() => []); // stock rows per hour (for the per-hour CC Done / Bermuda split)
  const stationSets = hours.map(() => new Set());
  const runningNow = new Set();
  const ranToday = new Set(); // distinct stations that logged a stock check at any point today
  const discCounts = hours.map(() => 0);
  const stations = new Map();
  const touch = (name) => {
    if (!stations.has(name)) stations.set(name, { station: name, totes: new Set(), checks: 0, discrepancies: 0, users: new Set(), lastMs: 0 });
    return stations.get(name);
  };

  for (const r of stock) {
    const ms = rowMs(r.createTime);
    const i = hourIndexFor(hours, ms);
    if (i >= 0) {
      hourRows[i].push(r);
      if (r.station) stationSets[i].add(r.station);
    }
    if (r.station) ranToday.add(r.station);
    if (r.station && ms != null && ms >= now - RUNNING_WINDOW_MS && ms <= now + 60000) runningNow.add(r.station);
    if (r.station) {
      const s = touch(r.station);
      s.totes.add(baseToteId(r.container));
      s.checks += 1;
      if (r.user) s.users.add(r.user);
      if (ms != null && ms > s.lastMs) s.lastMs = ms;
    }
  }
  const discrepancyRows = [];
  for (const r of disc) {
    if (r.discrepancyType !== "SHORT") continue;
    const ms = rowMs(r.createTime);
    const i = hourIndexFor(hours, ms);
    if (i >= 0) discCounts[i] += 1;
    if (r.station) {
      const s = touch(r.station);
      s.discrepancies += 1;
      if (r.user) s.users.add(r.user);
      if (ms != null && ms > s.lastMs) s.lastMs = ms;
    }
    discrepancyRows.push({ ms, time: ms != null ? istClock(ms) : "-", station: r.station || "-", user: r.user || "-", container: r.container || "-", event: r.eventType || "-" });
  }
  discrepancyRows.sort((a, b) => (b.ms || 0) - (a.ms || 0));

  // Each tote judged by its latest check across the day; units marked short per station come from those.
  const dayChecks = classifyChecks(stock, purgeMarks);
  const stationShort = new Map();
  for (const c of dayChecks.values()) if (c.station) stationShort.set(c.station, (stationShort.get(c.station) || 0) + c.shortQty);

  const stationRows = [...stations.values()]
    .map((s) => ({ station: s.station, totes: s.totes.size, checks: s.checks, discrepancies: s.discrepancies, users: s.users.size, last: s.lastMs ? istClock(s.lastMs) : "-", running: runningNow.has(s.station), shortQty: stationShort.get(s.station) || 0 }))
    .sort((a, b) => b.totes - a.totes || a.station.localeCompare(b.station));

  // True CC Done vs Bermuda per hour (each tote judged by its latest check in that hour).
  const perHour = hourRows.map((rs) => {
    const checks = classifyChecks(rs, purgeMarks);
    let bermuda = 0;
    let purged = 0;
    let shortQty = 0;
    for (const c of checks.values()) {
      if (c.purged) { purged += 1; continue; }
      shortQty += c.shortQty;
      if (c.bermuda) bermuda += 1;
    }
    return { done: checks.size - bermuda - purged, bermuda, purged, shortQty };
  });

  // Totes checked in MORE THAN ONE shift are counted in each shift (the day totals are the sum of the
  // shifts), so they are flagged: how each shift classified the tote, and how many are affected.
  const perShift = {};
  for (const k of ["A", "B", "C"]) perShift[k] = classifyChecks((windowRows && windowRows[k] && windowRows[k].stockRows) || [], purgeMarks);
  const multiRows = [];
  let bermudaInMultiple = 0;
  const shiftOf = new Map(); // tote -> [{shift, bermuda}]
  for (const k of ["A", "B", "C"]) for (const [tote, c] of perShift[k]) {
    if (!shiftOf.has(tote)) shiftOf.set(tote, []);
    shiftOf.get(tote).push({ shift: k, bermuda: c.bermuda, purged: c.purged });
  }
  for (const [tote, list] of shiftOf) {
    if (list.length < 2) continue;
    const label = (k) => { const x = list.find((e) => e.shift === k); return x ? (x.purged ? "Purged" : x.bermuda ? "Bermuda" : "CC Done") : "-"; };
    if (list.filter((e) => e.bermuda).length >= 2) bermudaInMultiple += 1;
    multiRows.push({ tote, A: label("A"), B: label("B"), C: label("C") });
  }
  multiRows.sort((a, b) => a.tote.localeCompare(b.tote));

  // The day's Bermuda totes (latest check of each tote), newest first.
  const bermudaRows = [];
  const doneRows = []; // proper CC Done totes (latest check), newest first - the counterpart of the Bermuda list
  const purgedRows = []; // totes pulled for PURGE and then marked whole-short
  for (const [tote, c] of dayChecks) {
    if (c.purged) {
      const ms = istStringToMs(c.latest);
      purgedRows.push({ ms, tote, station: c.station || "-", time: ms != null ? istClock(ms) : "-", lines: c.lines, shortQty: c.shortQty });
      continue;
    }
    if (!c.bermuda) {
      const ms = istStringToMs(c.latest);
      const seen = (shiftOf.get(tote) || []).map((e) => e.shift).join("+") || "-";
      doneRows.push({ ms, tote, station: c.station || "-", time: ms != null ? istClock(ms) : "-", lines: c.lines, shortQty: c.shortQty, shifts: seen, multi: seen.includes("+") ? "⚑ " + seen : seen, flag: c.allAlright ? "⚠ Wrong report" : "" });
      continue;
    }
    const ms = istStringToMs(c.latest);
    const seen = (shiftOf.get(tote) || []).map((e) => e.shift).join("+") || "-";
    bermudaRows.push({ ms, tote, station: c.station || "-", time: ms != null ? istClock(ms) : "-", lines: c.lines, shortQty: c.shortQty, shifts: seen, multi: seen.includes("+") ? "⚑ " + seen : seen });
  }
  bermudaRows.sort((a, b) => (b.ms || 0) - (a.ms || 0));
  doneRows.sort((a, b) => (b.ms || 0) - (a.ms || 0));
  purgedRows.sort((a, b) => (b.ms || 0) - (a.ms || 0));


  return {
    ccDone: perHour.map((h) => h.done),
    bermuda: perHour.map((h) => h.bermuda),
    shortQty: perHour.map((h) => h.shortQty),
    bermudaRows: bermudaRows.slice(0, 300).map(({ ms, ...rest }) => rest),
    bermudaTotal: bermudaRows.length,
    purged: perHour.map((h) => h.purged),
    purgedRows: purgedRows.slice(0, 1500).map(({ ms, ...rest }) => rest),
    purgedTotal: purgedRows.length,
    purgedShortQty: purgedRows.reduce((s, r) => s + r.shortQty, 0),
    doneRows: doneRows.slice(0, 1500).map(({ ms, ...rest }) => rest),
    doneTotal: doneRows.length,
    wrongReports: doneRows.filter((r) => r.flag).length, // CC Done totes whose every line matched the system
    multiShift: { total: multiRows.length, bermudaInMultiple, rows: multiRows.slice(0, 200), distinctChecked: dayChecks.size },
    stationsRunningNow: runningNow.size,
    stationsRanToday: ranToday.size,
    stations: stationSets.map((s) => s.size),
    discrepancies: discCounts,
    stationRows,
    discrepancyRows: discrepancyRows.slice(0, 60).map(({ ms, ...rest }) => rest),
    totals: ccMetricsFor(disc, stock, purgeMarks),
  };
}

// Hourly series + the headline facts every hourly popup shows.
// hours: dayHours() entries; values: one number|null per hour.
// lastEvent: ms of the source table's newest row (IST wall-clock labelled UTC) or null.
function lastEventInfo(lastEvent) {
  if (typeof lastEvent !== "number" || !Number.isFinite(lastEvent)) return null;
  const iso = new Date(lastEvent).toISOString(); // the UTC clock reads the IST time
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

// Locked Totes is a LEVEL (how many are locked right now), not a count of events, so an hour's value is the
// last snapshot taken inside it (the current hour: the latest). Hours with no snapshot stay null - never guessed.
// snapshots: [{ createdAt, summary: { total, p0Count, p1Count, p2Count, sdCount } }] oldest first.
function lockedHourly(snapshots, hours, metric, title, generatedAt) {
  const snaps = (snapshots || []).map((s) => ({ ms: Date.parse(s.createdAt), summary: s.summary })).filter((s) => Number.isFinite(s.ms)).sort((a, b) => a.ms - b.ms);
  const rows = hours.map((h) => {
    const inHour = snaps.filter((s) => s.ms >= h.from && s.ms < h.to);
    const last = inHour[inHour.length - 1];
    const sm = last ? last.summary : null;
    return {
      shift: h.shift, label: h.label, status: h.status, snapshots: inHour.length,
      value: h.status === "future" || !sm ? null : sm.total,
      p0: sm ? sm.p0Count : null, p1: sm ? sm.p1Count : null, p2: sm ? sm.p2Count : null, sd: sm ? sm.sdCount : null,
      at: last ? istClock(last.ms).slice(0, 5) : null,
    };
  });
  const withValue = rows.filter((r) => r.value != null);
  const first = snaps[0] || null;
  const latest = snaps[snaps.length - 1] || null;
  const pick = (cmp) => withValue.reduce((best, r) => (best == null || cmp(r.value, best.value) ? r : best), null);
  const peak = pick((a, b) => a > b);
  const low = pick((a, b) => a < b);
  return {
    kind: "locked", metric, title, unit: "locked totes", siteDay: null, since: "06:00 IST", generatedAt,
    hours: rows,
    now: latest ? { total: latest.summary.total, at: istClock(latest.ms).slice(0, 5), p0: latest.summary.p0Count, p1: latest.summary.p1Count, p2: latest.summary.p2Count, sd: latest.summary.sdCount } : null,
    start: first ? { total: first.summary.total, at: istClock(first.ms).slice(0, 5) } : null,
    change: first && latest ? latest.summary.total - first.summary.total : null,
    peak: peak ? { label: peak.label, value: peak.value } : null,
    low: low ? { label: low.label, value: low.value } : null,
    snapshotCount: snaps.length,
  };
}

function hourlyEnvelope({ metric, title, unit, siteDay, hours, values, shifts, sections = [], generatedAt, lastEvent, extras = {} }) {
  const rows = hours.map((h, i) => ({ shift: h.shift, label: h.label, status: h.status, value: h.status === "future" ? null : values[i] == null ? null : values[i] }));
  const closedOrCurrent = rows.filter((r) => r.value != null);
  const peak = closedOrCurrent.reduce((best, r) => (best == null || r.value > best.value ? r : best), null);
  const current = rows.find((r) => r.status === "current") || null;
  const sum = closedOrCurrent.reduce((s, r) => s + r.value, 0);
  return {
    kind: "hourly",
    metric, title, unit, siteDay, since: "06:00 IST", generatedAt,
    shifts, hours: rows,
    peak: peak ? { label: peak.label, value: peak.value } : null,
    current: current ? { label: current.label, value: current.value } : null,
    perHour: closedOrCurrent.length ? Math.round((sum / closedOrCurrent.length) * 10) / 10 : null,
    sections,
    lastEvent: lastEventInfo(lastEvent),
    ...extras, // metric-specific blocks (e.g. CC Done: bermuda, stations)
  };
}

// ── Aisle detail from the ASRS Location Audit model ────────────────────────
// model = asrsLocationModel.buildOccupancyModel() output (occupiedSlots with
// aisle/level/side/depth/zone/shuttle...). Slots per level = 226 positions x
// 2 depths. Returns small summaries only - never the ~56k slot list.
const SLOTS_PER_LEVEL = 226 * 2;

function aisleAuditSummary(model, levelsForAisle) {
  const byAisle = new Map();
  for (const s of (model && model.occupiedSlots) || []) {
    if (!byAisle.has(s.aisle)) byAisle.set(s.aisle, { levels: new Map(), left: 0, right: 0, front: 0, back: 0, zones: new Map(), health: new Map(), occupied: 0 });
    const a = byAisle.get(s.aisle);
    a.occupied += 1;
    a.levels.set(s.level, (a.levels.get(s.level) || 0) + 1);
    if (s.side === "left") a.left += 1; else a.right += 1;
    if (s.depth === "front") a.front += 1; else a.back += 1;
    const zone = s.zone || "-";
    a.zones.set(zone, (a.zones.get(zone) || 0) + 1);
    const h = s.shuttleHealthStatus || "-";
    a.health.set(h, (a.health.get(h) || 0) + 1);
  }
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const aisles = [];
  for (let aisle = 1; aisle <= 6; aisle++) {
    const levelsCount = levelsForAisle(aisle);
    const total = levelsCount * SLOTS_PER_LEVEL;
    const a = byAisle.get(aisle) || { levels: new Map(), left: 0, right: 0, front: 0, back: 0, zones: new Map(), health: new Map(), occupied: 0 };
    const levels = [];
    for (let level = 1; level <= levelsCount; level++) {
      const occ = a.levels.get(level) || 0;
      levels.push({ level, occupied: occ, total: SLOTS_PER_LEVEL, pct: pct(occ, SLOTS_PER_LEVEL) });
    }
    const half = total / 2;
    aisles.push({
      aisle, total, occupied: a.occupied, empty: total - a.occupied, pct: pct(a.occupied, total),
      levels,
      sides: { left: { occupied: a.left, pct: pct(a.left, half) }, right: { occupied: a.right, pct: pct(a.right, half) } },
      depths: { front: { occupied: a.front, pct: pct(a.front, half) }, back: { occupied: a.back, pct: pct(a.back, half) } },
      zones: [...a.zones.entries()].map(([zone, n]) => ({ zone, occupied: n })).sort((x, y) => y.occupied - x.occupied).slice(0, 8),
      shuttleHealth: [...a.health.entries()].map(([status, n]) => ({ status, occupied: n })).sort((x, y) => y.occupied - x.occupied),
    });
  }
  const total = aisles.reduce((s, a) => s + a.total, 0);
  const occupied = aisles.reduce((s, a) => s + a.occupied, 0);
  return {
    aisles,
    overall: { total, occupied, empty: total - occupied, pct: pct(occupied, total) },
    anomalies: { duplicateSlots: ((model && model.duplicateSlots) || []).length, unparsedLocations: ((model && model.unparsedLocations) || []).length },
  };
}

// ── Utilisation / Totes in ASRS tiles: the latest run by size (its detail is the Tote Utilisation screen) ──
function utilisationEnvelope({ metric, title, siteDay, latest, generatedAt }) {
  if (!latest) return { kind: "state", metric, title, siteDay, since: "06:00 IST", generatedAt, empty: true };
  const stats = latest.stats || {};
  const cats = [
    { key: "largeLens", label: "Large - Lens" },
    { key: "largeFrame", label: "Large - Frame" },
    { key: "smallLens", label: "Small - Lens" },
    { key: "smallFrame", label: "Small - Frame" },
  ].map((c) => {
    const s = stats[c.key] || {};
    const cap = Number(s.cap) || 0, qty = Number(s.qty) || 0;
    return { ...c, totes: Number(s.totes) || 0, qty, cap, util: cap > 0 ? qty / cap : null };
  });
  const sum = (keys, f) => keys.reduce((n, k) => n + (cats.find((c) => c.key === k)[f] || 0), 0);
  const group = (keys) => {
    const cap = sum(keys, "cap"), qty = sum(keys, "qty");
    return { totes: sum(keys, "totes"), qty, cap, util: cap > 0 ? qty / cap : null };
  };
  return {
    kind: "state", metric, title, siteDay, since: "06:00 IST", generatedAt,
    runAt: latest.createdAt || null, caps: latest.caps || null,
    categories: cats,
    large: group(["largeLens", "largeFrame"]),
    small: group(["smallLens", "smallFrame"]),
    total: { totes: Number(latest.totals && latest.totals.totes) || 0, qty: Number(latest.totals && latest.totals.qty) || 0, cap: Number(latest.totals && latest.totals.cap) || 0, util: latest.totals ? latest.totals.util : null },
  };
}

module.exports = { RUNNING_WINDOW_MS, lastEventInfo, ccHourly, hourlyEnvelope, lockedHourly, aisleAuditSummary, utilisationEnvelope, istStringToMs, rowMs, hourIndexFor, SLOTS_PER_LEVEL };
