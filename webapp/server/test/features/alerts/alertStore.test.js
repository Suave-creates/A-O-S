// Store + engine behaviour with an in-memory fake of the `alerts` table (no MySQL).

const test = require("node:test");
const assert = require("node:assert/strict");
const { createStore } = require("../../../features/alerts/alertStore");
const { createEngine } = require("../../../features/alerts/alertEngine");

function fakeDb() {
  const rows = [];
  let nextId = 1;
  const db = {
    rows,
    events: [],
    settings: [],
    async query(sql, params = []) {
      if (/WHERE dedupe_key = \?/.test(sql)) return rows.filter((r) => r.dedupe_key === params[0]).slice(0, 1).map((r) => ({ ...r }));
      if (/FROM alert_events WHERE alert_id = \?/.test(sql)) return db.events.filter((e) => e.alert_id === Number(params[0])).map((e) => ({ ...e }));
      if (/WHERE id = \?/.test(sql)) return rows.filter((r) => r.id === Number(params[0])).map((r) => ({ ...r }));
      if (/FROM alert_rule_settings/.test(sql)) return db.settings.map((r) => ({ ...r }));
      if (/FROM alerts/.test(sql)) {
        const limit = params[params.length - 1];
        const since = /event_at >= \?/.test(sql) ? params[0] : null;
        return rows
          .filter((r) => !since || r.event_at >= since)
          .sort((a, b) => (b.status === "OPEN") - (a.status === "OPEN") || (a.raised_at < b.raised_at ? 1 : -1))
          .slice(0, limit)
          .map((r) => ({ ...r }));
      }
      throw new Error("unexpected query: " + sql);
    },
    async execute(sql, params = []) {
      if (/^INSERT INTO alerts/.test(sql)) {
        if (rows.some((r) => r.dedupe_key === params[2])) throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
        const [rule_key, level, dedupe_key, title, detail, event_at, raised_at, updated_at, station, tote, metric, threshold] = params;
        const row = { id: nextId++, rule_key, level, dedupe_key, title, detail, event_at, raised_at, updated_at, station, tote, metric, threshold, status: "OPEN", acknowledged_by: null, acknowledged_at: null, remark: null, remark_by: null, remark_at: null, remark_prev: null, remark_prev_by: null, remark_prev_at: null, undo_ok: 0 };
        rows.push(row);
        return { insertId: row.id, affectedRows: 1 };
      }
      if (/INSERT INTO alert_rule_settings/.test(sql)) {
        const [rule_key, enabled, threshold, updated_by, updated_at] = params;
        db.settings = db.settings.filter((r) => r.rule_key !== rule_key).concat({ rule_key, enabled, threshold, updated_by, updated_at });
        return { affectedRows: 1 };
      }
      if (/INSERT INTO alert_events/.test(sql)) {
        const [alert_id, kind, at, actor, metric, note] = params;
        db.events.push({ alert_id, kind, at, actor, metric, note });
        return { affectedRows: 1 };
      }
      if (/SET title = \?, detail = \?/.test(sql)) {
        const r = rows.find((x) => x.id === params[7]);
        Object.assign(r, { title: params[0], detail: params[1], station: params[2], tote: params[3], metric: params[4], threshold: params[5], updated_at: params[6] });
        return { affectedRows: 1 };
      }
      if (/SET status = 'ACKNOWLEDGED'/.test(sql)) {
        const r = rows.find((x) => x.id === params[3] && x.status === "OPEN");
        if (r) { r.status = "ACKNOWLEDGED"; r.acknowledged_by = params[0]; r.acknowledged_at = params[1]; r.updated_at = params[2]; }
        return { affectedRows: r ? 1 : 0 };
      }
      if (/remark_prev = remark,/.test(sql)) {
        const r = rows.find((x) => x.id === params[4]);
        if (!r) return { affectedRows: 0 };
        Object.assign(r, { remark_prev: r.remark, remark_prev_by: r.remark_by, remark_prev_at: r.remark_at, undo_ok: 1, remark: params[0], remark_by: params[1], remark_at: params[2], updated_at: params[3] });
        return { affectedRows: 1 };
      }
      if (/SET remark = remark_prev/.test(sql)) {
        const r = rows.find((x) => x.id === params[1] && x.undo_ok === 1);
        if (r) Object.assign(r, { remark: r.remark_prev, remark_by: r.remark_prev_by, remark_at: r.remark_prev_at, remark_prev: null, remark_prev_by: null, remark_prev_at: null, undo_ok: 0, updated_at: params[0] });
        return { affectedRows: r ? 1 : 0 };
      }
      throw new Error("unexpected execute: " + sql);
    },
  };
  return db;
}

let clock = 0;
const tick = () => new Date(Date.UTC(2026, 9, 13, 9, 0, clock++)).toISOString();
const EV = (over = {}) => ({ ruleKey: "G1_TOTE_SHORT_QTY", level: "GLOBAL", dedupeKey: "k1", title: "Tote A: 30 units marked short", detail: { shortQty: 30 }, eventAt: "2026-10-13T08:00:00.000Z", ...over });

test("a new event is raised OPEN once; the same event again creates nothing", async () => {
  const store = createStore({ db: fakeDb(), now: tick });
  const first = await store.upsertEvent(EV());
  assert.equal(first.created, true);
  assert.equal(first.alert.status, "OPEN");
  assert.deepEqual(first.alert.detail, { shortQty: 30 });
  const second = await store.upsertEvent(EV());
  assert.equal(second.created, false);
  assert.equal((await store.listRecent()).length, 1);
});

test("a growing event (e.g. a station's count) refreshes title/detail but keeps status, acknowledgement and remark", async () => {
  const store = createStore({ db: fakeDb(), now: tick });
  const { alert } = await store.upsertEvent(EV({ ruleKey: "G2_STATION_SHORT_TOTES", dedupeKey: "g2", title: "Station GS7: 9 short totes", detail: { count: 9 } }));
  await store.acknowledge(alert.id, "EMP001");
  await store.setRemark(alert.id, "checked with the lead", "EMP001");
  const grown = await store.upsertEvent(EV({ ruleKey: "G2_STATION_SHORT_TOTES", dedupeKey: "g2", title: "Station GS7: 12 short totes", detail: { count: 12 } }));
  assert.equal(grown.created, false);
  const now = await store.get(alert.id);
  assert.equal(now.title, "Station GS7: 12 short totes");
  assert.equal(now.detail.count, 12);
  assert.equal(now.status, "ACKNOWLEDGED", "growing never re-opens an acknowledged alert");
  assert.equal(now.remark, "checked with the lead");
});

test("acknowledge: the first acknowledgement wins and records who/when; a second is a no-op", async () => {
  const store = createStore({ db: fakeDb(), now: tick });
  const { alert } = await store.upsertEvent(EV());
  const a = await store.acknowledge(alert.id, "EMP001");
  assert.equal(a.status, "ACKNOWLEDGED");
  assert.equal(a.acknowledgedBy, "EMP001");
  const b = await store.acknowledge(alert.id, "EMP002");
  assert.equal(b.acknowledgedBy, "EMP001", "the first person keeps it");
});

test("remark: stores text with who/when; the latest save can be undone exactly once", async () => {
  const store = createStore({ db: fakeDb(), now: tick });
  const { alert } = await store.upsertEvent(EV());
  const r1 = await store.setRemark(alert.id, "first", "EMP001");
  assert.deepEqual([r1.remark, r1.remarkBy, r1.undoAvailable], ["first", "EMP001", true]);
  const u1 = await store.undoRemark(alert.id);
  assert.deepEqual([u1.remark, u1.remarkBy, u1.undoAvailable], [null, null, false]);
  const u2 = await store.undoRemark(alert.id); // second undo is a no-op
  assert.equal(u2.remark, null);
});

test("undo returns to the remark that was there before the latest save", async () => {
  const store = createStore({ db: fakeDb(), now: tick });
  const { alert } = await store.upsertEvent(EV());
  await store.setRemark(alert.id, "first", "EMP001");
  await store.setRemark(alert.id, "second", "EMP002");
  const u = await store.undoRemark(alert.id);
  assert.deepEqual([u.remark, u.remarkBy], ["first", "EMP001"]);
  assert.equal(u.undoAvailable, false, "only one undo");
});

test("listRecent puts OPEN alerts first, then newest; acknowledged history older than the window drops off", async () => {
  const db = fakeDb();
  const store = createStore({ db, now: tick });
  const a = await store.upsertEvent(EV({ dedupeKey: "a", title: "A" }));
  await store.upsertEvent(EV({ dedupeKey: "b", title: "B" }));
  await store.acknowledge(a.alert.id, "EMP001");
  const list = await store.listRecent();
  assert.deepEqual(list.map((x) => x.title), ["B", "A"], "open first");
  db.rows.find((r) => r.title === "A").event_at = "2020-01-01T00:00:00.000Z";
  const windowed = await store.listRecent({ sinceIso: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(windowed.map((x) => x.title), ["B"]);
});

test("a duplicate-key race on insert is treated as 'already raised', not an error", async () => {
  const db = fakeDb();
  const realQuery = db.query;
  let first = true;
  db.query = async (sql, p) => { if (first && /dedupe_key = \?/.test(sql)) { first = false; return []; } return realQuery(sql, p); };
  const store = createStore({ db, now: tick });
  await store.upsertEvent(EV()); // inserts normally
  first = true; // pretend the existence check missed it
  const r = await store.upsertEvent(EV());
  assert.equal(r.created, false);
});

// ── engine ────────────────────────────────────────────────────────────────

test("engine: evaluates rules, persists events, and reports only the NEWLY raised ones (so the UI notifies once)", async () => {
  const store = createStore({ db: fakeDb(), now: tick });
  const now = Date.UTC(2026, 9, 13, 9, 30);
  const engine = createEngine({ store, startAt: "", now: () => now, defaults: { G1_TOTE_SHORT_QTY: 25, G2_STATION_SHORT_TOTES: 8, lookbackHours: 4 } });
  const rows = [{ container: "TL0000000001", station: "GS1", resultType: "SHORT", quantity: 30, createTime: "2026-10-13 14:00:00.000" }];
  const first = await engine.evaluate(rows);
  assert.equal(first.raised.length, 1);
  assert.equal(first.raised[0].ruleKey, "G1_TOTE_SHORT_QTY");
  const second = await engine.evaluate(rows);
  assert.equal(second.events.length, 1);
  assert.equal(second.raised.length, 0, "already known: nothing new to notify");
});

test("engine: an admin-edited limit replaces the default, and a disabled rule raises nothing", async () => {
  const db = fakeDb();
  const store = createStore({ db, now: tick });
  const now = Date.UTC(2026, 9, 13, 9, 30);
  const engine = createEngine({ store, startAt: "", now: () => now, defaults: { G1_TOTE_SHORT_QTY: 25, G2_STATION_SHORT_TOTES: 8, lookbackHours: 4 } });
  const rows = [{ container: "TL0000000001", station: "GS1", resultType: "SHORT", quantity: 30, createTime: "2026-10-13 14:00:00.000" }];
  await store.saveRuleSetting("G1_TOTE_SHORT_QTY", { enabled: true, threshold: 40 }, "EMP001");
  assert.equal((await engine.evaluate(rows)).events.length, 0, "30 units is not more than the new limit of 40");
  await store.saveRuleSetting("G1_TOTE_SHORT_QTY", { enabled: true, threshold: 10 }, "EMP001");
  assert.equal((await engine.evaluate(rows)).events.length, 1, "lowered to 10 -> raised");
  await store.saveRuleSetting("G1_TOTE_SHORT_QTY", { enabled: false, threshold: 10 }, "EMP001");
  assert.equal((await engine.evaluate(rows)).events.length, 0, "disabled");
  const s = await engine.settings();
  assert.deepEqual(s.rules.map((r) => [r.key, r.enabled, r.threshold, r.default]), [["G1_TOTE_SHORT_QTY", false, 10, 25], ["G2_STATION_SHORT_TOTES", true, 8, 8]]);
});

// ── history + searchable columns (migration 0020) ─────────────────────────

test("searchable columns: station / tote / the rule's figure / the limit are copied out of detail", async () => {
  const store = createStore({ db: fakeDb(), now: tick });
  const { alert } = await store.upsertEvent(EV({ detail: { tote: "TL1", station: "GS1", shortQty: 30, threshold: 25 } }));
  assert.deepEqual([alert.station, alert.tote, alert.metric, alert.threshold], ["GS1", "TL1", 30, 25]);
  const g2 = await store.upsertEvent(EV({ ruleKey: "G2_STATION_SHORT_TOTES", dedupeKey: "g2", detail: { station: "GS7", count: 9, threshold: 8 } }));
  assert.deepEqual([g2.alert.station, g2.alert.tote, g2.alert.metric], ["GS7", null, 9], "G2's figure is its tote count");
});

test("history: raise, growth, acknowledge, remark and undo are each recorded once with who and when", async () => {
  const store = createStore({ db: fakeDb(), now: tick });
  const { alert } = await store.upsertEvent(EV({ ruleKey: "G2_STATION_SHORT_TOTES", dedupeKey: "g2", detail: { station: "GS7", count: 9 } }));
  await store.upsertEvent(EV({ ruleKey: "G2_STATION_SHORT_TOTES", dedupeKey: "g2", detail: { station: "GS7", count: 9 } })); // unchanged: no history
  await store.upsertEvent(EV({ ruleKey: "G2_STATION_SHORT_TOTES", dedupeKey: "g2", title: "grew", detail: { station: "GS7", count: 12 } }));
  await store.acknowledge(alert.id, "EMP001");
  await store.acknowledge(alert.id, "EMP002"); // no-op: not recorded
  await store.setRemark(alert.id, "recount done", "EMP003");
  await store.undoRemark(alert.id, "EMP003");
  await store.undoRemark(alert.id, "EMP003"); // no-op: not recorded
  const h = await store.history(alert.id);
  assert.deepEqual(h.map((e) => [e.kind, e.actor, e.metric, e.note]), [
    ["RAISED", null, 9, null],
    ["UPDATED", null, 12, null],
    ["ACKNOWLEDGED", "EMP001", null, null],
    ["REMARK", "EMP003", null, "recount done"],
    ["REMARK_UNDONE", "EMP003", null, null],
  ]);
});

test("a failed history write never fails the alert action", async () => {
  const db = fakeDb();
  const realExecute = db.execute;
  db.execute = async (sql, p) => { if (/alert_events/.test(sql)) throw new Error("table missing"); return realExecute(sql, p); };
  const store = createStore({ db, now: tick });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { created, alert } = await store.upsertEvent(EV());
    assert.equal(created, true);
    assert.equal((await store.acknowledge(alert.id, "EMP001")).status, "ACKNOWLEDGED");
  } finally {
    console.warn = warn;
  }
});
