// Storage for the live day cache (migration 0025): the settled per-hour / per-shift Grafana reads of the open
// site day, so a restart does not mean reading the whole day again. The policy lives in
// integrations/grafana/grafanaDayCache.js; this file only loads, saves and prunes.

const defaultDb = require("../db");
const jsonBlob = require("./jsonBlob");

// Map slot -> { value, readAt, frozen } for one (date, section).
async function load(dateStr, section, { db = defaultDb } = {}) {
  const rows = await db.query("SELECT slot, value_json, read_at, frozen FROM live_day_cache WHERE date_str = ? AND section = ?", [dateStr, section]);
  const out = new Map();
  for (const r of rows) out.set(r.slot, { value: await jsonBlob.unpack(r.value_json), readAt: Number(r.read_at), frozen: !!r.frozen });
  return out;
}

async function save(dateStr, section, slot, entry, { db = defaultDb } = {}) {
  await db.execute(
    `INSERT INTO live_day_cache (date_str, section, slot, value_json, read_at, frozen) VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), read_at = VALUES(read_at), frozen = VALUES(frozen)`,
    [dateStr, section, slot, await jsonBlob.pack(entry.value), entry.readAt, entry.frozen ? 1 : 0]
  );
}

// Drops every date before keepFrom ("YYYY-MM-DD").
async function prune(keepFrom, { db = defaultDb } = {}) {
  await db.execute("DELETE FROM live_day_cache WHERE date_str < ?", [keepFrom]);
}

// In-memory twin for tests (same contract).
function memoryStore() {
  const rows = new Map(); // `${date}|${section}` -> Map slot -> entry
  return {
    rows,
    async load(dateStr, section) { return new Map(rows.get(`${dateStr}|${section}`) || []); },
    async save(dateStr, section, slot, entry) {
      const k = `${dateStr}|${section}`;
      if (!rows.has(k)) rows.set(k, new Map());
      rows.get(k).set(slot, { ...entry });
    },
    async prune(keepFrom) { for (const k of [...rows.keys()]) if (k.split("|")[0] < keepFrom) rows.delete(k); },
  };
}

module.exports = { load, save, prune, memoryStore };
