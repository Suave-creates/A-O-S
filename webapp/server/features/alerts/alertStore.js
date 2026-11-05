// MySQL persistence for alerts: `alerts` (migration 0012; searchable columns 0020), its history `alert_events` and
// the per-day rollup `alert_daily` (0020). The only file that talks to these tables.

const defaultDb = require("../../platform/db");
const { RULES } = require("./alertRules");

const COLUMNS = `id, rule_key, level, dedupe_key, title, detail, event_at, raised_at, updated_at, status,
  acknowledged_by, acknowledged_at, remark, remark_by, remark_at, undo_ok, station, tote, metric, threshold`;

// ISO strings ("2026-10-13T11:49:47.000Z") -> DATETIME (UTC) and -> IST calendar day, inside SQL.
const TS = (col) => `STR_TO_DATE(LEFT(${col}, 19), '%Y-%m-%dT%H:%i:%s')`;
const IST_DAY = `DATE(DATE_ADD(${TS("event_at")}, INTERVAL 330 MINUTE))`;

const intOrNull = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
const strOrNull = (v) => (v == null || v === "" ? null : String(v));

// The searchable copies of a rule's detail (station / tote / the figure compared with the limit / the limit).
function indexedFields(ruleKey, detail) {
  const d = detail || {};
  const metricKey = (RULES[ruleKey] || {}).metric;
  return { station: strOrNull(d.station), tote: strOrNull(d.tote), metric: metricKey ? intOrNull(d[metricKey]) : null, threshold: intOrNull(d.threshold) };
}

function toAlert(r) {
  let detail = null;
  try {
    detail = r.detail ? JSON.parse(r.detail) : null;
  } catch (e) {
    detail = null;
  }
  return {
    id: Number(r.id),
    ruleKey: r.rule_key,
    level: r.level,
    title: r.title,
    detail,
    station: r.station == null ? null : r.station,
    tote: r.tote == null ? null : r.tote,
    metric: r.metric == null ? null : Number(r.metric),
    threshold: r.threshold == null ? null : Number(r.threshold),
    eventAt: r.event_at,
    raisedAt: r.raised_at,
    updatedAt: r.updated_at,
    status: r.status,
    acknowledgedBy: r.acknowledged_by,
    acknowledgedAt: r.acknowledged_at,
    remark: r.remark,
    remarkBy: r.remark_by,
    remarkAt: r.remark_at,
    undoAvailable: !!r.undo_ok, // the latest remark can be taken back once
  };
}

const affected = (res) => Number((res && (res.affectedRows != null ? res.affectedRows : res[0] && res[0].affectedRows)) || 0);

function createStore({ db = defaultDb, now = () => new Date().toISOString() } = {}) {
  // History row. A failed history write is logged, never allowed to fail the alert action itself.
  async function logEvent(alertId, kind, at, { actor = null, metric = null, note = null } = {}) {
    try {
      await db.execute("INSERT INTO alert_events (alert_id, kind, at, actor, metric, note) VALUES (?, ?, ?, ?, ?, ?)", [alertId, kind, at, actor, metric, note]);
    } catch (e) {
      console.warn(`[alerts] history write failed (${kind} #${alertId}):`, e.message);
    }
  }

  // Idempotent raise. A new event is inserted OPEN; an event we already have only has its title/detail
  // refreshed (e.g. a station's short-tote count grew) - status, acknowledgement and remark are never touched.
  // Returns { created, alert }.
  async function upsertEvent(event) {
    const detailJson = JSON.stringify(event.detail || {});
    const f = indexedFields(event.ruleKey, event.detail);
    const existing = await db.query(`SELECT ${COLUMNS} FROM alerts WHERE dedupe_key = ? LIMIT 1`, [event.dedupeKey]);
    if (existing[0]) {
      if (existing[0].detail !== detailJson || existing[0].title !== event.title) {
        const t = now();
        await db.execute("UPDATE alerts SET title = ?, detail = ?, station = ?, tote = ?, metric = ?, threshold = ?, updated_at = ? WHERE id = ?", [event.title, detailJson, f.station, f.tote, f.metric, f.threshold, t, existing[0].id]);
        await logEvent(Number(existing[0].id), "UPDATED", t, { metric: f.metric });
        return { created: false, alert: toAlert({ ...existing[0], title: event.title, detail: detailJson, ...f }) };
      }
      return { created: false, alert: toAlert(existing[0]) };
    }
    const t = now();
    try {
      const res = await db.execute(
        `INSERT INTO alerts (rule_key, level, dedupe_key, title, detail, event_at, raised_at, updated_at, status, station, tote, metric, threshold)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
        [event.ruleKey, event.level, event.dedupeKey, event.title, detailJson, event.eventAt, t, t, f.station, f.tote, f.metric, f.threshold]
      );
      const id = res && (res.insertId != null ? res.insertId : res[0] && res[0].insertId);
      await logEvent(Number(id), "RAISED", t, { metric: f.metric });
      const rows = await db.query(`SELECT ${COLUMNS} FROM alerts WHERE id = ?`, [id]);
      return { created: true, alert: toAlert(rows[0]) };
    } catch (e) {
      if (e && (e.code === "ER_DUP_ENTRY" || e.errno === 1062)) return { created: false, alert: null }; // raised concurrently by another evaluation
      throw e;
    }
  }

  // Open alerts first, then newest; capped. `sinceIso` bounds how far back acknowledged history reaches.
  async function listRecent({ limit = 200, sinceIso = null } = {}) {
    const n = Math.min(500, Math.max(1, Number(limit) || 200));
    const rows = sinceIso
      ? await db.query(`SELECT ${COLUMNS} FROM alerts WHERE event_at >= ? ORDER BY (status = 'OPEN') DESC, raised_at DESC LIMIT ?`, [sinceIso, n])
      : await db.query(`SELECT ${COLUMNS} FROM alerts ORDER BY (status = 'OPEN') DESC, raised_at DESC LIMIT ?`, [n]);
    return rows.map(toAlert);
  }

  // Every alert whose event is at/after `sinceIso` (analytics). Capped so a runaway rule can't load the table;
  // `capped` tells the caller the summary is partial.
  async function listSince(sinceIso, cap = 20000) {
    const rows = await db.query(`SELECT ${COLUMNS} FROM alerts WHERE event_at >= ? ORDER BY event_at DESC LIMIT ?`, [sinceIso, cap + 1]);
    return { alerts: rows.slice(0, cap).map(toAlert), capped: rows.length > cap };
  }

  // History of the alerts whose event is at/after `sinceIso` (the history itself may be later).
  async function eventsForAlertsSince(sinceIso) {
    const rows = await db.query(
      "SELECT e.alert_id, e.kind, e.at, e.actor, e.metric FROM alert_events e JOIN alerts a ON a.id = e.alert_id WHERE a.event_at >= ? ORDER BY e.at",
      [sinceIso]
    );
    return rows.map((r) => ({ alertId: Number(r.alert_id), kind: r.kind, at: r.at, actor: r.actor, metric: r.metric == null ? null : Number(r.metric) }));
  }

  // One alert's history, oldest first.
  async function history(id) {
    const rows = await db.query("SELECT kind, at, actor, metric, note FROM alert_events WHERE alert_id = ? ORDER BY at, id", [id]);
    return rows.map((r) => ({ kind: r.kind, at: r.at, actor: r.actor, metric: r.metric == null ? null : Number(r.metric), note: r.note }));
  }

  async function get(id) {
    const rows = await db.query(`SELECT ${COLUMNS} FROM alerts WHERE id = ?`, [id]);
    return rows[0] ? toAlert(rows[0]) : null;
  }

  // First acknowledgement wins; acknowledging an already-acknowledged alert is a no-op that returns it.
  async function acknowledge(id, employeeId) {
    const t = now();
    const res = await db.execute("UPDATE alerts SET status = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ?, updated_at = ? WHERE id = ? AND status = 'OPEN'", [employeeId, t, t, id]);
    if (affected(res)) await logEvent(id, "ACKNOWLEDGED", t, { actor: employeeId });
    return get(id);
  }

  // Saves a remark. The previous one (if any) is kept so the save can be undone once. (MySQL applies the
  // SET assignments left to right, so remark_prev picks up the OLD remark before it is overwritten.)
  async function setRemark(id, text, employeeId) {
    const t = now();
    const res = await db.execute(
      "UPDATE alerts SET remark_prev = remark, remark_prev_by = remark_by, remark_prev_at = remark_at, undo_ok = 1, remark = ?, remark_by = ?, remark_at = ?, updated_at = ? WHERE id = ?",
      [text, employeeId, t, t, id]
    );
    if (affected(res)) await logEvent(id, "REMARK", t, { actor: employeeId, note: text });
    return get(id);
  }

  // Takes back the latest remark save (once): the remark returns to what it was before. No-op if already undone.
  async function undoRemark(id, employeeId = null) {
    const t = now();
    const res = await db.execute(
      "UPDATE alerts SET remark = remark_prev, remark_by = remark_prev_by, remark_at = remark_prev_at, remark_prev = NULL, remark_prev_by = NULL, remark_prev_at = NULL, undo_ok = 0, updated_at = ? WHERE id = ? AND undo_ok = 1",
      [t, id]
    );
    if (affected(res)) await logEvent(id, "REMARK_UNDONE", t, { actor: employeeId });
    return get(id);
  }

  // Rebuilds `alert_daily` from `alerts`: every day, or only the IST days of alerts changed since
  // `changedSinceIso` (raised, grown, acknowledged or remarked - all bump updated_at). Returns the days rebuilt.
  async function rebuildDaily({ changedSinceIso = null } = {}) {
    let days = null;
    if (changedSinceIso) {
      const rows = await db.query(`SELECT DISTINCT DATE_FORMAT(${IST_DAY}, '%Y-%m-%d') AS day FROM alerts WHERE updated_at >= ?`, [changedSinceIso]);
      days = rows.map((r) => r.day).filter(Boolean);
      if (!days.length) return 0;
    }
    const ackSeconds = `CASE WHEN acknowledged_at IS NOT NULL THEN GREATEST(0, TIMESTAMPDIFF(SECOND, ${TS("raised_at")}, ${TS("acknowledged_at")})) END`;
    const where = days ? `WHERE ${IST_DAY} IN (?)` : "";
    await db.transaction(async (tx) => {
      await tx.query(days ? "DELETE FROM alert_daily WHERE day IN (?)" : "DELETE FROM alert_daily", days ? [days] : []);
      await tx.query(
        `INSERT INTO alert_daily (day, rule_key, station, level, raised, acknowledged, with_remark, metric_sum, ack_seconds_sum, ack_seconds_max, refreshed_at)
         SELECT ${IST_DAY}, rule_key, COALESCE(station, ''), MAX(level), COUNT(*), SUM(status = 'ACKNOWLEDGED'), SUM(remark IS NOT NULL),
                COALESCE(SUM(metric), 0), COALESCE(SUM(${ackSeconds}), 0), MAX(${ackSeconds}), ?
         FROM alerts ${where} GROUP BY 1, 2, 3`,
        days ? [now(), days] : [now()]
      );
    });
    return days ? days.length : -1;
  }

  // Per IST day x level from the rollup, for [fromDay, toDay] (YYYY-MM-DD).
  async function dailyBetween(fromDay, toDay) {
    const rows = await db.query(
      "SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day, level, SUM(raised) AS raised, SUM(acknowledged) AS acknowledged, SUM(with_remark) AS with_remark, SUM(metric_sum) AS metric_sum FROM alert_daily WHERE day BETWEEN ? AND ? GROUP BY day, level ORDER BY day",
      [fromDay, toDay]
    );
    return rows.map((r) => ({ day: r.day, level: r.level, raised: Number(r.raised), acknowledged: Number(r.acknowledged), withRemark: Number(r.with_remark), metricSum: Number(r.metric_sum) }));
  }

  // Operator-edited rule settings: { [ruleKey]: { enabled, threshold } } (rules never edited have no row).
  async function ruleSettings() {
    const rows = await db.query("SELECT rule_key, enabled, threshold, updated_by, updated_at FROM alert_rule_settings");
    return Object.fromEntries(rows.map((r) => [r.rule_key, { enabled: !!r.enabled, threshold: Number(r.threshold), updatedBy: r.updated_by, updatedAt: r.updated_at }]));
  }

  async function saveRuleSetting(ruleKey, { enabled, threshold }, employeeId) {
    await db.execute(
      `INSERT INTO alert_rule_settings (rule_key, enabled, threshold, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), threshold = VALUES(threshold), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      [ruleKey, enabled ? 1 : 0, threshold, employeeId, now()]
    );
  }

  return { upsertEvent, listRecent, listSince, eventsForAlertsSince, history, get, acknowledge, setRemark, undoRemark, rebuildDaily, dailyBetween, ruleSettings, saveRuleSetting };
}

module.exports = createStore();
module.exports.createStore = createStore;
module.exports.toAlert = toAlert;
module.exports.indexedFields = indexedFields;
