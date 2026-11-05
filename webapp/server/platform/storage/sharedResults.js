// The latest result of a run-type screen, shared by everyone (operator decision 2026-11-04: what anyone loads is
// seen by everyone until someone runs it again). One entry per panel, kept in memory and in MySQL
// (migration 0026) so a restart keeps it. The live topic only carries the small header (who / when / version);
// a screen reads the full result with get() when the version changes.

const defaultDb = require("../db");
const jsonBlob = require("./jsonBlob");

function create({ db = defaultDb } = {}) {
  const entries = new Map(); // panel -> { version, runBy, runAt, meta, result }
  const loaded = new Map(); // panel -> Promise (first read from MySQL)

  function load(panel) {
    if (!loaded.has(panel)) {
      loaded.set(panel, (async () => {
        try {
          const rows = await db.query("SELECT result_json, meta_json, run_by, run_at FROM shared_results WHERE panel = ?", [panel]);
          const r = rows[0];
          if (r && !entries.has(panel)) {
            entries.set(panel, { version: 1, runBy: r.run_by, runAt: r.run_at, meta: r.meta_json ? JSON.parse(r.meta_json) : null, result: await jsonBlob.unpack(r.result_json) });
          }
        } catch (e) {
          loaded.delete(panel); // try MySQL again next time
        }
      })());
    }
    return loaded.get(panel);
  }

  async function get(panel) {
    await load(panel);
    return entries.get(panel) || null;
  }

  // header only (for the live topic): null when nothing has run yet
  async function header(panel) {
    const e = await get(panel);
    return e ? { version: e.version, runBy: e.runBy, runAt: e.runAt, meta: e.meta } : null;
  }

  async function set(panel, { result, runBy, meta = null, runAt = new Date().toISOString() }) {
    await load(panel);
    const prev = entries.get(panel);
    const entry = { version: (prev ? prev.version : 0) + 1, runBy: runBy || null, runAt, meta, result };
    entries.set(panel, entry);
    db.execute(
      `INSERT INTO shared_results (panel, result_json, meta_json, run_by, run_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE result_json = VALUES(result_json), meta_json = VALUES(meta_json), run_by = VALUES(run_by), run_at = VALUES(run_at)`,
      [panel, await jsonBlob.pack(result), meta ? JSON.stringify(meta) : null, entry.runBy, runAt]
    ).catch((e) => console.warn(`[shared-results] ${panel} not stored: ${e.message || e}`)); // best-effort: memory still serves it
    return entry;
  }

  return { get, header, set };
}

module.exports = { create, ...create() };
