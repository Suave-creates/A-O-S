// The Dashboard's central auto refresh (operator decision 2026-11-04): one interval per tile source for the whole
// site, set by an admin and kept in app_settings. The live hub runs ONE timer per topic (liveHub.setAutoInterval)
// while someone has the Dashboard in view, so Grafana load follows the interval, never the number of viewers.
// Every browser shows the same settings and countdown through the "dashboard.autoRefresh" topic.

const defaultDb = require("../platform/db");

const KEY = "dashboard_auto_refresh";
const MAX_MIN = 240;
// one row per tile source (tiles that share a source refresh together); minutes, 0 = off
const SOURCES = [
  { topic: "dashboard.compaction", label: "Compaction & Tote Freed", def: 5 },
  { topic: "dashboard.cc", label: "CC Done, Bermuda & Discrepancies", def: 5 },
  { topic: "dashboard.outside", label: "Outside Totes", def: 10 },
  { topic: "locked-tote-info.latest", label: "Locked Totes", def: 15 },
  { topic: "dashboard.utilisation", label: "Tote Utilisation & Totes in ASRS", def: 30 },
  { topic: "dashboard.aisle", label: "Aisle Occupancy", def: 10 },
];
const defaults = () => Object.fromEntries(SOURCES.map((s) => [s.topic, s.def]));

function clean(minutes) {
  const out = defaults();
  for (const s of SOURCES) {
    const v = Number(minutes && minutes[s.topic]);
    if (Number.isInteger(v) && v >= 0 && v <= MAX_MIN) out[s.topic] = v;
  }
  return out;
}

function create({ hub, db = defaultDb, log = console } = {}) {
  let minutes = defaults();
  let updatedBy = null;
  let updatedAt = null;

  const apply = () => { for (const s of SOURCES) hub.setAutoInterval(s.topic, minutes[s.topic] * 60000); };

  async function load() {
    apply(); // defaults straight away; the stored value replaces them when MySQL answers
    try {
      const rows = await db.query("SELECT value_json, updated_by, updated_at FROM app_settings WHERE setting_key = ?", [KEY]);
      if (rows[0]) {
        minutes = clean(JSON.parse(rows[0].value_json));
        updatedBy = rows[0].updated_by;
        updatedAt = rows[0].updated_at;
        apply();
      }
    } catch (e) {
      log.warn(`[dashboard-auto-refresh] settings not loaded, using defaults: ${e.message || e}`);
    }
  }

  // admin only (the route checks the role); { reset: true } puts the defaults back
  async function save(input, by) {
    minutes = input && input.reset ? defaults() : clean({ ...minutes, ...((input && input.minutes) || {}) });
    updatedBy = by || null;
    updatedAt = new Date().toISOString();
    apply();
    await db.execute(
      `INSERT INTO app_settings (setting_key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      [KEY, JSON.stringify(minutes), updatedBy, updatedAt]
    );
    return view();
  }

  // what every Dashboard shows: the settings, and when each source refreshes next (null: off / nobody watching / reading)
  function view() {
    return {
      sources: SOURCES.map((s) => {
        const info = hub.autoInfo(s.topic);
        return { topic: s.topic, label: s.label, minutes: minutes[s.topic], def: s.def, nextAt: info.nextAt, refreshing: info.running };
      }),
      updatedBy,
      updatedAt,
    };
  }

  return { load, save, view };
}

module.exports = { create, SOURCES, MAX_MIN, clean, defaults };
