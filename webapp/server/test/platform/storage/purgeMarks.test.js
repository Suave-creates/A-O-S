const test = require("node:test");
const assert = require("node:assert/strict");
const { createPurgeMarks } = require("../../../platform/storage/purgeMarks");

// A tiny in-memory purge_pulls table that understands only the statements the store issues.
function fakeDb() {
  const rows = [];
  return {
    rows,
    async execute(sql, p) {
      if (/^INSERT/.test(sql)) { for (let i = 0; i < p.length; i += 4) rows.push({ id: rows.length + 1, tote_id: p[i], pulled_at: p[i + 1], session_id: p[i + 2], status: "PENDING", pull_done_at: null, snapshot_at: null, baseline_qty: null, baseline_skus: null, purged_at: null }); }
      else if (/SET pull_done_at/.test(sql)) rows.filter((r) => r.session_id === p[1] && !r.pull_done_at).forEach((r) => { r.pull_done_at = p[0]; });
      else if (/SET snapshot_at/.test(sql)) Object.assign(rows.find((r) => r.id === p[3]), { snapshot_at: p[0], baseline_qty: p[1], baseline_skus: p[2] });
      else if (/SET status/.test(sql)) Object.assign(rows.find((r) => r.id === p[2]), { status: p[0], purged_at: p[1] });
    },
    async query(sql, [since]) {
      if (/status = 'PURGED'/.test(sql)) return rows.filter((r) => r.status === "PURGED" && r.pulled_at >= since);
      return rows.filter((r) => r.status === "PENDING" && r.pull_done_at && r.pulled_at >= since);
    },
  };
}

test("record stores base tote ids once each; nothing is watched until the calling is done, nothing is Purged until decided", async () => {
  const t = Date.UTC(2026, 9, 15, 4, 0, 0);
  const marks = createPurgeMarks({ db: fakeDb(), now: () => t });
  assert.equal(await marks.record(["TL0000000001-2", "TL0000000001", "ts0000000002"], { sessionId: "S1" }), 2);
  assert.deepEqual(await marks.loadOpen(), []);
  await marks.markSessionDone("S1");
  const open = await marks.loadOpen();
  assert.deepEqual(open.map((o) => o.tote).sort(), ["TL0000000001", "TS0000000002"]);
  assert.equal(open[0].baselineQty, null);
  assert.deepEqual(await marks.loadRecent(), {});
});

test("baseline is stored with its PIDs; PURGED exposes the pull..purged window; other statuses never count", async () => {
  let t = Date.UTC(2026, 9, 15, 4, 0, 0);
  const marks = createPurgeMarks({ db: fakeDb(), now: () => t });
  await marks.record(["TL0000000001", "TL0000000002"], { sessionId: "S1" });
  await marks.markSessionDone("S1");
  const [a, b] = await marks.loadOpen();
  await marks.setBaseline(a.id, 7, ["111", "222"]);
  assert.deepEqual((await marks.loadOpen()).find((o) => o.id === a.id).baselineSkus, ["111", "222"]);
  t += 3600000;
  await marks.setStatus(a.id, "PURGED");
  await marks.setStatus(b.id, "RESTOCKED");
  const got = await marks.loadRecent();
  assert.deepEqual(Object.keys(got), ["TL0000000001"]);
  assert.equal(got.TL0000000001.from, Date.UTC(2026, 9, 15, 4, 0, 0));
  assert.equal(got.TL0000000001.to, t);
  assert.deepEqual(await marks.loadOpen(), [], "decided pulls are no longer watched");
});

test("loadRecent never throws: a broken read means no totes are called Purged", async () => {
  const marks = createPurgeMarks({ db: { async query() { throw new Error("down"); } } });
  assert.deepEqual(await marks.loadRecent(), {});
});
