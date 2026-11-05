// Alert analytics - a pure summary of the alerts raised in a period (no I/O, so it is unit-testable).
// Days and hours are IST, matching how the rules label events. "Time to acknowledge" is measured from
// raised_at (when this app showed the alert), not event_at, so it reflects how fast people responded.
//
// Inputs: the period's alerts (`alerts` rows), their history (`alert_events`: every remark save/undo and every
// time an alert grew) and the per-day rollup (`alert_daily`). Without history/rollup (e.g. before migration
// 0020) the same figures are derived from the alerts alone.

const { RULES } = require("./alertRules");

const IST_OFFSET_MS = 5.5 * 3600000;
const DAY_MS = 86400000;

const istDay = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istHour = (ms) => new Date(ms + IST_OFFSET_MS).getUTCHours();

// Nearest-rank percentile of a sorted array; null when there is nothing to measure.
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function ackStats(minutes) {
  const s = [...minutes].sort((a, b) => a - b);
  return { count: s.length, medianMin: percentile(s, 50), p90Min: percentile(s, 90) };
}

// alerts: store rows (toAlert shape). Returns everything the Analytics view draws for [sinceMs, nowMs].
function summarize(alerts, { sinceMs, nowMs, events = null, daily = null }) {
  const inPeriod = alerts.filter((a) => {
    const t = Date.parse(a.eventAt);
    return Number.isFinite(t) && t >= sinceMs && t <= nowMs;
  });

  // One slot per IST day in the period, so quiet days show as a real zero (the data covers them).
  const days = new Map();
  for (let t = sinceMs; istDay(t) <= istDay(nowMs); t += DAY_MS) days.set(istDay(t), { day: istDay(t), GLOBAL: 0, NORMAL: 0 });
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
  const rules = new Map();
  const people = new Map();
  const stations = new Map();
  const ackMinutes = [];
  let open = 0, acknowledged = 0, withRemark = 0;

  for (const a of inPeriod) {
    const at = Date.parse(a.eventAt);
    const d = days.get(istDay(at));
    if (d) d[a.level === "GLOBAL" ? "GLOBAL" : "NORMAL"]++;
    hours[istHour(at)].count++;
    if (a.status === "OPEN") open++;
    else acknowledged++;
    if (a.remark) withRemark++;

    if (!rules.has(a.ruleKey)) rules.set(a.ruleKey, { key: a.ruleKey, label: (RULES[a.ruleKey] || {}).label || a.ruleKey, level: a.level, total: 0, open: 0, ackMinutes: [] });
    const r = rules.get(a.ruleKey);
    r.total++;
    if (a.status === "OPEN") r.open++;

    const raised = Date.parse(a.raisedAt);
    const acked = Date.parse(a.acknowledgedAt);
    if (a.status === "ACKNOWLEDGED" && Number.isFinite(raised) && Number.isFinite(acked) && acked >= raised) {
      const min = (acked - raised) / 60000;
      ackMinutes.push(min);
      r.ackMinutes.push(min);
      if (a.acknowledgedBy) {
        if (!people.has(a.acknowledgedBy)) people.set(a.acknowledgedBy, { employeeId: a.acknowledgedBy, minutes: [], remarks: 0 });
        people.get(a.acknowledgedBy).minutes.push(min);
      }
    }
    if (!events && a.remark && a.remarkBy) {
      if (!people.has(a.remarkBy)) people.set(a.remarkBy, { employeeId: a.remarkBy, minutes: [], remarks: 0 });
      people.get(a.remarkBy).remarks++;
    }

    const station = a.station || (a.detail && a.detail.station);
    if (station) stations.set(station, (stations.get(station) || 0) + 1);
  }

  // History: every remark save counts for its author (not just the one still standing), plus undo / growth.
  let history = null;
  if (events) {
    const ids = new Map(inPeriod.map((a) => [a.id, a]));
    const firstRemark = new Map();
    const grew = new Set();
    let remarksSaved = 0, remarksUndone = 0;
    for (const e of events) {
      const a = ids.get(e.alertId);
      if (!a) continue;
      if (e.kind === "UPDATED") grew.add(e.alertId);
      if (e.kind === "REMARK_UNDONE") remarksUndone++;
      if (e.kind !== "REMARK") continue;
      remarksSaved++;
      if (!firstRemark.has(e.alertId)) firstRemark.set(e.alertId, Date.parse(e.at));
      if (e.actor) {
        if (!people.has(e.actor)) people.set(e.actor, { employeeId: e.actor, minutes: [], remarks: 0 });
        people.get(e.actor).remarks++;
      }
    }
    const toRemark = [];
    for (const [id, at] of firstRemark) {
      const raised = Date.parse(ids.get(id).raisedAt);
      if (Number.isFinite(raised) && Number.isFinite(at) && at >= raised) toRemark.push((at - raised) / 60000);
    }
    history = { remarksSaved, remarksUndone, grew: grew.size, firstRemark: ackStats(toRemark) };
  }

  // Per-day series from the rollup when it is available (same days, same alerts - just pre-aggregated).
  if (daily) {
    for (const d of days.values()) { d.GLOBAL = 0; d.NORMAL = 0; }
    for (const r of daily) {
      const d = days.get(r.day);
      if (d) d[r.level === "GLOBAL" ? "GLOBAL" : "NORMAL"] += r.raised;
    }
  }

  return {
    period: { since: new Date(sinceMs).toISOString(), until: new Date(nowMs).toISOString() },
    totals: {
      total: inPeriod.length,
      global: inPeriod.filter((a) => a.level === "GLOBAL").length,
      normal: inPeriod.filter((a) => a.level !== "GLOBAL").length,
      open,
      acknowledged,
      withRemark,
    },
    ack: ackStats(ackMinutes),
    history,
    dailySource: daily ? "rollup" : "alerts",
    byDay: [...days.values()],
    byHour: hours,
    byRule: [...rules.values()].map(({ ackMinutes: m, ...r }) => ({ ...r, ack: ackStats(m) })).sort((x, y) => y.total - x.total),
    byPerson: [...people.values()].map((p) => ({ employeeId: p.employeeId, acknowledged: p.minutes.length, remarks: p.remarks, ack: ackStats(p.minutes) })).sort((x, y) => y.acknowledged - x.acknowledged || y.remarks - x.remarks),
    byStation: [...stations].map(([station, count]) => ({ station, count })).sort((x, y) => y.count - x.count).slice(0, 15),
  };
}

module.exports = { summarize, percentile };
