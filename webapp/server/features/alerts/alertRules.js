// Alert rules - pure functions over today's stock-check (cycle count) rows. No I/O: the engine feeds
// them rows and persists what they return, so every rule is unit-testable.
//
// Every rule returns events:
//   { ruleKey, level: "GLOBAL"|"NORMAL", dedupeKey, title, detail, eventAt (ISO) }
// `dedupeKey` identifies the real-world event, so evaluating the same data again never raises it twice.
//
// GLOBAL rules (high escalation - shown to every user in the sidebar until acknowledged):
//   G1_TOTE_SHORT_QTY       a tote with MORE than N units marked short (its latest check)      N = 25
//   G2_STATION_SHORT_TOTES  a discrepancy-marking station that marked MORE than M totes short in one    M = 8
//                           clock hour (SHORT verification events; NOT the cycle-count stations)
// NORMAL rules (Alerts page only) will be added next to these.
//
// Only events inside the lookback window are raised, so reopening the app after a long gap doesn't
// flood the sidebar with old events.

const { classifyChecks, istStringToMs, rowMs } = require("../../platform/domain/stockCheck");
const { baseToteId } = require("../../platform/domain/classification");

const IST_OFFSET_MS = 5.5 * 3600000;
const HOUR_MS = 3600000;

const RULES = {
  // threshold = the editable limit ("more than N"); describe() is the sentence shown on the Alerts page.
  // metric = the detail field holding the figure compared with the limit (stored in its own column for analytics).
  G1_TOTE_SHORT_QTY: { level: "GLOBAL", label: "Tote with high quantity marked short", unit: "units", metric: "shortQty", describe: (n) => `A tote whose latest cycle check marked more than ${n} units short.` },
  G2_STATION_SHORT_TOTES: { level: "GLOBAL", label: "Discrepancy station marking many totes short in an hour", unit: "totes", metric: "count", describe: (n) => `A discrepancy-marking station that marked more than ${n} totes short (SHORT verification events) within one clock hour. Cycle-count stations are not counted.` },
};

const istClock = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 16);
const hourStart = (ms) => Math.floor((ms + IST_OFFSET_MS) / HOUR_MS) * HOUR_MS - IST_OFFSET_MS;
const hourLabel = (startMs) => `${istClock(startMs)}-${istClock(startMs + HOUR_MS)}`;

// G1 - a tote whose latest check marked more than `threshold` units short.
// A tote pulled for PURGE is marked short on purpose, so it never raises this alert.
function toteShortQtyEvents(stockRows, { threshold, sinceMs, purgeMarks = {} }) {
  const events = [];
  for (const [tote, c] of classifyChecks(stockRows, purgeMarks)) {
    if (c.purged || !(c.shortQty > threshold)) continue;
    const at = istStringToMs(c.latest);
    if (at == null || at < sinceMs) continue;
    events.push({
      ruleKey: "G1_TOTE_SHORT_QTY",
      level: "GLOBAL",
      dedupeKey: `G1_TOTE_SHORT_QTY:${tote}:${c.latest}`,
      title: `Tote ${tote}: ${c.shortQty} units marked short`,
      detail: { tote, station: c.station, shortQty: c.shortQty, lines: c.lines, checkedAt: istClock(at) + " IST", threshold },
      eventAt: new Date(at).toISOString(),
    });
  }
  return events;
}

// G2 - per DISCREPANCY-MARKING station (the station that marked the SHORT in a verification event - not the
// cycle-count station), per clock hour: distinct totes it marked short.
function stationShortTotesEvents(discRows, { threshold, sinceMs }) {
  const groups = new Map(); // `${station}|${hourStartMs}` -> Map(tote -> { at, user })
  for (const r of discRows || []) {
    if (r.discrepancyType !== "SHORT" || !r.station || !r.container) continue;
    const at = rowMs(r.createTime); // a number (IST read as UTC) from Grafana, or IST text
    if (at == null) continue;
    const h = hourStart(at);
    const key = `${r.station}|${h}`;
    if (!groups.has(key)) groups.set(key, { station: r.station, h, totes: new Map() });
    const tote = baseToteId(r.container);
    const g = groups.get(key).totes;
    if (!g.has(tote) || at < g.get(tote).at) g.set(tote, { at, user: r.user || null });
  }
  const events = [];
  for (const { station, h, totes } of groups.values()) {
    if (!(totes.size > threshold)) continue;
    const list = [...totes].map(([tote, v]) => ({ tote, ...v })).sort((x, y) => x.at - y.at);
    const crossedAt = list[threshold].at; // the mark that took it past the threshold
    if (crossedAt < sinceMs) continue;
    events.push({
      ruleKey: "G2_STATION_SHORT_TOTES",
      level: "GLOBAL",
      dedupeKey: `G2_STATION_SHORT_TOTES:${station}:${h}`,
      title: `Station ${station}: ${list.length} totes marked short in ${hourLabel(h)}`,
      detail: { station, hour: hourLabel(h), count: list.length, threshold, totes: list.map((t) => t.tote), users: [...new Set(list.map((t) => t.user).filter(Boolean))] },
      eventAt: new Date(crossedAt).toISOString(),
    });
  }
  return events;
}

// All rules for one evaluation. `now` is passed in (no clock reads here).
function evaluateRules(stockRows, { discRows = [], purgeMarks = {}, now, toteShortQty, stationHourTotes, lookbackHours, enabled = {}, notBeforeMs = 0 }) {
  const sinceMs = Math.max(now - lookbackHours * HOUR_MS, notBeforeMs); // nothing before the alerts start time
  const on = (key) => enabled[key] !== false;
  return [
    ...(on("G1_TOTE_SHORT_QTY") ? toteShortQtyEvents(stockRows, { threshold: toteShortQty, sinceMs, purgeMarks }) : []),
    ...(on("G2_STATION_SHORT_TOTES") ? stationShortTotesEvents(discRows, { threshold: stationHourTotes, sinceMs }) : []),
  ];
}

module.exports = { RULES, evaluateRules, toteShortQtyEvents, stationShortTotesEvents, hourStart, hourLabel };
