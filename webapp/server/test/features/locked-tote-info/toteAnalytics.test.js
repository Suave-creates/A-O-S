const test = require("node:test");
const assert = require("node:assert/strict");
const { analyse, outcomeOf, buildChecks, siteDay } = require("../../../features/locked-tote-info/toteAnalytics");
const { compact } = require("../../../features/locked-tote-info/ccDayRows");

// 2026-11-02 IST wall clock -> the IST "YYYY-MM-DD HH:MM:SS" a stock line carries, and its epoch ms
const ist = (hh, mm = 0, day = "2026-11-02") => `${day} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
const ms = (hh, mm = 0, day = "2026-11-02") => Date.parse(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`);
const line = (c, t, r, sku = "S1", q = 1, st = "GS1") => ({ c, t, st, u: st, sku, q, r });
const report = (c, at, st = "PS9") => ({ c, ms: at, st, u: st });
const FROM = ms(6, 0);
const TO = ms(6, 0, "2026-11-03");

test("outcome of a check from its lines", () => {
  assert.equal(outcomeOf([{ r: "ALRIGHT" }, { r: "ALRIGHT" }]), "ALL_ALRIGHT");
  assert.equal(outcomeOf([{ r: "SHORT" }, { r: "SHORT" }]), "BERMUDA");
  assert.equal(outcomeOf([{ r: "SHORT" }, { r: "ALRIGHT" }]), "SHORT");
  assert.equal(outcomeOf([{ r: "EXCESS" }, { r: "ALRIGHT" }]), "EXCESS");
  assert.equal(outcomeOf([{ r: "SHORT" }, { r: "EXCESS" }]), "SHORT_EXCESS");
});

test("lines of one tote at one time are one check; a site day starts at 06:00 IST", () => {
  const checks = buildChecks([line("TL1", ist(10), "SHORT"), line("TL1", ist(10), "ALRIGHT", "S2"), line("TL1", ist(12), "ALRIGHT")]);
  assert.equal(checks.length, 2);
  assert.deepEqual(checks[0].skus, ["S1", "S2"]);
  assert.equal(siteDay(ms(5, 59, "2026-11-03")), "2026-11-02");
  assert.equal(siteDay(ms(6, 0, "2026-11-03")), "2026-11-03");
});

test("reported within 3 days before = PROPER; no report = GHOST, split by who called it; purge = PURGED", () => {
  const r = analyse({
    reports: [report("TL1", ms(9)), report("TL4", ms(9, 0, "2026-10-29"))], // TL4's report is 4 days old
    lines: [line("TL1", ist(10), "SHORT", "A"), line("TL2", ist(11), "ALRIGHT", "B"), line("TL3", ist(12), "ALRIGHT", "C"), line("TL4", ist(13), "ALRIGHT", "D"), line("TL5", ist(14), "SHORT", "E")],
    pulls: [{ tote: "TL3", ms: ms(11, 30), kind: "MANUAL", employee: "E1" }],
    purges: { TL5: { from: ms(13, 50), to: ms(14, 5) } },
    fromMs: FROM, toMs: TO,
  });
  const by = Object.fromEntries(r.lists.ghosts.map((g) => [g.tote, g.via]));
  assert.equal(r.summary.proper, 1);
  assert.equal(r.summary.ghost, 3);
  assert.deepEqual(by, { TL2: "OUTSIDE", TL3: "AOS_MANUAL", TL4: "OUTSIDE" });
  assert.equal(r.summary.purged, 1);
  assert.equal(r.summary.medianReportToCcMin, 60);
});

test("one report never justifies two counts of the same tote", () => {
  const r = analyse({ reports: [report("TL1", ms(9))], lines: [line("TL1", ist(10), "SHORT"), line("TL1", ist(15), "ALRIGHT")], fromMs: FROM, toMs: TO });
  assert.equal(r.summary.proper, 1);
  assert.equal(r.summary.ghost, 1);
});

test("a SKU that came up SHORT in a reported tote, counted in another tote within 48 h, is a repeat SKU (tagged by its own class)", () => {
  const r = analyse({
    reports: [report("TL1", ms(9))],
    lines: [line("TL1", ist(10), "SHORT", "SKU-X"), line("TL1", ist(10), "ALRIGHT", "SKU-Z"), line("TL2", ist(12), "ALRIGHT", "SKU-X"), line("TL3", ist(13), "ALRIGHT", "SKU-Z")],
    fromMs: FROM, toMs: TO,
  });
  assert.equal(r.summary.repeatSku, 1); // TL3 shares only SKU-Z, which was ALRIGHT - not a reported SKU
  assert.equal(r.lists.repeatSkus[0].tote, "TL2");
  assert.equal(r.lists.repeatSkus[0].cls, "GHOST");
  assert.deepEqual(r.lists.repeatSkus[0].reportedTotes, ["TL1"]);
});

test("the same tote counted again within 48 h is a repeat tote; older than 48 h is not", () => {
  const r = analyse({
    reports: [],
    lines: [line("TL1", ist(9, 0, "2026-10-30"), "ALRIGHT"), line("TL1", ist(10), "ALRIGHT"), line("TL2", ist(10, 0, "2026-11-01"), "ALRIGHT"), line("TL2", ist(9), "SHORT")],
    fromMs: FROM, toMs: TO,
  });
  assert.equal(r.summary.repeatTote, 1);
  assert.equal(r.lists.repeatTotes[0].tote, "TL2");
  assert.equal(r.lists.repeatTotes[0].gapMin, 23 * 60);
});

test("a report never counted is pending; counted but still locked is flagged", () => {
  const locked = { at: ms(20), totes: new Map([["TL1", { priority: "P0", lockedSinceMs: ms(8) }]]) };
  const r = analyse({ reports: [report("TL1", ms(9)), report("TL9", ms(16))], lines: [line("TL1", ist(10), "SHORT")], locked, fromMs: FROM, toMs: TO, now: ms(21) });
  assert.equal(r.summary.pending, 1);
  assert.equal(r.lists.pending[0].tote, "TL9");
  assert.equal(r.summary.stillLocked, 1);
  assert.equal(r.lists.stillLocked[0].priority, "P0");
});

test("an ALL_ALRIGHT count of a reported tote is a false report, credited to the reporting station", () => {
  const r = analyse({ reports: [report("TL1", ms(9), "PS1"), report("TL2", ms(9), "PS1")], lines: [line("TL1", ist(10), "ALRIGHT"), line("TL2", ist(10), "SHORT")], fromMs: FROM, toMs: TO });
  assert.equal(r.summary.falseReports, 1);
  assert.equal(r.summary.falseReportPct, 50);
  assert.deepEqual(r.reportingStations[0], { station: "PS1", reports: 2, counted: 2, falseReports: 1, falsePct: 50 });
});

test("compact keeps SHORT discrepancy events only, base tote ids, and moves report times from IST-as-UTC to real time", () => {
  const c = compact({
    A: { discRows: [{ container: "TL1-2", discrepancyType: "SHORT", createTime: 5.5 * 3600000 + 5, station: "P" }, { container: "TL2", discrepancyType: "ALRIGHT", createTime: 6 }], stockRows: [{ container: "TL1-2", createTime: "2026-11-02 10:00:00.123", sku: 7, quantity: "2", resultType: "SHORT", station: "G" }] },
    B: { discRows: [], stockRows: [] }, C: { discRows: [], stockRows: [] },
  });
  assert.deepEqual(c.reports, [{ c: "TL1", ms: 5, st: "P", u: null }]);
  assert.deepEqual(c.lines, [{ c: "TL1", t: "2026-11-02 10:00:00", st: "G", u: null, sku: "7", q: 2, r: "SHORT" }]);
});
