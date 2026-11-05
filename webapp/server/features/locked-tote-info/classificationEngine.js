// Locked Tote Information refresh lifecycle - the merged "ASRS: Locked
// Totes" + "Classification" engine. Read-only by construction: this file
// never imports totePullEngine.js, quadronPullLock.js, or
// pullQuadronTote.js, and has no code path that can create a pull session
// or dispatch PULL_QUADRON_TOTE.
//
// Phase (Locked Tote Information unification): every refresh is now a real
// Query Manager operation (LOCKED_TOTE_INFO_REFRESH) - createQuery()/
// registerJob()/markRunning()/completeQuery()/failQuery() exactly like
// toteUtilisationJob.js and nexsAsrsDumpEngine.js already do - so it shows
// up in Active Queries like every other refresh, and the resulting
// snapshot is now persisted to MySQL (locked_tote_snapshots, migration
// 0006) instead of living only in an in-memory variable lost on restart.
// The HTTP shape stays a single blocking POST /refresh -> full snapshot
// response (unchanged UX - no client polling needed, same as before), the
// route just creates the query first and passes its id in.
//
// Snapshot semantics (unchanged from before): exactly one CURRENT snapshot
// at a time (now: the most recently COMPLETED row in MySQL), each refresh
// wholesale-replaces it, never merged against the previous one. Nothing
// else in the app is allowed to mutate it - a Manual pull, and Auto Mode's
// own queue, only ever READ classification data (and Auto re-derives its
// own classification independently via classification.js - it does NOT
// read this snapshot - see autoDiff.js's own comment).
//
// "Locked Since" (classification_tote_state, migration 0003) is a
// completely separate, UNCHANGED, already-persisted sub-system - this file
// still only enriches each tote with it via touchLockedSince(), never
// duplicates or re-implements it.

const defaultCapabilityManager = require("../../integrations/capabilities/capabilityManager");
const { waitForTerminal } = require("../../platform/queries/queryPoll");
const { fetchCapabilitySource } = require("../../integrations/capabilities/capabilitySource");
const { classifyLockedTotes } = require("../../platform/domain/classification");
const classificationTimestamps = require("./classificationTimestamps");
const ccDayRows = require("./ccDayRows");
const { siteDayIST } = require("../../platform/time/shiftWindows");
const defaultQueryManager = require("../../platform/queries/queryManager");
const defaultDb = require("../../platform/db");
const config = require("../../config");

// getCurrentSnapshot() -> the most recent COMPLETED snapshot, read fresh
// from MySQL, or null if none has ever completed. Never triggers a
// refresh - same "no snapshot yet" contract nexsAsrsDumpEngine.js and
// toteUtilisationJob.js already use.
async function getCurrentSnapshot({ db = defaultDb } = {}) {
  const rows = await db.query("SELECT result_json FROM locked_tote_snapshots ORDER BY id DESC LIMIT 1");
  return rows[0] ? JSON.parse(rows[0].result_json) : null;
}

// getResult(queryId) -> one specific past run's full snapshot, or null.
async function getResult(queryId, { db = defaultDb } = {}) {
  const rows = await db.query("SELECT result_json FROM locked_tote_snapshots WHERE query_id = ?", [queryId]);
  return rows[0] ? JSON.parse(rows[0].result_json) : null;
}

// listRecentResults({limit}) -> lightweight history list (queryId/createdAt/refreshedBy/rowCount/summary/degraded
// only - never the full totes array for more than one run at a time). Site-wide: a snapshot is site data, so
// everyone sees every refresh, whoever (or the auto-refresh) ran it.
async function listRecentResults({ limit = 10 } = {}, { db = defaultDb } = {}) {
  const params = [];
  const where = "q.operation = 'LOCKED_TOTE_INFO_REFRESH' AND q.status = 'COMPLETED'";
  const n = Number(limit);
  const safeLimit = Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 10;
  params.push(safeLimit);

  const rows = await db.query(
    `SELECT r.query_id AS queryId, r.created_at AS createdAt, r.row_count AS rowCount, u.employee_id AS refreshedBy,
            JSON_EXTRACT(r.result_json, '$.summary') AS summaryJson,
            JSON_EXTRACT(r.result_json, '$.degraded') AS degradedJson
       FROM locked_tote_snapshots r
       JOIN queries q ON q.query_id = r.query_id
       JOIN users u ON u.id = q.user_id
      WHERE ${where}
      ORDER BY r.id DESC
      LIMIT ?`,
    params
  );

  const parseMaybe = (v) => (typeof v === "string" ? JSON.parse(v) : v);
  return rows.map((row) => ({
    queryId: row.queryId,
    createdAt: row.createdAt,
    refreshedBy: row.refreshedBy,
    rowCount: row.rowCount,
    summary: parseMaybe(row.summaryJson),
    degraded: parseMaybe(row.degradedJson),
  }));
}

// Thin wrapper around the shared fetchCapabilitySource() (also used by
// autoEngine.js's periodic fetch cycle) so this module's own tests keep
// their existing (user, capabilityName, requestCapability, wait, getResult)
// call shape unchanged.
async function fetchSource({ user, capabilityName, requestCapability, wait, getResult }) {
  return fetchCapabilitySource({ user, capabilityName, requestCapability, wait, getResult });
}

// refresh({ queryId, user, p0MaxTotes, p1MaxTotes, ... }) -> the new
// snapshot, now also persisted to MySQL and tracked as a real Query
// Manager row. Rethrows (does NOT persist anything, and fails the query)
// if the Locked Dump fetch itself fails - Locked Dump is the base universe
// classification has nothing to classify without, so the previous good
// snapshot staying "current" is preferable to replacing it with an empty
// one. requestCapability/wait/getResult/touchLockedSince/qm/db are
// injectable purely for testing - production callers (the route) supply
// only {queryId, user, p0MaxTotes, p1MaxTotes}.
async function refresh({
  queryId,
  user,
  p0MaxTotes,
  p1MaxTotes,
  requestCapability = defaultCapabilityManager.requestCapability,
  wait = waitForTerminal,
  getResult: getCapabilityResult = defaultCapabilityManager.getResult,
  touchLockedSince = classificationTimestamps.touchMany,
  observeLockedSince, // the lock-episode version (production default); see below
  loadReports,
  qm = defaultQueryManager,
  db = defaultDb,
}) {
  // Synchronous, before any await - queryManagerMysql.reconcileStale()
  // treats any QUEUED/RUNNING query with no live registry entry as an
  // abandoned job from a crashed/restarted process and immediately fails
  // it - see toteUtilisationJob.js/purgeEngine.js for the identical
  // pattern and the live-verification history behind why this must happen
  // before any await, not after.
  const controller = new AbortController();
  qm.registerJob(queryId, controller);

  try {
    await qm.markRunning(queryId);

    const [lockedSource, supervisorSource, inventorySource] = await Promise.all([
      fetchSource({ user, capabilityName: "GET_GRAFANA_LOCKED_TOTES", requestCapability, wait, getResult: getCapabilityResult }),
      fetchSource({ user, capabilityName: "GET_GRAFANA_SUPERVISOR_DUMP", requestCapability, wait, getResult: getCapabilityResult }),
      fetchSource({ user, capabilityName: "GET_QUADRON_INVENTORY", requestCapability, wait, getResult: getCapabilityResult }),
    ]);

    if (!lockedSource.ok) {
      const err = new Error(`Locked Tote Information refresh failed: Locked Tote Dump unavailable (${lockedSource.reason})`);
      err.code = 502;
      throw err;
    }
    // Quadron inventory is the source of truth for what is locked (operator decision 2026-11-04): without it nothing
    // can be confirmed, so the refresh fails and the last good snapshot stays current - never a guessed all-P2 list.
    if (!inventorySource.ok) {
      const err = new Error(`Locked Tote Information refresh failed: Quadron Inventory unavailable (${inventorySource.reason}) - locked totes are counted from Quadron, so the last snapshot is kept`);
      err.code = 502;
      throw err;
    }

    const classified = classifyLockedTotes({
      lockedRows: lockedSource.rows,
      supervisorRows: supervisorSource.ok ? supervisorSource.rows : [],
      inventoryRows: inventorySource.rows,
      p0MaxTotes: p0MaxTotes != null ? p0MaxTotes : config.classificationP0MaxTotes,
      p1MaxTotes: p1MaxTotes != null ? p1MaxTotes : config.classificationP1MaxTotes,
    });
    const { totes, unconfirmed, summary } = confirmWithQuadron(classified, inventorySource.rows);
    const skusByTote = new Map();
    for (const r of inventorySource.rows || []) {
      const skus = (r.partitions || []).map((p) => p && p.sku).filter((x) => x != null && x !== "");
      if (skus.length) skusByTote.set(String(r.toteId).toUpperCase(), skus.map(String));
    }
    // a caller that injects its own touchLockedSince (the tests) gets plain first-seen behaviour and no report read
    const plainFirstSeen = touchLockedSince !== classificationTimestamps.touchMany;
    if (observeLockedSince === undefined) observeLockedSince = plainFirstSeen ? null : classificationTimestamps.observeMany;
    const reportsByTote = await (loadReports || (plainFirstSeen ? async () => new Map() : recentShortReports))(user);

    const generatedAt = new Date().toISOString();

    // "Locked Since" - Priority 2 (firstSeenAt) for every tote this refresh
    // actually observed. See lockedSinceTracker.js for the full policy
    // (never reset, even across a disappear/reappear). This never touches
    // P0/P1/P2/SD - it only enriches each already-classified tote.
    // Locked Since per lock: a tote cleared since the last refresh (or refilled with other SKUs) starts a new lock,
    // dated by the SHORT report that caused it, else by now - see lockedSinceTracker.observeTote().
    const observations = [...totes, ...unconfirmed].map((t) => ({ toteId: t.toteId, skus: skusByTote.get(String(t.toteId).toUpperCase()) || null, reports: reportsByTote.get(String(t.toteId).toUpperCase()) || [] }));
    // the refresh before this one: a tote missing from it was cleared, so seeing it now starts a new lock
    const prev = observeLockedSince ? await db.query("SELECT created_at FROM locked_tote_snapshots ORDER BY id DESC LIMIT 1").catch(() => []) : [];
    const lockedSinceMap = observeLockedSince
      ? await observeLockedSince(observations, generatedAt, prev[0] ? prev[0].created_at : null)
      : await touchLockedSince(observations.map((o) => o.toteId), generatedAt);
    const totesWithLockedSince = totes.map((t) => ({ ...t, lockedSince: lockedSinceMap.get(t.toteId) ?? null }));

    // Total Inventory - a plain sum of each tote's already-computed
    // totalToteInv (never fabricated, never re-derived from a different
    // source; totes with no Quadron data (null) contribute 0, exactly like
    // purgeReport.buildSummary()'s own totalInventory aggregate).
    const totalInventory = totesWithLockedSince.reduce((s, t) => s + (typeof t.totalToteInv === "number" ? t.totalToteInv : 0), 0);

    const snapshot = {
      queryId,
      generatedAt,
      refreshedBy: user.employeeId,
      lockedQueryId: lockedSource.queryId,
      supervisorQueryId: supervisorSource.queryId,
      inventoryQueryId: inventorySource.queryId,
      degraded: { supervisor: !supervisorSource.ok, inventory: !inventorySource.ok },
      degradedReasons: { supervisor: supervisorSource.ok ? null : supervisorSource.reason, inventory: inventorySource.ok ? null : inventorySource.reason },
      totes: totesWithLockedSince,
      // in the Locked Tote Dump but not confirmed by Quadron (missing there, or empty) - shown apart, never counted
      unconfirmed: unconfirmed.map((t) => ({ ...t, lockedSince: lockedSinceMap.get(t.toteId) ?? null })),
      summary: { ...summary, totalInventory },
    };

    await db.execute(
      "INSERT INTO locked_tote_snapshots (query_id, result_json, row_count, created_at) VALUES (?, ?, ?, ?)",
      [queryId, JSON.stringify(snapshot), snapshot.totes.length, generatedAt]
    );

    await qm.completeQuery(queryId);
    return snapshot;
  } catch (e) {
    await qm.failQuery(queryId, e.message || String(e));
    throw e;
  } finally {
    qm.unregisterJob(queryId);
  }
}

// SHORT discrepancy reports of the last few site days (today read fresh, closed days from the Locked Tote
// Analytics store) as tote -> [iso], to date a reported lock. Best effort: no reports just means "first seen".
async function recentShortReports(user) {
  try {
    const today = siteDayIST();
    const dates = [3, 2, 1, 0].map((n) => new Date(Date.parse(today + "T00:00:00Z") - n * 86400000).toISOString().slice(0, 10));
    const { days } = await ccDayRows.loadDays(dates, { user });
    const out = new Map();
    for (const v of days.values()) {
      for (const r of v.reports) {
        if (!out.has(r.c)) out.set(r.c, []);
        out.get(r.c).push(new Date(r.ms).toISOString());
      }
    }
    return out;
  } catch (e) {
    return new Map();
  }
}

// Quadron decides what is locked: a tote from the Locked Tote Dump counts only when Quadron's inventory holds it
// with stock (MATCH). The rest are returned apart as `unconfirmed` with their verdict - MISSING_IN_QUADRON (not
// in Quadron at all) or EMPTY_IN_QUADRON (there, but no stock) - and the summary counts only the confirmed ones.
// Every tote carries quadronQty and quadronVerdict, so the screen needs no separate validation step.
function confirmWithQuadron({ totes, summary }, inventoryRows) {
  const byTote = new Map((inventoryRows || []).map((r) => [String(r.toteId).toUpperCase(), r]));
  const confirmed = [];
  const unconfirmed = [];
  for (const t of totes) {
    const q = byTote.get(String(t.toteId).toUpperCase()) || null;
    const quadronQty = q && typeof q.quadronQty === "number" ? q.quadronQty : null;
    const quadronVerdict = !q ? "MISSING_IN_QUADRON" : quadronQty > 0 ? "MATCH" : "EMPTY_IN_QUADRON";
    (quadronVerdict === "MATCH" ? confirmed : unconfirmed).push({ ...t, quadronQty, quadronVerdict });
  }
  const count = (p) => confirmed.filter((t) => t.priority === p).length;
  return {
    totes: confirmed,
    unconfirmed,
    summary: {
      ...summary,
      total: confirmed.length,
      sdCount: count("SD"),
      p0Count: count("P0"),
      p1Count: count("P1"),
      p2Count: count("P2"),
      supervisorIntersectedCount: count("SD"),
      unconfirmedCount: unconfirmed.length,
      // summary.lockedCount stays the raw Locked Tote Dump size (before Quadron confirmation)
    },
  };
}

// Every snapshot taken since `sinceIso` (oldest first) with just its summary - what the Dashboard's
// hour-by-hour Locked Totes popup is built from. Never the totes array.
async function listSnapshotSummaries(sinceIso, { db = defaultDb } = {}) {
  const rows = await db.query(
    `SELECT created_at AS createdAt, JSON_EXTRACT(result_json, '$.summary') AS summaryJson
       FROM locked_tote_snapshots WHERE created_at >= ? ORDER BY id ASC`,
    [sinceIso]
  );
  return rows.map((r) => ({ createdAt: r.createdAt, summary: typeof r.summaryJson === "string" ? JSON.parse(r.summaryJson) : r.summaryJson })).filter((r) => r.summary && Number.isFinite(r.summary.total));
}

module.exports = { refresh, getCurrentSnapshot, getResult, listRecentResults, listSnapshotSummaries, confirmWithQuadron };
