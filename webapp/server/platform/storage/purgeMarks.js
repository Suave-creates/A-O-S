// Totes pulled with the Purge toggle through the Manual Tote Puller (table `purge_pulls`, migrations 0017-0019).
// A pull alone does not make a tote Purged - operators sometimes do a normal cycle count, and a purged tote can be
// decanted again later. So each pull keeps a Quadron inventory BASELINE taken when the calling finished, and
// features/tote-puller/purgeTracking.js watches it for 2 days:
//   PENDING   waiting (stock unchanged, or only partly counted down)
//   PURGED    Quadron showed the tote EMPTY - purged_at is the moment that was first seen
//   RESTOCKED Quadron showed new stock (other PIDs) without ever being empty - not a purge
//   EXPIRED   nothing happened inside the window - not a purge
// The CC metrics and the Alerts module only see PURGED rows, as a time window (pull .. purged_at): only the
// cycle count inside that window is the purge; a later count on the same tote is a normal CC.
// The only file that talks to the table.

const defaultDb = require("../db");
const { baseToteId } = require("../domain/classification");

const LOOKBACK_MS = 3 * 86400000; // 2-day watch window + a day of slack; older rows only slow the read

function parseSkus(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.map(String) : null;
  } catch (e) {
    return null;
  }
}

function createPurgeMarks({ db = defaultDb, now = () => Date.now() } = {}) {
  const sinceIso = () => new Date(now() - LOOKBACK_MS).toISOString();

  async function record(totes, { sessionId = null, userId = null } = {}) {
    const bases = [...new Set((totes || []).map(baseToteId).filter(Boolean))];
    if (!bases.length) return 0;
    const at = new Date(now()).toISOString();
    const marks = bases.map(() => "(?, ?, ?, ?)").join(",");
    await db.execute(
      `INSERT INTO purge_pulls (tote_id, pulled_at, session_id, user_id) VALUES ${marks}`,
      bases.flatMap((t) => [t, at, sessionId, userId])
    );
    return bases.length;
  }

  // The calling for this session is finished: from now on its totes are baselined and watched.
  async function markSessionDone(sessionId) {
    await db.execute("UPDATE purge_pulls SET pull_done_at = ? WHERE session_id = ? AND pull_done_at IS NULL", [new Date(now()).toISOString(), sessionId]);
  }

  // -> { BASE_TOTE: { from, to } } (epoch ms) for totes Quadron showed empty: the latest PURGED pull of each.
  // Never throws: no marks just means no totes are called Purged.
  async function loadRecent() {
    try {
      const rows = await db.query("SELECT tote_id, pulled_at, purged_at FROM purge_pulls WHERE status = 'PURGED' AND pulled_at >= ?", [sinceIso()]);
      const out = {};
      for (const r of rows) {
        const from = Date.parse(r.pulled_at);
        const to = Date.parse(r.purged_at);
        if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
        if (!out[r.tote_id] || from > out[r.tote_id].from) out[r.tote_id] = { from, to };
      }
      return out;
    } catch (e) {
      return {};
    }
  }

  // Pulls the tracker still watches: calling finished, not decided yet.
  async function loadOpen() {
    const rows = await db.query(
      "SELECT id, tote_id, pulled_at, pull_done_at, snapshot_at, baseline_qty, baseline_skus FROM purge_pulls WHERE status = 'PENDING' AND pull_done_at IS NOT NULL AND pulled_at >= ?",
      [sinceIso()]
    );
    return rows.map((r) => ({
      id: r.id,
      tote: r.tote_id,
      pulledAtMs: Date.parse(r.pulled_at),
      doneAtMs: Date.parse(r.pull_done_at),
      snapshotAt: r.snapshot_at || null,
      baselineQty: r.baseline_qty == null ? null : Number(r.baseline_qty),
      baselineSkus: parseSkus(r.baseline_skus),
    }));
  }

  async function setBaseline(id, qty, skus) {
    await db.execute("UPDATE purge_pulls SET snapshot_at = ?, baseline_qty = ?, baseline_skus = ? WHERE id = ?", [new Date(now()).toISOString(), qty, JSON.stringify(skus), id]);
  }

  async function setStatus(id, status) {
    const purgedAt = status === "PURGED" ? new Date(now()).toISOString() : null;
    await db.execute("UPDATE purge_pulls SET status = ?, purged_at = ? WHERE id = ?", [status, purgedAt, id]);
  }

  return { record, markSessionDone, loadRecent, loadOpen, setBaseline, setStatus };
}

module.exports = { createPurgeMarks, ...createPurgeMarks() };
