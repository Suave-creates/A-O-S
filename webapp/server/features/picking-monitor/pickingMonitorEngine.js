// Picking Monitor: turns per-station "items picked" counts into what the screen shows. Pure - no I/O - so the
// maths is unit-tested without Grafana. The counts come from the WES "Items picked by station" query
// (integrations/grafana/grafanaPickingStations.js) through the live feed (server/live/pickingFeeds.js):
//   hours[]  the site day's 24 hours, each with its per-station counts (null = future / not read)
//   cur      per-station counts for the rolling window ending now
//   prev     the same for the window before it (what "vs previous" compares with)
//
// Station facts (type, operation, priority weight, logged in) come from the GTP station config; the queue and
// slots from the PTL snapshot. Either may be missing (null) - the monitor then shows picks only and says so.
//
// Honest by construction: a future hour is null, never 0; there is no target because none is defined, so a
// station is judged against its own previous window and against its peers, not against an invented goal.

const health = require("./stationHealth");

const SHIFTS = ["A", "B", "C"];
// An hour needs this many minutes of data before a full-hour projection means anything.
const MIN_PROJECTION_MIN = 10;
// Within this band of the day's average hour the pace reads as steady.
const STEADY_BAND = 0.1;
// A station picking below this share of the median active station (and at least MIN_PEERS active) is "slow".
const SLOW_SHARE = 0.5;
const MIN_PEERS = 4;

const sum = (arr) => arr.reduce((s, v) => s + v, 0);
const itemsOf = (list) => (Array.isArray(list) ? list : null);
const pct = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// hours: [{ shift, label, from, to, status: "closed"|"current"|"future", stations: [{station, items}] | null }]
function buildPickingMonitor({ siteDay, filters, hours: allHours, cur, prev, windowMin, now = Date.now(), config = null, ptl = null, stationFilter = {}, loadCur }) {
  if (!Array.isArray(allHours)) throw new Error("buildPickingMonitor needs the day's hours");
  if (!itemsOf(cur)) throw new Error("buildPickingMonitor needs the current window's counts");

  const cfgMap = new Map((config || []).map((c) => [c.id, c]));
  const ptlMap = new Map((ptl || []).map((q) => [q.station, q]));
  const wantType = stationFilter.stationType && stationFilter.stationType !== "ALL" ? stationFilter.stationType : null;
  const wantClass = stationFilter.stationPriority && stationFilter.stationPriority !== "ALL" ? stationFilter.stationPriority : null;
  // A station filter needs the station's facts; with no config it can't be answered, so nothing matches.
  const allowed = (id) => {
    if (!wantType && !wantClass) return true;
    const c = cfgMap.get(id);
    return !!c && (!wantType || c.type === wantType) && (!wantClass || health.priorityClass(c.priorityWeight) === wantClass);
  };
  const only = (list) => (Array.isArray(list) ? list.filter((r) => allowed(r.station)) : null);
  // Capacity is a station's whole load against its design capacity, so it counts EVERY order type/priority in the
  // window - not just the ones the order filters kept. undefined = the filters are ALL/ALL, so cur already is that;
  // null = the unfiltered read is unavailable, so nobody is judged rather than judged on a partial count.
  const loadMap = loadCur === null ? null : new Map((loadCur === undefined ? cur : loadCur).map((r) => [r.station, r.items]));
  const hours = allHours.map((h) => ({ ...h, stations: only(h.stations) }));
  const curList = only(cur);
  const prevList = only(prev);

  // Per-hour totals and a station x hour matrix.
  const stationHours = new Map(); // station -> (number|null)[24]
  const hourRows = hours.map((h, i) => {
    const list = itemsOf(h.stations);
    if (list) {
      for (const r of list) {
        if (!stationHours.has(r.station)) stationHours.set(r.station, new Array(hours.length).fill(null));
        stationHours.get(r.station)[i] = (stationHours.get(r.station)[i] || 0) + r.items;
      }
    }
    return { shift: h.shift, label: h.label, from: h.from, to: h.to, status: h.status, total: list ? sum(list.map((r) => r.items)) : null };
  });
  // A station with no row in a read hour picked nothing in it: that is a real 0, but only for hours that were read.
  for (const arr of stationHours.values()) hourRows.forEach((h, i) => { if (h.total != null && arr[i] == null) arr[i] = 0; });

  const reached = hourRows.filter((h) => h.total != null);
  const closed = reached.filter((h) => h.status === "closed");
  const current = hourRows.find((h) => h.status === "current" && h.total != null) || null;

  const curMap = new Map(curList.map((r) => [r.station, r.items]));
  const prevMap = new Map((prevList || []).map((r) => [r.station, r.items]));
  const ids = new Set([...stationHours.keys(), ...curMap.keys(), ...prevMap.keys()]);
  // A logged-in picking station that has not picked anything is exactly what a supervisor needs to see.
  for (const c of cfgMap.values()) if (health.isPicking(c) && allowed(c.id)) ids.add(c.id);

  const totalCur = sum([...curMap.values()]);
  const totalPrev = prevList ? sum([...prevMap.values()]) : null;
  const activeVals = [...curMap.values()].filter((v) => v > 0);
  const med = activeVals.length >= MIN_PEERS ? median(activeVals) : 0;

  const stations = [...ids].map((id) => {
    const hoursArr = stationHours.get(id) || new Array(hours.length).fill(null);
    const today = sum(hoursArr.filter((v) => v != null));
    const picks = curMap.get(id) || 0;
    const before = prevList ? prevMap.get(id) || 0 : null;
    let state = "ok";
    if (picks === 0 && today > 0) state = "idle"; // worked earlier today, nothing in this window
    else if (med > 0 && picks > 0 && picks < med * SLOW_SHARE) state = "slow";
    const cfg = cfgMap.get(id);
    const load = loadMap ? loadMap.get(id) || 0 : null;
    const a = load == null ? { ...health.assess(cfg, 0, windowMin), ratePerHour: null, pct: null, health: null } : health.assess(cfg, load, windowMin);
    const q = ptlMap.get(id) || null;
    return {
      id, type: cfg ? cfg.type : null, operationType: cfg ? cfg.operationType : null, userId: cfg ? cfg.userId : null,
      loggedIn: cfg ? cfg.loggedIn : null, priorityClass: a.klass, ratePerHour: a.ratePerHour, capacityPct: a.pct, health: a.health,
      queuedItems: q ? q.queuedItems : null, queuedLines: q ? q.queuedLines : null, slots: q ? q.slots : null,
      picking: a.picking, picks, prev: before, delta: before == null ? null : picks - before, deltaPct: before == null ? null : pct(picks, before),
      today, share: totalCur > 0 ? Math.round((picks / totalCur) * 1000) / 10 : 0, state, hours: hoursArr,
    };
  }).filter((s) => s.picks > 0 || s.today > 0 || (s.prev || 0) > 0 || s.picking)
    .sort((a, b) => b.picks - a.picks || b.today - a.today || a.id.localeCompare(b.id));
  stations.forEach((s, i) => { s.rank = i + 1; });

  const totals = {
    window: totalCur,
    prev: totalPrev,
    deltaPct: totalPrev == null ? null : pct(totalCur, totalPrev),
    today: sum(reached.map((h) => h.total)),
    stationsActive: stations.filter((s) => s.picks > 0).length,
    stationsSeen: stations.length,
    idle: stations.filter((s) => s.state === "idle").map((s) => s.id),
    slow: stations.filter((s) => s.state === "slow").map((s) => s.id),
    peerMedian: med > 0 ? Math.round(med) : null, // null while there are too few active stations to compare
  };

  // Capacity: only stations that are picking and have a priority class we can judge get a colour.
  const judged = stations.filter((s) => s.health);
  const capacity = {
    designPerHour: health.DESIGN_CAPACITY_PER_HOUR,
    judged: judged.length,
    green: judged.filter((s) => s.health === "green").length,
    yellow: judged.filter((s) => s.health === "yellow").length,
    red: judged.filter((s) => s.health === "red").length,
    check: stations.filter((s) => s.picking && s.priorityClass === "CHECK").map((s) => s.id),
    utilisationPct: judged.length ? Math.round((judged.reduce((t, s) => t + s.ratePerHour, 0) / (judged.length * health.DESIGN_CAPACITY_PER_HOUR)) * 100) : null,
  };
  const queue = ptl ? { items: ptl.reduce((t, q) => t + q.queuedItems, 0), slots: ptl.reduce((t, q) => t + q.slots, 0) } : null;

  const shifts = {};
  for (const k of SHIFTS) {
    const mine = reached.filter((h) => h.shift === k);
    const mineClosed = mine.filter((h) => h.status === "closed");
    shifts[k] = {
      total: sum(mine.map((h) => h.total)),
      hours: mine.length,
      // Whole hours only: the running hour is partial and would drag the rate down.
      perHour: mineClosed.length ? Math.round(sum(mineClosed.map((h) => h.total)) / mineClosed.length) : null,
    };
  }

  const avgPerHour = closed.length ? sum(closed.map((h) => h.total)) / closed.length : null;
  const peakHour = closed.length ? closed.reduce((best, h) => (h.total > best.total ? h : best)) : null;
  const lastClosed = closed.length ? closed[closed.length - 1] : null;

  let pace = null;
  if (current) {
    const elapsedMin = Math.max(0, Math.min(60, (now - current.from) / 60000));
    const projected = elapsedMin >= MIN_PROJECTION_MIN ? Math.round((current.total / elapsedMin) * 60) : null;
    let state = "building"; // too early in the hour to say
    let vsAvgPct = null;
    if (projected != null && avgPerHour) {
      vsAvgPct = Math.round(((projected - avgPerHour) / avgPerHour) * 100);
      const ratio = projected / avgPerHour;
      state = ratio >= 1 + STEADY_BAND ? "ahead" : ratio <= 1 - STEADY_BAND ? "behind" : "steady";
    } else if (projected != null) {
      state = "steady";
    }
    pace = {
      label: current.label, shift: current.shift, soFar: current.total, elapsedMin: Math.round(elapsedMin), projected,
      avgPerHour: avgPerHour == null ? null : Math.round(avgPerHour), vsAvgPct, state,
    };
  }

  return {
    siteDay,
    since: "06:00 IST",
    filters: { ...filters, stationType: wantType || "ALL", stationPriority: wantClass || "ALL" },
    configAvailable: !!config,
    queueAvailable: !!ptl,
    stationTypes: config ? [...new Set(config.map((c) => c.type))].sort() : [],
    capacity,
    queue,
    windowMin,
    hours: hourRows,
    stations,
    totals,
    shifts,
    avgPerHour: avgPerHour == null ? null : Math.round(avgPerHour),
    peak: peakHour ? { label: peakHour.label, shift: peakHour.shift, total: peakHour.total } : null,
    lastClosed: lastClosed ? { label: lastClosed.label, shift: lastClosed.shift, total: lastClosed.total } : null,
    pace,
    hoursReached: reached.length,
  };
}

module.exports = { buildPickingMonitor, MIN_PROJECTION_MIN, STEADY_BAND, SLOW_SHARE, MIN_PEERS };
