// listRecentResults reads the small summary_json column (migration 0011); only
// pre-migration rows fall back to JSON_EXTRACT, and they are back-filled.

const test = require("node:test");
const assert = require("node:assert/strict");
const { listRecentResults, summaryOf } = require("../../../features/tote-utilisation/toteUtilisationJob");

const SUMMARY = [{ totes: 5, util: 0.4 }, { largeLens: { totes: 1 } }, 2, { scanned: 10 }, { largeLens: 300 }];

// The list query returns the rows; the legacy fallback is a separate per-row JSON_EXTRACT query.
function fakeDb(rows, legacyJson = null) {
  const executed = [];
  const queries = [];
  return {
    executed, queries,
    query: async (sql) => { queries.push(sql); return /JSON_EXTRACT/.test(sql) ? [{ legacyJson }] : rows; },
    execute: async (sql, params) => { executed.push({ sql, params }); },
  };
}

test("summaryOf: the array layout every reader relies on", () => {
  assert.deepEqual(summaryOf({ totals: 1, stats: 2, mixedCount: 3, pipeline: 4, caps: 5, detail: ["huge"] }), [1, 2, 3, 4, 5]);
});

test("rows with summary_json use it and never touch the big document", async () => {
  const db = fakeDb([{ queryId: "Q1", createdAt: "t", rowCount: 10, runBy: "A", summaryJson: JSON.stringify(SUMMARY) }]);
  const [r] = await listRecentResults({}, { db });
  assert.deepEqual(r.totals, SUMMARY[0]);
  assert.deepEqual(r.stats, SUMMARY[1]);
  assert.equal(r.mixedCount, 2);
  assert.deepEqual(r.caps, SUMMARY[4]);
  assert.equal(db.executed.length, 0, "no back-fill needed");
  assert.equal(db.queries.filter((q) => /JSON_EXTRACT/.test(q)).length, 0, "the big document is never parsed");
  assert.ok(!/result_json/.test(db.queries[0]), "the list query never touches the 5 MB column");
});

test("legacy rows (no summary) use the one-parse fallback and are back-filled", async () => {
  const db = fakeDb([{ queryId: "Q0", createdAt: "t", rowCount: 10, runBy: "A", summaryJson: null }], JSON.stringify(SUMMARY));
  const [r] = await listRecentResults({}, { db });
  assert.deepEqual(r.totals, SUMMARY[0]);
  await new Promise((res) => setImmediate(res));
  assert.equal(db.executed.length, 1);
  assert.match(db.executed[0].sql, /UPDATE tote_utilisation_results SET summary_json/);
  assert.deepEqual(db.executed[0].params, [JSON.stringify(SUMMARY), "Q0"]);
});

test("a back-fill failure never fails the read", async () => {
  const db = fakeDb([{ queryId: "Q0", createdAt: "t", rowCount: 1, runBy: "A", summaryJson: null }], JSON.stringify(SUMMARY));
  db.execute = async () => { throw new Error("readonly replica"); };
  const [r] = await listRecentResults({}, { db });
  assert.equal(r.queryId, "Q0");
});

test("history is site-wide for every user (no user_id filter)", async () => {
  let seen;
  const db = { query: async (sql, params) => { seen = { sql, params }; return []; }, execute: async () => {} };
  await listRecentResults({ limit: 5 }, { db });
  assert.doesNotMatch(seen.sql, /q\.user_id = \?/);
  assert.deepEqual(seen.params, [5]);
});
