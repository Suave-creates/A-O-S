// NEXS ASRS Dump refresh orchestration - the single canonical "current
// dataset" every consumer reads. Wraps the fetch in the SAME QueryManager
// lifecycle toteUtilisationJob.js already uses (register/markRunning/
// complete/fail/timeout/cancel) so a refresh is cancellable, timeout-bounded,
// and visible wherever queries are already visible - no second job-tracking
// mechanism. The provider honors the refresh's abort signal, so cancelling
// a refresh really aborts the Apps Script request.
//
// PERSISTENCE (MySQL): the canonical snapshot lives in MySQL now
// (server/features/nexs-asrs-dump/nexsAsrsDumpMysqlStore.js - the approved two-table
// generation-swap design), not a module-level variable - it survives a
// backend restart. A generation becomes visible to readers ONLY once ALL of
// its rows are written and the current-pointer swap has committed, inside
// one transaction (see the write phase below) - a failed attempt at any
// stage never touches the pointer, so the previous good generation stays
// fully intact and servable. getCurrentSnapshot()/getLastAttempt()/
// getStatus() are now async MySQL reads instead of synchronous variable
// reads - every caller must await them (see server/features/nexs-asrs-dump/nexsAsrsDump.routes.js
// and server/features/tote-purge/purgeEngine.js).
//
// The provider (nexsAsrsDumpProvider ->
// googleSheetAsrsDumpProvider -> asrsDumpNormalizer) is completely
// unchanged by any of this - it still only fetches and normalizes rows.
// This file is the only thing that changed to add persistence.

const defaultQueryManager = require("../../platform/queries/queryManager");
const defaultProvider = require("./nexsAsrsDumpProvider");
const config = require("../../config");
const defaultDb = require("../../platform/db");
const defaultStore = require("./nexsAsrsDumpMysqlStore");
const { latestOf } = require("./asrsDumpNormalizer");

// The retention decision (approved): keep the latest 3 COMPLETED
// generations' rows; refresh metadata history is never pruned here (it's
// small - see store.cleanupOldGenerations()'s own comment).
const RETENTION_KEEP = 3;

let running = false; // single-flight guard - never allow two concurrent refreshes to race for the current pointer

function isRunning() {
  return running;
}

// Maps DB column names back to the canonical row shape every consumer
// (webapp UI, Purge, future Utilisation) already expects - the exact same
// {pid, location, barcodeCount, lastUpdatedAt, ingestedAt, toteId,
// partition} shape asrsDumpNormalizer.normalizeRow() produces.
function rowFromDb(r) {
  return {
    pid: r.pid,
    location: r.location,
    barcodeCount: r.barcode_count,
    lastUpdatedAt: r.last_updated_at,
    ingestedAt: r.ingested_at,
    toteId: r.tote_id,
    partition: r.partition_code,
  };
}

function snapshotFromMeta(meta, rows) {
  return {
    rows,
    rowCount: meta.row_count,
    latestIngestedAt: meta.latest_ingested_at,
    latestUpdatedAt: meta.latest_updated_at,
    source: meta.source,
    queryId: meta.query_id,
    refreshedAt: meta.completed_at,
    refreshedBy: meta.refreshed_by_employee_id || null,
  };
}

// getCurrentSnapshot() -> the canonical dataset, read fresh from MySQL.
// Never triggers a fetch - returns null (existing "no snapshot" contract)
// if no generation has ever successfully become current, exactly like the
// original in-memory implementation's `currentSnapshot === null` case.
async function getCurrentSnapshot({ store = defaultStore } = {}) {
  const meta = await store.getCurrentMeta();
  if (!meta) return null;
  const dbRows = await store.getRowsForRefresh(meta.id);
  return snapshotFromMeta(meta, dbRows.map(rowFromDb));
}

// getLastAttempt() -> { at, ok, queryId, reason } for the most recent
// CONCLUDED refresh attempt, or null if none has ever run. Same shape the
// original in-memory `lastAttempt` variable held.
async function getLastAttempt({ store = defaultStore } = {}) {
  const meta = await store.getLatestAttemptMeta();
  if (!meta) return null;
  return {
    at: meta.completed_at,
    ok: meta.status === "COMPLETED",
    queryId: meta.query_id,
    reason: meta.status === "FAILED" ? meta.error : null,
  };
}

// "CURRENT"        - a generation is current and the most recent concluded attempt succeeded (this IS that generation)
// "STALE_PREVIOUS" - a generation is current, but the most recent concluded attempt FAILED - showing an older good generation
// "NO_SNAPSHOT"    - no refresh has ever succeeded
async function getStatus({ store = defaultStore } = {}) {
  await store.reconcileStaleRunning();
  const current = await store.getCurrentMeta();
  if (!current) return "NO_SNAPSHOT";
  const latest = await store.getLatestAttemptMeta();
  if (latest && latest.status === "FAILED") return "STALE_PREVIOUS";
  return "CURRENT";
}

// Told after every refresh that committed a new generation (scheduled or operator-started). The live layer
// listens so Tote Utilisation runs as soon as new data lands - features never import the live layer, so this
// is a plain callback list it registers into. A listener's failure never touches the refresh's own result.
const completedListeners = new Set();
function onCompleted(fn) {
  completedListeners.add(fn);
  return () => completedListeners.delete(fn);
}
function notifyCompleted() {
  for (const fn of completedListeners) {
    Promise.resolve().then(fn).catch((e) => console.warn(`[nexsAsrsDump] completion listener failed: ${e.message || e}`));
  }
}

// refresh(queryId, user, deps) - deps are injectable purely for testing (no
// real Runtime/capability/QueryManager/MySQL call needed to unit-test
// orchestration wiring); production callers pass only {queryId, user}.
async function refresh(
  queryId,
  user,
  { queryManager = defaultQueryManager, provider = defaultProvider, db = defaultDb, store = defaultStore } = {}
) {
  if (running) {
    // Route-level isRunning() check (mirrors purgeEngine's own single-
    // flight guard) should make this unreachable in normal operation; kept
    // as a defensive no-op rather than silently racing the pointer.
    await queryManager.failQuery(queryId, "A NEXS ASRS Dump refresh is already in progress.");
    return;
  }
  running = true;

  const controller = new AbortController();
  const job = queryManager.registerJob(queryId, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.appsScriptTimeoutMs)]);

  let refreshId = null;
  let committed = false;
  try {
    await queryManager.markRunning(queryId);
    await store.reconcileStaleRunning();

    // A. create RUNNING refresh metadata row
    refreshId = await store.createRefresh({ queryId, refreshedBy: user.id });

    // B. fetch through the existing provider - NO MySQL transaction open
    // during this (network) leg.
    const result = await provider.fetchAsrsDump({ signal, user });

    // C. normalize exactly as today - the provider already returns
    // normalized rows (asrsDumpNormalizer applied inside it); nothing to
    // redo here.
    const rows = result.rows;

    // D. calculate row_count and total_barcode_count from the already
    // available normalized array - no second fetch, no re-scan later.
    const rowCount = rows.length;
    const totalBarcodeCount = rows.reduce((s, r) => s + (typeof r.barcodeCount === "number" ? r.barcodeCount : 0), 0);
    const latestIngestedAt = latestOf(rows, "ingestedAt");
    const latestUpdatedAt = latestOf(rows, "lastUpdatedAt");

    // E-I. one transaction: bulk insert + mark COMPLETED + atomic pointer
    // swap + commit. A generation is visible to readers only after this
    // entire block commits.
    await db.transaction(async (tx) => {
      await store.bulkInsertRows(refreshId, rows, { tx });
      await store.markCompleted(refreshId, { rowCount, totalBarcodeCount, source: result.source, latestIngestedAt, latestUpdatedAt }, { tx });
      await store.swapCurrent(refreshId, { tx });
    });

    committed = true;
    await queryManager.completeQuery(queryId);

    // J. after a successful commit, best-effort cleanup of generations
    // beyond the newest 3. Never allowed to turn a successful refresh into
    // a reported failure - errors here are logged only. Awaited (unlike the
    // original fire-and-forget version) so the `running` single-flight guard
    // in `finally` below stays true until cleanup's own DELETEs against
    // nexs_asrs_dump_rows are done - deadlock hardening (2026-09-08,
    // observed live): a NEXT refresh's bulk insert into that same
    // FK-linked, multiply-indexed table starting while a PREVIOUS refresh's
    // cleanup was still deleting old rows from it was a real, demonstrated
    // way to deadlock two transactions against each other. This does not
    // slow down what the user sees - completeQuery() above already reported
    // success before cleanup runs.
    await store.cleanupOldGenerations(RETENTION_KEEP).catch((e) => {
      console.warn(`[nexsAsrsDump] cleanup of old generations failed (non-critical): ${e.message || e}`);
    });
  } catch (e) {
    const reason = e.message || String(e);
    // The write transaction (if one was open) has already rolled back by
    // construction - refreshId's row, if it exists, is marked FAILED as a
    // separate, small statement outside any transaction, exactly mirroring
    // queryManagerMysql.failQuery()'s own pattern. The current pointer is
    // never touched here, at any stage of this catch block.
    if (refreshId != null) {
      await store.markFailed(refreshId, reason).catch((e2) => {
        console.error(`[nexsAsrsDump] failed to mark refresh ${refreshId} FAILED: ${e2.message || e2}`);
      });
    }
    if (e.name === "AbortError" || e.name === "TimeoutError") {
      if (job.wasCancelledByUser()) await queryManager.finalizeCancelled(queryId);
      else await queryManager.timeoutQuery(queryId);
    } else {
      await queryManager.failQuery(queryId, reason);
    }
  } finally {
    queryManager.unregisterJob(queryId);
    running = false;
    // after the single-flight flag drops, so a listener is free to read the new generation
    if (committed) notifyCompleted();
  }
}

module.exports = { refresh, getCurrentSnapshot, getLastAttempt, getStatus, isRunning, onCompleted, RETENTION_KEEP };
