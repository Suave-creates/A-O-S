// Pure rule tests: no DB, no clock, no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateRules, toteShortQtyEvents, stationShortTotesEvents } = require("../../../features/alerts/alertRules");

const NOW = Date.UTC(2026, 9, 13, 9, 30); // 15:00 IST on 2026-10-13
const at = (h, mi = 0, s = 0) => `2026-10-13 ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")}.000`;
const row = (container, station, resultType, quantity, createTime) => ({ container, station, resultType, quantity, createTime });
const OPTS = { now: NOW, toteShortQty: 25, stationHourTotes: 8, lookbackHours: 4 };

// ── G1: tote with more than 25 units marked short ──────────────────────────

test("G1: a tote with MORE than 25 units short raises a GLOBAL alert; exactly 25 does not", () => {
  const rows = [
    row("TL0000000001", "GS1", "SHORT", 20, at(14, 0)), row("TL0000000001", "GS1", "SHORT", 6, at(14, 0)), // 26 -> alert
    row("TL0000000002", "GS1", "SHORT", 25, at(14, 5)), // exactly 25 -> no
    row("TL0000000003", "GS1", "ALRIGHT", 90, at(14, 6)), // plenty of units but none short -> no
  ];
  const ev = toteShortQtyEvents(rows, { threshold: 25, sinceMs: 0 });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].ruleKey, "G1_TOTE_SHORT_QTY");
  assert.equal(ev[0].level, "GLOBAL");
  assert.match(ev[0].title, /TL0000000001.*26 units marked short/);
  assert.equal(ev[0].detail.shortQty, 26);
  assert.equal(ev[0].detail.station, "GS1");
});

test("G1: only SHORT units count (EXCESS / ALRIGHT quantities on the same tote are ignored)", () => {
  const rows = [row("TL0000000001", "GS1", "SHORT", 10, at(14, 0)), row("TL0000000001", "GS1", "EXCESS", 30, at(14, 0)), row("TL0000000001", "GS1", "ALRIGHT", 40, at(14, 0))];
  assert.equal(toteShortQtyEvents(rows, { threshold: 25, sinceMs: 0 }).length, 0);
});

test("G1: judged by the tote's LATEST check - a later clean re-count does not hide the earlier event, but the event key is per check", () => {
  const rows = [row("TL0000000001", "GS1", "SHORT", 30, at(14, 0)), row("TL0000000001", "GS1", "ALRIGHT", 0, at(15, 0))];
  // latest check is clean -> no alert from this evaluation (the 14:00 alert, if it was already raised, stays in the store)
  assert.equal(toteShortQtyEvents(rows, { threshold: 25, sinceMs: 0 }).length, 0);
  const again = toteShortQtyEvents([row("TL0000000001", "GS1", "SHORT", 30, at(14, 0)), row("TL0000000001", "GS1", "SHORT", 40, at(15, 30))], { threshold: 25, sinceMs: 0 });
  assert.equal(again.length, 1);
  assert.match(again[0].dedupeKey, /15:30:00/, "a new bad check is a new event");
});

test("G1: the dedupe key is stable, so evaluating the same data twice raises one event", () => {
  const rows = [row("TL0000000001", "GS1", "SHORT", 30, at(14, 0))];
  const a = toteShortQtyEvents(rows, { threshold: 25, sinceMs: 0 })[0].dedupeKey;
  const b = toteShortQtyEvents(rows, { threshold: 25, sinceMs: 0 })[0].dedupeKey;
  assert.equal(a, b);
});

test("G1: partition suffixes are one tote", () => {
  const rows = [row("TL0000000001-1", "GS1", "SHORT", 14, at(14, 0)), row("TL0000000001-2", "GS1", "SHORT", 14, at(14, 0))];
  assert.equal(toteShortQtyEvents(rows, { threshold: 25, sinceMs: 0 }).length, 1);
});

// ── G2: discrepancy station marking more than 8 totes short in a clock hour ─

const disc = (container, station, createTime, type = "SHORT", user = "U1") => ({ container, station, user, discrepancyType: type, createTime });
function marks(station, n, h, startAt = 0) {
  return Array.from({ length: n }, (_, i) => disc("TL" + String(startAt + i + 1).padStart(10, "0"), station, at(h, 1 + i)));
}

test("G2: MORE than 8 totes marked short by one discrepancy station in a clock hour raises a GLOBAL alert; exactly 8 does not", () => {
  const nine = stationShortTotesEvents(marks("GS7", 9, 14), { threshold: 8, sinceMs: 0 });
  assert.equal(nine.length, 1);
  assert.equal(nine[0].ruleKey, "G2_STATION_SHORT_TOTES");
  assert.equal(nine[0].level, "GLOBAL");
  assert.equal(nine[0].detail.count, 9);
  assert.equal(nine[0].detail.station, "GS7");
  assert.equal(nine[0].detail.hour, "14:00-15:00");
  assert.deepEqual(nine[0].detail.users, ["U1"]);
  assert.match(nine[0].title, /Station GS7: 9 totes marked short in 14:00-15:00/);
  assert.equal(stationShortTotesEvents(marks("GS7", 8, 14), { threshold: 8, sinceMs: 0 }).length, 0);
});

test("G2: a discrepancy time as Grafana sends it (a number: IST wall clock read as UTC) is understood, in the right hour", () => {
  // 14:01..14:09 IST arrive as Date.UTC(..., 14, mi) - not as text
  const rows = Array.from({ length: 9 }, (_, i) => disc("TL" + String(i + 1).padStart(10, "0"), "GS7", Date.UTC(2026, 9, 13, 14, 1 + i)));
  const ev = stationShortTotesEvents(rows, { threshold: 8, sinceMs: 0 });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detail.hour, "14:00-15:00");
});

test("G2: counted per discrepancy station and per clock hour - totes spread over stations or hours don't add up", () => {
  const rows = [...marks("GS1", 5, 14), ...marks("GS2", 5, 14, 100), ...marks("GS1", 5, 15, 200)];
  assert.equal(stationShortTotesEvents(rows, { threshold: 8, sinceMs: 0 }).length, 0);
});

test("G2: only SHORT discrepancy events count (other discrepancy types are ignored)", () => {
  const rows = [...marks("GS1", 6, 14), ...Array.from({ length: 6 }, (_, i) => disc("TS00000000" + String(i).padStart(2, "0"), "GS1", at(14, 30 + i), "EXCESS"))];
  assert.equal(stationShortTotesEvents(rows, { threshold: 8, sinceMs: 0 }).length, 0);
});

test("G2: the same tote marked short twice in the hour is one tote; partition suffixes are one tote", () => {
  const rows = [...marks("GS1", 8, 14), disc("TL0000000001", "GS1", at(14, 50)), disc("TL0000000002-1", "GS1", at(14, 51))];
  assert.equal(stationShortTotesEvents(rows, { threshold: 8, sinceMs: 0 }).length, 0);
});

test("G2: the event time is when the 9th tote was marked, and the dedupe key is per station+hour", () => {
  const ev = stationShortTotesEvents(marks("GS7", 12, 14), { threshold: 8, sinceMs: 0 })[0];
  assert.equal(new Date(ev.eventAt).getTime(), Date.UTC(2026, 9, 13, 8, 39), "the 9th tote at 14:09 IST (08:39Z)");
  assert.match(ev.dedupeKey, /^G2_STATION_SHORT_TOTES:GS7:[0-9]+$/);
  const later = stationShortTotesEvents(marks("GS7", 15, 14), { threshold: 8, sinceMs: 0 })[0];
  assert.equal(later.dedupeKey, ev.dedupeKey, "the same hour is the same event even as the count grows");
  assert.equal(later.detail.count, 15);
});

test("G2 ignores the cycle-count stations: SHORT stock-check lines alone never raise it", () => {
  const stock = Array.from({ length: 12 }, (_, i) => row("TL" + String(i + 1).padStart(10, "0"), "CC1", "SHORT", 1, at(14, 1 + i)));
  assert.equal(evaluateRules(stock, { ...OPTS, discRows: [] }).length, 0);
});

// ── lookback and the combined evaluator ─────────────────────────────────────

test("lookback: events older than the window are not raised (reopening the app doesn't flood the sidebar)", () => {
  const old = [row("TL0000000001", "GS1", "SHORT", 40, at(9, 0))]; // 09:00 IST, 6 hours before 15:00
  assert.equal(evaluateRules(old, OPTS).length, 0);
  const recent = [row("TL0000000001", "GS1", "SHORT", 40, at(13, 0))];
  assert.equal(evaluateRules(recent, OPTS).length, 1);
});

test("evaluateRules runs every rule and tolerates empty / junk rows", () => {
  assert.deepEqual(evaluateRules([], OPTS), []);
  assert.deepEqual(evaluateRules(undefined, OPTS), []);
  const junk = [row("TL0000000001", null, "SHORT", 99, "not a time"), row(null, "GS1", "SHORT", 99, at(14, 0))];
  assert.doesNotThrow(() => evaluateRules(junk, OPTS));
});

test("both rules can fire from the same data", () => {
  const stock = [row("TL0000000001", "CC1", "SHORT", 30, at(14, 0))];
  const ev = evaluateRules(stock, { ...OPTS, discRows: marks("GS7", 9, 14) });
  assert.deepEqual(ev.map((e) => e.ruleKey).sort(), ["G1_TOTE_SHORT_QTY", "G2_STATION_SHORT_TOTES"]);
});

test("notBeforeMs: events before the alerts start time are never raised", () => {
  const rows = [row("TL0000000001", "GS1", "SHORT", 40, at(13, 0)), row("TL0000000002", "GS1", "SHORT", 40, at(14, 30))];
  const cutoff = Date.UTC(2026, 9, 13, 8, 0); // 13:30 IST
  const ev = evaluateRules(rows, { ...OPTS, notBeforeMs: cutoff });
  assert.equal(ev.length, 1);
  assert.match(ev[0].title, /TL0000000002/);
});

test("G1: a tote pulled for PURGE (marked short on purpose) raises no alert; the same tote not purged still does", () => {
  const rows = [row("TL0000000001", "GS1", "SHORT", 30, at(14, 0)), row("TL0000000001", "GS1", "ALRIGHT", 0, at(14, 0))];
  const window = { from: Date.UTC(2026, 9, 13, 8, 0), to: Date.UTC(2026, 9, 13, 9, 0) }; // pulled 13:30 IST, seen empty 14:30 IST; the check is 14:00 IST
  assert.equal(toteShortQtyEvents(rows, { threshold: 25, sinceMs: 0, purgeMarks: { TL0000000001: window } }).length, 0);
  assert.equal(toteShortQtyEvents(rows, { threshold: 25, sinceMs: 0 }).length, 1);
});
