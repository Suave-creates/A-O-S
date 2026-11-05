// Pure unit tests for server/features/locked-tote-info/lockedSinceTracker.js - the "Locked
// Since" firstSeenAt/never-reset policy. No database, no network, no
// Quadron call. classificationTimestamps.js (the real MySQL adapter)
// delegates to these exact functions rather than reimplementing the
// policy in SQL, so these tests are the authoritative proof of behavior.

const test = require("node:test");
const assert = require("node:assert/strict");
const { touchTote, touchMany, lockedSinceOf } = require("../../../features/locked-tote-info/lockedSinceTracker");

test("first observation creates firstSeenAt equal to the observation timestamp", () => {
  const store = new Map();
  const result = touchTote(store, "TS0000000001", "2026-08-22T10:00:00.000Z");
  assert.equal(result, "2026-08-22T10:00:00.000Z");
  assert.equal(store.get("TS0000000001").firstSeenAt, "2026-08-22T10:00:00.000Z");
});

test("repeated refresh does not change firstSeenAt - lockedSince stays pinned to the first observation", () => {
  const store = new Map();
  touchTote(store, "TS0000000001", "2026-08-22T10:00:00.000Z");
  const secondResult = touchTote(store, "TS0000000001", "2026-08-22T10:30:00.000Z");
  const thirdResult = touchTote(store, "TS0000000001", "2026-08-22T11:00:00.000Z");

  assert.equal(secondResult, "2026-08-22T10:00:00.000Z");
  assert.equal(thirdResult, "2026-08-22T10:00:00.000Z");
  assert.equal(store.get("TS0000000001").firstSeenAt, "2026-08-22T10:00:00.000Z");
});

test("lastSeenAt advances on every observation even though firstSeenAt does not", () => {
  const store = new Map();
  touchTote(store, "TS0000000001", "2026-08-22T10:00:00.000Z");
  touchTote(store, "TS0000000001", "2026-08-22T10:30:00.000Z");
  assert.equal(store.get("TS0000000001").lastSeenAt, "2026-08-22T10:30:00.000Z");
});

test("multiple totes observed in the same round each receive their own independent firstSeenAt", () => {
  const store = new Map();
  const result = touchMany(store, ["TS0000000001", "TS0000000002"], "2026-08-22T10:00:00.000Z");
  assert.equal(result.get("TS0000000001"), "2026-08-22T10:00:00.000Z");
  assert.equal(result.get("TS0000000002"), "2026-08-22T10:00:00.000Z");

  // A later round only touches one of them - the other's firstSeenAt must
  // be completely unaffected by an unrelated tote's activity.
  touchMany(store, ["TS0000000001"], "2026-08-22T11:00:00.000Z");
  assert.equal(store.get("TS0000000001").firstSeenAt, "2026-08-22T10:00:00.000Z");
  assert.equal(store.get("TS0000000002").firstSeenAt, "2026-08-22T10:00:00.000Z");
  assert.equal(store.get("TS0000000002").lastSeenAt, "2026-08-22T10:00:00.000Z", "untouched tote's lastSeenAt must also be unaffected");
});

// Disappearing/reappearing tote - explicitly tested and documented, per
// the deliberate policy in lockedSinceTracker.js: firstSeenAt is NEVER
// reset, even across a genuine disappearance and later reappearance.
test("a tote that disappears (absent from a touchMany round) and later reappears keeps its ORIGINAL firstSeenAt, not a new one", () => {
  const store = new Map();
  touchMany(store, ["TS0000000001", "TS0000000002"], "2026-08-22T10:00:00.000Z");

  // Round 2: TS0000000001 has disappeared from Locked Dump - the caller
  // simply does not include it in toteIds. touchMany must not touch its
  // stored state at all (no implicit "mark absent" side effect exists).
  touchMany(store, ["TS0000000002"], "2026-08-22T10:30:00.000Z");
  assert.equal(store.get("TS0000000001").firstSeenAt, "2026-08-22T10:00:00.000Z", "absence alone must not mutate the missing tote's stored state");
  assert.equal(store.get("TS0000000001").lastSeenAt, "2026-08-22T10:00:00.000Z", "lastSeenAt must not advance for a tote that wasn't observed this round");

  // Round 3: TS0000000001 genuinely reappears.
  const round3 = touchMany(store, ["TS0000000001", "TS0000000002"], "2026-08-22T11:00:00.000Z");
  assert.equal(round3.get("TS0000000001"), "2026-08-22T10:00:00.000Z", "reappearance must report the ORIGINAL firstSeenAt, not the reappearance timestamp");
  assert.equal(store.get("TS0000000001").lastSeenAt, "2026-08-22T11:00:00.000Z", "lastSeenAt DOES advance on the reappearance itself");
});

test("lockedSinceOf prefers discrepancyMarkedAt over firstSeenAt when both are present (Priority 1 extension point)", () => {
  const entry = { firstSeenAt: "2026-08-22T10:00:00.000Z", lastSeenAt: "2026-08-22T10:00:00.000Z", discrepancyMarkedAt: "2026-08-22T09:00:00.000Z" };
  assert.equal(lockedSinceOf(entry), "2026-08-22T09:00:00.000Z");
});

test("lockedSinceOf falls back to firstSeenAt when discrepancyMarkedAt is null (current, Priority-2-only behavior)", () => {
  const entry = { firstSeenAt: "2026-08-22T10:00:00.000Z", lastSeenAt: "2026-08-22T10:00:00.000Z", discrepancyMarkedAt: null };
  assert.equal(lockedSinceOf(entry), "2026-08-22T10:00:00.000Z");
});

test("lockedSinceOf returns null for an unknown tote", () => {
  assert.equal(lockedSinceOf(undefined), null);
});

// Exact scenario from the bug report: a tote observed across three
// refreshes at distinct timestamps must end with first_seen_at pinned to
// the FIRST one and last_seen_at advanced to the LAST one.
test("T1/T2/T3 regression: a tote present across three refreshes ends with first_seen_at===T1 and last_seen_at===T3", () => {
  const T1 = "2026-08-22T13:19:07.000Z";
  const T2 = "2026-08-22T13:25:07.000Z";
  const T3 = "2026-08-22T13:31:07.000Z";
  const store = new Map();

  const r1 = touchTote(store, "TS0000000001", T1);
  const r2 = touchTote(store, "TS0000000001", T2);
  const r3 = touchTote(store, "TS0000000001", T3);

  assert.equal(r1, T1);
  assert.equal(r2, T1, "second refresh must not change lockedSince");
  assert.equal(r3, T1, "third refresh must not change lockedSince");
  assert.equal(store.get("TS0000000001").firstSeenAt, T1);
  assert.equal(store.get("TS0000000001").lastSeenAt, T3);
});

test("touchMany with an empty tote id list is a no-op and returns an empty map", () => {
  const store = new Map();
  const result = touchMany(store, [], "2026-08-22T10:00:00.000Z");
  assert.equal(result.size, 0);
  assert.equal(store.size, 0);
});

// ── lock episodes: SKU change restarts a lock, a SHORT report dates it ─────────────────────────
const { observeTote, mostlyDifferent } = require("../../../features/locked-tote-info/lockedSinceTracker");

test("mostlyDifferent: more than half of the SKUs different (by the union) is a refill; unknown SKUs never are", () => {
  assert.equal(mostlyDifferent(["A", "B", "C", "D"], ["A", "B", "C", "E"]), false); // 3 of 5 shared
  assert.equal(mostlyDifferent(["A", "B"], ["C", "D"]), true);
  assert.equal(mostlyDifferent(["A", "B", "C"], ["A", "X", "Y"]), true); // 1 of 5 shared
  assert.equal(mostlyDifferent(null, ["A"]), false);
});

test("observeTote: the same tote refilled with mostly other SKUs is a new lock - first seen restarts", () => {
  const store = new Map();
  observeTote(store, { toteId: "TL1", skus: ["A", "B"] }, "2026-09-01T00:00:00.000Z");
  assert.equal(observeTote(store, { toteId: "TL1", skus: ["A", "B", "C"] }, "2026-10-01T00:00:00.000Z"), "2026-09-01T00:00:00.000Z", "mostly the same SKUs: the lock continues");
  assert.equal(observeTote(store, { toteId: "TL1", skus: ["X", "Y"] }, "2026-11-04T00:00:00.000Z"), "2026-11-04T00:00:00.000Z", "refilled: a new lock");
});

test("observeTote: reported 2:53 PM -> locked since 2:53; a report while already locked does not move it", () => {
  const store = new Map();
  // the 3:00 PM refresh sees it for the first time; the report that locked it was at 2:53 PM (09:23Z)
  assert.equal(observeTote(store, { toteId: "12345", reports: ["2026-11-04T09:23:00.000Z"] }, "2026-11-04T09:30:00.000Z", "2026-11-04T09:15:00.000Z"), "2026-11-04T09:23:00.000Z");
  // still locked at the 3:15 refresh, reported again at 3:20 PM, seen at 3:30: unchanged
  observeTote(store, { toteId: "12345" }, "2026-11-04T09:45:00.000Z", "2026-11-04T09:30:00.000Z");
  assert.equal(observeTote(store, { toteId: "12345", reports: ["2026-11-04T09:23:00.000Z", "2026-11-04T09:50:00.000Z"] }, "2026-11-04T10:00:00.000Z", "2026-11-04T09:45:00.000Z"), "2026-11-04T09:23:00.000Z");
});

test("observeTote: cleared (missing from the previous refresh) and locked again tomorrow 5:56 -> locked since 5:56", () => {
  const store = new Map();
  observeTote(store, { toteId: "12345", reports: ["2026-11-04T09:23:00.000Z"] }, "2026-11-04T09:30:00.000Z", null);
  // gone from the refreshes after that (cleared); tomorrow's report at 5:56 AM IST (00:26Z), seen at 6:00 AM IST
  const at = observeTote(store, { toteId: "12345", reports: ["2026-11-04T09:23:00.000Z", "2026-11-05T00:26:00.000Z"] }, "2026-11-05T00:30:00.000Z", "2026-11-05T00:15:00.000Z");
  assert.equal(at, "2026-11-05T00:26:00.000Z");
  // no report for the new lock: the moment it appeared
  const s2 = new Map();
  observeTote(s2, { toteId: "T9" }, "2026-11-04T09:30:00.000Z", null);
  assert.equal(observeTote(s2, { toteId: "T9" }, "2026-11-05T00:30:00.000Z", "2026-11-05T00:15:00.000Z"), "2026-11-05T00:30:00.000Z");
});

test("observeTote: still in the list at every refresh = one continuing lock, even if a report comes later", () => {
  const store = new Map();
  observeTote(store, { toteId: "T1" }, "2026-11-04T09:00:00.000Z", null);
  assert.equal(observeTote(store, { toteId: "T1", reports: ["2026-11-04T09:20:00.000Z"] }, "2026-11-04T09:30:00.000Z", "2026-11-04T09:00:00.000Z"), "2026-11-04T09:00:00.000Z");
});
