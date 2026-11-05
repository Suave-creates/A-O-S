// Evaluates the alert rules against today's stock-check rows and persists the events.
// Pure orchestration: rows in, store writes out - the live layer (server/live/alertsFeed.js) decides
// WHEN to run it and where the rows come from (the shared CC data layer, no extra Grafana load).
// Limits and on/off come from the Alerts page (alert_rule_settings); config.js supplies the defaults.

const config = require("../../config");
const defaultStore = require("./alertStore");
const { evaluateRules } = require("./alertRules");

const DEFAULT_KEY = { G1_TOTE_SHORT_QTY: "alertToteShortQtyThreshold", G2_STATION_SHORT_TOTES: "alertStationHourToteThreshold" };

function createEngine({ store = defaultStore, defaults = null, now = Date.now, startAt = undefined } = {}) {
  const startMs = () => { const t = Date.parse(startAt === undefined ? config.alertsStartAt : startAt); return Number.isFinite(t) ? t : 0; };
  const base = () => defaults || { G1_TOTE_SHORT_QTY: config[DEFAULT_KEY.G1_TOTE_SHORT_QTY], G2_STATION_SHORT_TOTES: config[DEFAULT_KEY.G2_STATION_SHORT_TOTES], lookbackHours: config.alertLookbackHours };

  // Effective settings per rule: [{ key, enabled, threshold, default }] plus the lookback.
  async function settings() {
    const d = base();
    let saved = {};
    try { saved = await store.ruleSettings(); } catch (e) { saved = {}; } // settings table unavailable -> defaults
    const rules = ["G1_TOTE_SHORT_QTY", "G2_STATION_SHORT_TOTES"].map((key) => ({
      key,
      default: d[key],
      enabled: saved[key] ? saved[key].enabled : true,
      threshold: saved[key] ? saved[key].threshold : d[key],
      updatedBy: saved[key] ? saved[key].updatedBy : null,
      updatedAt: saved[key] ? saved[key].updatedAt : null,
    }));
    return { rules, lookbackHours: d.lookbackHours };
  }

  // Returns { events, raised } - raised = alerts that did not exist before this evaluation.
  async function evaluate(stockRows, discRows, purgeMarks = {}) {
    const s = await settings();
    const by = Object.fromEntries(s.rules.map((r) => [r.key, r]));
    const events = evaluateRules(stockRows || [], {
      discRows: discRows || [],
      purgeMarks,
      now: now(),
      notBeforeMs: startMs(),
      toteShortQty: by.G1_TOTE_SHORT_QTY.threshold,
      stationHourTotes: by.G2_STATION_SHORT_TOTES.threshold,
      lookbackHours: s.lookbackHours,
      enabled: { G1_TOTE_SHORT_QTY: by.G1_TOTE_SHORT_QTY.enabled, G2_STATION_SHORT_TOTES: by.G2_STATION_SHORT_TOTES.enabled },
    });
    const raised = [];
    for (const ev of events) {
      const { created, alert } = await store.upsertEvent(ev);
      if (created && alert) raised.push(alert);
    }
    return { events, raised };
  }

  return { evaluate, settings };
}

module.exports = createEngine();
module.exports.createEngine = createEngine;
