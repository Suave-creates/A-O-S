const test = require("node:test");
const assert = require("node:assert/strict");
const auditLog = require("../../../platform/audit/auditLog");
const engine = require("../../../features/pull-logs/pullLogsEngine");

const row = (id, action, results, extra = {}) => ({
  id, action, employee_id: "E" + id, role: "USER", created_at: "2026-11-02T05:00:00.000Z",
  detail: JSON.stringify({ results, totalTotes: results.length, ...extra }),
});

// swap the two audit reads for the duration of one test
function stubAudit(t, { rows = [], counts = {} }) {
  const orig = { list: auditLog.listByActionsInRange, count: auditLog.countByActionsInRange };
  const calls = [];
  auditLog.listByActionsInRange = async (actions, opts) => { calls.push({ actions, opts }); return rows.slice(0, opts.limit); };
  auditLog.countByActionsInRange = async () => counts;
  t.after(() => { auditLog.listByActionsInRange = orig.list; auditLog.countByActionsInRange = orig.count; });
  return calls;
}

test("parseFilters reads IST days inclusive and narrows the actions by kind and outcome", () => {
  const f = engine.parseFilters({ from: "2026-11-01", to: "2026-11-03", kind: "MANUAL", status: "COMPLETED" });
  assert.equal(f.fromIso, "2026-10-31T18:30:00.000Z");
  assert.equal(f.toIso, "2026-11-03T18:30:00.000Z");
  assert.deepEqual(f.actions, ["TOTE_ENGINE_SESSION_COMPLETED"]);
});

test("parseFilters refuses bad, reversed and over-long ranges with a 400", () => {
  for (const q of [{ from: "03-11-2026" }, { from: "2026-11-03", to: "2026-11-01" }, { from: "2024-01-01", to: "2026-11-01" }]) {
    assert.throws(() => engine.parseFilters(q), (e) => e.code === 400);
  }
});

test("history pages by id and only sends the range totals with the first page", async (t) => {
  const rows = [3, 2, 1].map((id) => row(id, "AUTO_ENGINE_SESSION_COMPLETED", [{ toteId: "T" + id, verdict: "INSERTED" }]));
  const calls = stubAudit(t, { rows, counts: { AUTO_ENGINE_SESSION_COMPLETED: { sessions: 3, totes: 3 }, TOTE_ENGINE_SESSION_STOPPED: { sessions: 1, totes: 4 } } });

  const first = await engine.history({ from: "2026-11-02", limit: "2" }, {});
  assert.deepEqual(first.entries.map((e) => e.auditLogId), [3, 2]);
  assert.equal(first.nextBefore, 2);
  assert.deepEqual(first.summary, { sessions: 4, totes: 7, manual: { sessions: 1, totes: 4 }, auto: { sessions: 3, totes: 3 }, stopped: 1 });
  assert.equal(calls[0].opts.limit, 3); // one extra row tells whether there is another page

  const next = await engine.history({ from: "2026-11-02", limit: "2", before: "2" }, {});
  assert.equal(calls[1].opts.beforeId, 2);
  assert.equal(next.summary, undefined);
});

test("exportCsv writes one row per tote, quotes commas, and keeps sessions without tote detail", async (t) => {
  stubAudit(t, {
    rows: [
      row(2, "TOTE_ENGINE_SESSION_STOPPED", [{ toteId: "T1", verdict: "NOT_AVAILABLE", rawMessage: "busy, try later" }, { toteId: "T2", verdict: "INSERTED" }]),
      row(1, "AUTO_ENGINE_SESSION_COMPLETED", []),
    ],
  });
  const { csv, truncated } = await engine.exportCsv({ from: "2026-11-02" }, {});
  const lines = csv.split("\r\n");
  assert.equal(truncated, false);
  assert.equal(lines.length, 4); // head + 2 totes + 1 empty session
  assert.match(lines[1], /^2026-11-02,10:30:00,MANUAL,STOPPED,E2,.*,T1,.*,NOT_AVAILABLE,"busy, try later"$/);
  assert.match(lines[3], /^2026-11-02,10:30:00,AUTO,COMPLETED,E1,/);
});
