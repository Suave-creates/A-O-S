// Incremental Grafana reads for the OPEN site day (operator decision 2026-11-04: "previous data doesn't change,
// so why re-read it each time?" - middle ground chosen over a plain cache):
//
//   - the last 60 minutes are re-read on every refresh: a slot (one hour, or one shift) counts as settled only
//     once it was read 60+ minutes after it ended, so a row that reaches GTP late is still picked up;
//   - older hours of the running shift come from this cache, but the whole running shift is read again when its
//     last full read is 30+ minutes old (late rows / edited rows heal within 30 min) - part of a normal refresh,
//     there is no timer here;
//   - 30 minutes after a shift ends it gets one final full read and is frozen for the rest of the day;
//   - hours that have not started are never asked for;
//   - a CLOSED day never comes from here: the 06:05 save reads it in full and that read is the day's final
//     tally (dashboardMetrics compares it with this cache and logs any difference).
//
// Slots are Grafana's own hour / shift windows, so a re-read replaces a slot whole - no row is ever merged or
// counted twice. Settled and frozen slots are stored in MySQL (platform/storage/liveDayCache.js) so a restart
// only costs the running shift's full read. A section name carries a version: change it when the stored value's
// meaning changes, and old slots are simply not read.

const defaultCapabilityManager = require("../capabilities/capabilityManager");
const { waitForTerminal } = require("../../platform/queries/queryPoll");
const { shiftWindowsForDate, hourWindowsForDate } = require("../../platform/time/shiftWindows");
const defaultStore = require("../../platform/storage/liveDayCache");

const SHIFT_KEYS = ["A", "B", "C"];
const RECENT_MS = 60 * 60 * 1000; // re-read on every refresh
const FULL_EVERY_MS = 30 * 60 * 1000; // whole running shift read again
const FINAL_AFTER_MS = 30 * 60 * 1000; // a finished shift's final read, then frozen
const KEEP_DAYS = 3;

// The slots of a site day: 24 hours ("A0".."C7") or 3 shifts ("A".."C").
function slotsFor(dateStr, perShift) {
  if (perShift) {
    const w = shiftWindowsForDate(dateStr);
    return SHIFT_KEYS.map((k) => ({ slot: k, shift: k, from: w[k].from, to: w[k].to }));
  }
  const h = hourWindowsForDate(dateStr);
  return SHIFT_KEYS.flatMap((k) => h[k].map((w, i) => ({ slot: `${k}${i}`, shift: k, index: i, from: w.from, to: w.to })));
}

// Pure: which slots this refresh reads from Grafana, which of them get frozen, which shifts get a full read.
function plan(slots, entries, shiftWindows, fullAt, now) {
  const read = new Set();
  const freeze = new Set();
  const full = [];
  for (const S of SHIFT_KEYS) {
    const started = slots.filter((s) => s.shift === S && s.from < now);
    if (!started.length) continue;
    const isFrozen = (s) => { const e = entries.get(s.slot); return !!(e && e.frozen); };
    if (now >= shiftWindows[S].to + FINAL_AFTER_MS) {
      for (const s of started) if (!isFrozen(s)) { read.add(s.slot); freeze.add(s.slot); }
      continue;
    }
    if (!fullAt[S] || now - fullAt[S] >= FULL_EVERY_MS) {
      started.forEach((s) => read.add(s.slot));
      full.push(S);
      continue;
    }
    for (const s of started) {
      const e = entries.get(s.slot);
      if (!e || (!e.frozen && e.readAt < s.to + RECENT_MS)) read.add(s.slot);
    }
  }
  return { read, freeze, full };
}

const states = new Map(); // `${date}|${section}` -> { entries, fullAt, loading, running }
let prunedFor = null;

function forgetOldDays(dateStr, store) {
  // keep today and the previous day in memory (the 06:05 tally compares against it), drop the rest
  const prev = new Date(Date.parse(dateStr + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
  for (const k of [...states.keys()]) { const d = k.split("|")[0]; if (d !== dateStr && d !== prev) states.delete(k); }
  if (prunedFor === dateStr) return;
  prunedFor = dateStr;
  const keepFrom = new Date(Date.parse(dateStr + "T00:00:00Z") - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  store.prune(keepFrom).catch(() => {});
}

async function stateFor(dateStr, section, store) {
  const key = `${dateStr}|${section}`;
  let st = states.get(key);
  if (!st) {
    st = { entries: new Map(), fullAt: {}, loading: null, running: null };
    states.set(key, st);
    forgetOldDays(dateStr, store);
    st.loading = store.load(dateStr, section).then((m) => { for (const [k, v] of m) if (!st.entries.has(k)) st.entries.set(k, v); }, () => {});
  }
  await st.loading;
  return st;
}

// One refresh of one section: reads what plan() asks for through fetch(slotsWithSkip) -> Map slot -> value,
// and returns Map slot -> value for every started slot (future slots are absent). Single-flight per section.
async function refreshSection({ dateStr, section, perShift, fetch, now = Date.now(), store = defaultStore }) {
  const st = await stateFor(dateStr, section, store);
  if (st.running) return st.running;
  st.running = (async () => {
    const slots = slotsFor(dateStr, perShift);
    const p = plan(slots, st.entries, shiftWindowsForDate(dateStr), st.fullAt, now);
    if (p.read.size) {
      const values = await fetch(slots.map((s) => ({ ...s, skip: !p.read.has(s.slot) })));
      for (const s of slots) {
        if (!p.read.has(s.slot)) continue;
        const entry = { value: values.get(s.slot), readAt: now, frozen: p.freeze.has(s.slot) };
        st.entries.set(s.slot, entry);
        if (entry.frozen || now >= s.to + RECENT_MS) store.save(dateStr, section, s.slot, entry).catch(() => {}); // best-effort
      }
      p.full.forEach((S) => { st.fullAt[S] = now; });
    }
    const out = new Map();
    for (const s of slots) if (s.from < now && st.entries.has(s.slot)) out.set(s.slot, st.entries.get(s.slot).value);
    return out;
  })().finally(() => { st.running = null; });
  return st.running;
}

// What the cache holds for a day without reading anything (memory, else stored slots), or null when a slot of
// the day is missing - used to compare with the final full read of a closed day.
async function peek(dateStr, section, perShift, { store = defaultStore } = {}) {
  const st = states.get(`${dateStr}|${section}`);
  const entries = st ? st.entries : await store.load(dateStr, section).catch(() => new Map());
  const out = new Map();
  for (const s of slotsFor(dateStr, perShift)) {
    if (!entries.has(s.slot)) return null;
    out.set(s.slot, entries.get(s.slot).value);
  }
  return out;
}

// ── Capability plumbing ─────────────────────────────────────────────────────
async function dispatch(user, capabilityName, params, deps = {}) {
  const cm = deps.capabilityManager || defaultCapabilityManager;
  const wait = deps.waitForTerminal || waitForTerminal;
  const d = await cm.requestCapability({ user, capabilityName, params });
  if (!d.ok) { const e = new Error(d.reason || `${capabilityName} dispatch failed`); e.code = d.code || 502; throw e; }
  const q = await wait(d.query.query_id);
  if (q.status !== "COMPLETED") { const e = new Error(`${capabilityName} ended in status ${q.status}${q.error ? `: ${q.error}` : ""}`); e.code = 502; throw e; }
  return cm.getResult(d.query.query_id);
}

// The value Grafana gave for a slot this refresh asked for - a missing one is an error, never a made-up 0.
function asked(value, s, capabilityName) {
  if (value === null || value === undefined) throw new Error(`${capabilityName} returned no value for ${s.slot}`);
  return value;
}

const hourWindowsOf = (slots) => {
  const hw = { A: [], B: [], C: [] };
  for (const s of slots) hw[s.shift][s.index] = { from: s.from, to: s.to, skip: s.skip };
  return hw;
};

// Cycle-count rows of the open day: { windows: {A:{discRows, stockRows}, B, C} } - same shape as a full read.
async function ccRows(user, dateStr, deps = {}) {
  const got = await refreshSection({
    dateStr, section: "cc:v1", perShift: false, now: deps.now, store: deps.store,
    fetch: async (slots) => {
      const r = await dispatch(user, "GET_GRAFANA_CC_METRICS", { hourWindows: hourWindowsOf(slots) }, deps);
      if (!r || !r.hours) throw new Error("GET_GRAFANA_CC_METRICS returned no hourly result");
      return new Map(slots.filter((s) => !s.skip).map((s) => [s.slot, asked(r.hours[s.shift][s.index], s, "GET_GRAFANA_CC_METRICS")]));
    },
  });
  return { windows: assembleRows(got) };
}
function assembleRows(got) {
  const windows = {};
  for (const S of SHIFT_KEYS) {
    const discRows = [];
    const stockRows = [];
    for (let i = 0; i < 8; i++) {
      const v = got.get(`${S}${i}`);
      if (!v) continue;
      discRows.push(...(v.discRows || []));
      stockRows.push(...(v.stockRows || []));
    }
    windows[S] = { discRows, stockRows };
  }
  return windows;
}

// An hourly count capability (ASRS Production): { hours: {A:[8], B, C} }, an hour not started yet is 0.
async function hourlyCounts(user, dateStr, capabilityName, deps = {}) {
  const got = await refreshSection({
    dateStr, section: `${capabilityName}:v1`, perShift: false, now: deps.now, store: deps.store,
    fetch: async (slots) => {
      const r = await dispatch(user, capabilityName, { hourWindows: hourWindowsOf(slots) }, deps);
      return new Map(slots.filter((s) => !s.skip).map((s) => [s.slot, Number(asked(r.hours[s.shift][s.index], s, capabilityName))]));
    },
  });
  return { hours: assembleCounts(got, false) };
}

// A per-shift count capability (Compaction, Tote Freed): { windows: {A, B, C} }, a shift not started yet is 0.
async function shiftCounts(user, dateStr, capabilityName, deps = {}) {
  const got = await refreshSection({
    dateStr, section: `${capabilityName}:v1`, perShift: true, now: deps.now, store: deps.store,
    fetch: async (slots) => {
      const windows = {};
      for (const s of slots) windows[s.shift] = { from: s.from, to: s.to, skip: s.skip };
      const r = await dispatch(user, capabilityName, { windows }, deps);
      return new Map(slots.filter((s) => !s.skip).map((s) => [s.slot, Number(asked(r.windows[s.shift], s, capabilityName))]));
    },
  });
  return { windows: assembleCounts(got, true) };
}
function assembleCounts(got, perShift) {
  const out = {};
  for (const S of SHIFT_KEYS) out[S] = perShift ? got.get(S) || 0 : Array.from({ length: 8 }, (_, i) => got.get(`${S}${i}`) || 0);
  return out;
}

function _resetForTests() { states.clear(); prunedFor = null; }

module.exports = {
  ccRows, hourlyCounts, shiftCounts, peek, assembleRows, assembleCounts,
  plan, slotsFor, refreshSection, RECENT_MS, FULL_EVERY_MS, FINAL_AFTER_MS, _resetForTests,
};
