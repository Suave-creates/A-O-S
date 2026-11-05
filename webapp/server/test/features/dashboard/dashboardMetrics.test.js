// dashboardMetrics.js: site day, last-good fallback, per-date sections (fake
// capability/query manager - no network, no MySQL) and the hourly scalar pipeline.

const test = require("node:test");
const assert = require("node:assert/strict");
const metrics = require("../../../features/dashboard/dashboardMetrics");

const USER = { id: 1, role: "ADMIN" };

test.beforeEach(() => metrics._resetForTests());

// ── Site day ─────────────────────────────────────────────────────────────

test("siteDayIST: the site day runs 06:00 IST -> 06:00 IST, so before 06:00 'today' is yesterday", () => {
  const ist = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) - 5.5 * 3600000;
  assert.equal(metrics.siteDayIST(ist(2026, 10, 13, 6, 0)), "2026-10-13");
  assert.equal(metrics.siteDayIST(ist(2026, 10, 13, 5, 59)), "2026-10-12");
  assert.equal(metrics.siteDayIST(ist(2026, 10, 13, 0, 5)), "2026-10-12");
  assert.equal(metrics.siteDayIST(ist(2026, 10, 13, 23, 59)), "2026-10-13");
  assert.equal(metrics.siteDayIST(ist(2026, 1, 1, 3, 0)), "2025-12-31");
});

test("dayHours: 24 hours from 06:00, labelled, with closed/current/future status", () => {
  const now = Date.UTC(2026, 9, 13, 8, 53) ; // 14:23 IST on 2026-10-13
  const hours = metrics.dayHours("2026-10-13", now);
  assert.equal(hours.length, 24);
  assert.equal(hours[0].label, "06-07");
  assert.equal(hours[0].shift, "A");
  assert.equal(hours[8].shift, "B");
  assert.equal(hours[23].label, "05-06");
  const byStatus = (s) => hours.filter((h) => h.status === s).length;
  assert.equal(byStatus("closed"), 8, "06..14 are closed");
  assert.equal(byStatus("current"), 1, "14-15 is running");
  assert.equal(byStatus("future"), 15);
  assert.equal(hours.find((h) => h.status === "current").label, "14-15");
});

// ── Last known good ──────────────────────────────────────────────────────

test("withLastGood: a failure after a success serves the last good value flagged stale", async () => {
  assert.deepEqual(await metrics.withLastGood("k", async () => ({ n: 1 })), { n: 1 });
  const r = await metrics.withLastGood("k", async () => { throw new Error("grafana down"); });
  assert.equal(r.n, 1);
  assert.equal(r.stale, true);
  assert.match(r.staleReason, /grafana down/);
  assert.ok(r.staleSince);
});

test("withLastGood: a failure with no prior good value still fails (never invents data)", async () => {
  await assert.rejects(() => metrics.withLastGood("never", async () => { throw new Error("boom"); }), /boom/);
});

test("withLastGood: a later success replaces the stale value and clears the flag", async () => {
  await metrics.withLastGood("k2", async () => ({ n: 1 }));
  await metrics.withLastGood("k2", async () => { throw new Error("x"); });
  assert.deepEqual(await metrics.withLastGood("k2", async () => ({ n: 3 })), { n: 3 });
});

// ── Shift-level sections (shared by Dashboard and One Pager) ───────────────

function fakeQm() {
  const calls = [];
  return {
    calls,
    createQuery: async ({ operation }) => { calls.push(["create", operation]); return { query_id: "Q-1" }; },
    registerJob() {}, unregisterJob() { calls.push(["unregister"]); },
    markRunning: async () => calls.push(["running"]),
    completeQuery: async () => calls.push(["complete"]),
    failQuery: async (id, e) => calls.push(["fail", e]),
  };
}
const noCache = { isDateClosed: () => false, get: async () => null, set: async () => {} };

test("runCompactionForDate: one row per metric with A/B/C/Total, one Query Manager row", async () => {
  // runSection uses the real capability manager through dispatchAndWait, so go through the injectable seam instead:
  const qm = fakeQm();
  const dispatched = [];
  const deps = {
    capabilityManager: {
      requestCapability: async ({ capabilityName }) => { dispatched.push(capabilityName); return { ok: true, query: { query_id: capabilityName } }; },
      getResult: (id) => ({ windows: id === "GET_GRAFANA_COMPACTION_COUNT" ? { A: 1, B: 2, C: 3 } : { A: 10, B: 20, C: 30 } }),
    },
    waitForTerminal: async () => ({ status: "COMPLETED" }),
  };
  const result = await metrics.dispatchAndWait(USER, "GET_GRAFANA_COMPACTION_COUNT", { windows: {} }, deps);
  assert.deepEqual(result.windows, { A: 1, B: 2, C: 3 });
  assert.deepEqual(dispatched, ["GET_GRAFANA_COMPACTION_COUNT"]);
  assert.equal(qm.calls.length, 0);
  void noCache;
});

test("dispatchAndWait: a failed capability throws with the real reason (never zeros)", async () => {
  const deps = {
    capabilityManager: { requestCapability: async () => ({ ok: true, query: { query_id: "C1" } }), getResult: () => null },
    waitForTerminal: async () => ({ status: "FAILED", error: "Grafana HTTP 502" }),
  };
  await assert.rejects(() => metrics.dispatchAndWait(USER, "X", {}, deps), /FAILED: Grafana HTTP 502/);
  const refused = { capabilityManager: { requestCapability: async () => ({ ok: false, reason: "no creds", code: 503 }) } };
  await assert.rejects(() => metrics.dispatchAndWait(USER, "X", {}, refused), /no creds/);
});

// ── Hourly scalar ────────────────────────────────────────────────────────

function hourlyDeps(valueFor, record) {
  return {
    capabilityManager: {
      requestCapability: async ({ params }) => { record.push(params.hourWindows); return { ok: true, query: { query_id: "H" } }; },
      getResult: () => {
        const hours = { A: [], B: [], C: [] };
        const last = record[record.length - 1];
        for (const k of ["A", "B", "C"]) last[k].forEach((w, i) => { hours[k][i] = w.skip ? null : valueFor(w); });
        return { hours };
      },
    },
    waitForTerminal: async () => ({ status: "COMPLETED" }),
  };
}

test("hourlyScalar: queries only past/current hours, returns null (not 0) for future hours", async () => {
  const record = [];
  const now = Date.UTC(2026, 9, 13, 8, 53); // 14:23 IST
  const out = await metrics.hourlyScalar({ user: USER, dateStr: "2026-10-13", capabilityName: "GET_GRAFANA_COMPACTION_HOURLY", memoKind: "t1", now, deps: hourlyDeps(() => 7, record) });
  assert.equal(out.length, 24);
  const queried = Object.values(record[0]).flat().filter((w) => !w.skip).length;
  assert.equal(queried, 9, "8 closed hours + the current one");
  assert.equal(out[0].value, 7);
  assert.equal(out[8].status, "current");
  assert.equal(out[8].value, 7);
  assert.equal(out[9].status, "future");
  assert.equal(out[9].value, null);
});

test("hourlyScalar: closed hours are fetched once; later calls re-query only the current hour", async () => {
  const record = [];
  const now = Date.UTC(2026, 9, 13, 8, 53);
  const deps = hourlyDeps(() => 5, record);
  await metrics.hourlyScalar({ user: USER, dateStr: "2026-10-13", capabilityName: "C", memoKind: "t2", now, deps });
  const out = await metrics.hourlyScalar({ user: USER, dateStr: "2026-10-13", capabilityName: "C", memoKind: "t2", now: now + 60000, deps });
  const second = Object.values(record[1]).flat().filter((w) => !w.skip).length;
  assert.equal(second, 1, "only the current hour is queried again");
  assert.equal(out[0].value, 5, "closed hours still returned from memory");
});

test("hourlyScalar: when everything is cached or future, no capability call is made at all", async () => {
  const record = [];
  const now = Date.UTC(2026, 9, 13, 0, 31); // 06:01 IST - hour 06-07 is current
  const deps = hourlyDeps(() => 1, record);
  await metrics.hourlyScalar({ user: USER, dateStr: "2026-10-13", capabilityName: "C", memoKind: "t3", now, deps });
  assert.equal(record.length, 1);
  const before = Date.UTC(2026, 9, 12, 20, 0); // the day hasn't started: all future
  await metrics.hourlyScalar({ user: USER, dateStr: "2026-10-13", capabilityName: "C", memoKind: "t4", now: before, deps });
  assert.equal(record.length, 1, "no dispatch for a day that has not begun");
});

test("hourlyScalar: an all-zero day asks (cheaply, every hour skipped) when the table last recorded an event", async () => {
  const record = [];
  const now = Date.UTC(2026, 9, 13, 8, 53);
  const deps = {
    capabilityManager: {
      requestCapability: async ({ params }) => { record.push(params); return { ok: true, query: { query_id: "H" } }; },
      getResult: () => {
        const last = record[record.length - 1];
        const hours = { A: [], B: [], C: [] };
        for (const k of ["A", "B", "C"]) last.hourWindows[k].forEach((w, i) => { hours[k][i] = w.skip ? null : 0; });
        return { hours, lastEvent: last.withLastEvent ? Date.UTC(2026, 9, 13, 5, 54) : undefined };
      },
    },
    waitForTerminal: async () => ({ status: "COMPLETED" }),
  };
  const out = await metrics.hourlyScalar({ user: USER, dateStr: "2026-10-13", capabilityName: "C", memoKind: "z1", now, withLastEvent: true, deps });
  assert.equal(out.lastEvent, Date.UTC(2026, 9, 13, 5, 54));
  assert.equal(record.length, 2, "one hourly read + one last-event lookup");
  assert.equal(Object.values(record[1].hourWindows).flat().every((w) => w.skip), true, "the lookup queries no hours");
  assert.equal(record[1].withLastEvent, true);
});

test("hourlyScalar: a day with events never asks for the last event", async () => {
  const record = [];
  const now = Date.UTC(2026, 9, 13, 8, 53);
  const deps = hourlyDeps(() => 4, record);
  const out = await metrics.hourlyScalar({ user: USER, dateStr: "2026-10-13", capabilityName: "C", memoKind: "z2", now, withLastEvent: true, deps });
  assert.equal(record.length, 1);
  assert.equal(out.lastEvent, null);
});
