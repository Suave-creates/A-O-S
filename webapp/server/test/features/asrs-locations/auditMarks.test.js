const test = require("node:test");
const assert = require("node:assert/strict");
const auditMarks = require("../../../features/asrs-locations/auditMarks");

// A fake db that records what was asked of it.
function fakeDb(rows = []) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return rows; },
    execute: async (sql, params) => { calls.push({ sql, params }); return {}; },
  };
}

// 2026-11-03 10:00 IST and 05:00 IST (the latter still belongs to the previous site day)
const TEN_AM = Date.UTC(2026, 10, 3, 4, 30);
const FIVE_AM = Date.UTC(2026, 10, 2, 23, 30);

test("list reads only the current site day (06:00 IST boundary)", async () => {
  const db = fakeDb([{ slotKey: "1-2-3-L-01", outcome: "EMPTY" }]);
  const r = await auditMarks.list({ db, now: TEN_AM });
  assert.equal(r.siteDay, "2026-11-03");
  assert.deepEqual(db.calls[0].params, ["2026-11-03"]);
  assert.equal(r.marks.length, 1);
  const early = await auditMarks.list({ db, now: FIVE_AM });
  assert.equal(early.siteDay, "2026-11-02");
});

test("mark upserts one row per distinct slot for today, with who and when", async () => {
  const db = fakeDb();
  const r = await auditMarks.mark({ slotKeys: ["1-2-3-L-01", "1-2-3-L-01", "6-24-113-R-02"], outcome: "EMPTY", userId: 7 }, { db, now: TEN_AM });
  assert.deepEqual(r, { siteDay: "2026-11-03", count: 2 });
  const { sql, params } = db.calls[0];
  assert.match(sql, /ON DUPLICATE KEY UPDATE/);
  assert.deepEqual(params.slice(0, 6), ["2026-11-03", "1-2-3-L-01", "EMPTY", null, 7, new Date(TEN_AM).toISOString()]);
});

test("a tote ID is kept only for TOTE_FOUND, upper-cased", async () => {
  const db = fakeDb();
  await auditMarks.mark({ slotKeys: ["1-2-3-L-01"], outcome: "TOTE_FOUND", toteId: " tl0000001234 ", userId: 1 }, { db, now: TEN_AM });
  assert.equal(db.calls[0].params[3], "TL0000001234");
  await auditMarks.mark({ slotKeys: ["1-2-3-L-01"], outcome: "EMPTY", toteId: "TL1", userId: 1 }, { db, now: TEN_AM });
  assert.equal(db.calls[1].params[3], null);
});

test("bad input is refused before touching the database", async () => {
  const db = fakeDb();
  assert.ok((await auditMarks.mark({ slotKeys: ["1-2-3-L-01"], outcome: "MAYBE", userId: 1 }, { db })).error);
  assert.ok((await auditMarks.mark({ slotKeys: [], outcome: "EMPTY", userId: 1 }, { db })).error);
  assert.ok((await auditMarks.mark({ slotKeys: ["7-1-1-L-01"], outcome: "EMPTY", userId: 1 }, { db })).error);
  assert.ok((await auditMarks.mark({ slotKeys: ["1-1-1-L-01'; DROP TABLE x"], outcome: "EMPTY", userId: 1 }, { db })).error);
  assert.ok((await auditMarks.clear({ slotKeys: new Array(auditMarks.MAX_BATCH + 1).fill("1-1-1-L-01") }, { db })).error);
  assert.equal(db.calls.length, 0);
});

test("clear deletes only today's rows for the given slots", async () => {
  const db = fakeDb();
  const r = await auditMarks.clear({ slotKeys: ["1-2-3-L-01", "1-2-3-R-02"] }, { db, now: TEN_AM });
  assert.equal(r.count, 2);
  assert.match(db.calls[0].sql, /DELETE FROM location_audit_marks WHERE site_day = \? AND slot_key IN \(\?, \?\)/);
  assert.deepEqual(db.calls[0].params, ["2026-11-03", "1-2-3-L-01", "1-2-3-R-02"]);
});
