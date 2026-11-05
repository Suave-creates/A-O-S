// Orchestrates one Tote Utilisation query end to end:
//   QUEUED -> RUNNING -> read the canonical NEXS ASRS Dump snapshot -> compute -> persist -> COMPLETED
//
// Phase 3B: this no longer performs its own ASRS fetch. It reads ONLY
// nexsAsrsDumpEngine.getCurrentSnapshot() (the MySQL-backed canonical
// snapshot every consumer - Purge, Utilisation - shares), the same pattern
// server/features/tote-purge/purgeEngine.js already uses. There is no slow external call
// left to bound with a timeout - a MySQL read plus a pure, synchronous
// computation over the already-fetched rows is what's left.
//
// registerJob()/unregisterJob() are still called (with an AbortController
// whose signal is never actually threaded anywhere - nothing left to
// cancel). This is NOT vestigial: queryManagerMysql.reconcileStale() treats
// any QUEUED/RUNNING query with no live registry entry as an abandoned job
// from a crashed/restarted process and immediately fails it - which would
// otherwise fire on THIS query's very first status read (the route handler
// re-reads status via getQuery() immediately after firing this function,
// before it has had a chance to even call markRunning()). Dropping
// registerJob() was tried and confirmed live to break every run this way -
// see the Phase 3B live-verification report.
//
// computeToteUtilisation() itself (server/features/tote-utilisation/toteUtilisation.js) is
// UNCHANGED - ported verbatim from the legacy extension, zero business-rule
// changes. Only the row shape fed into it is adapted (see toUtilisationRow
// below) and only the data SOURCE changed - the calculation, capacity
// rules, and output structure are exactly what they always were.
//
// tote_utilisation_results is unchanged too - still one permanent row per
// run, keyed by query_id, per the existing (deliberately unmodified) schema.

const defaultDb = require("../../platform/db");
const jsonBlob = require("../../platform/storage/jsonBlob");
const defaultQueryManager = require("../../platform/queries/queryManager");
const defaultNexsAsrsDumpEngine = require("../nexs-asrs-dump/nexsAsrsDumpEngine");
const { computeToteUtilisation, DEFAULT_CAPS } = require("./toteUtilisation");

// Maps one canonical NEXS ASRS Dump row (server/features/nexs-asrs-dump/asrsDumpNormalizer.js's
// shape: {pid, toteId, partition, barcodeCount, location, lastUpdatedAt,
// ingestedAt}) to the shape computeToteUtilisation() expects
// ({pid, toteId, location, inventoryCount}).
//
// `location` is deliberately NOT passed through as the canonical value.
// The canonical snapshot's `location` is SYNTHETICALLY DERIVED
// (NXS1-ASRS-{toteId}[_partition]) - built FROM toteId (see Phase 1's
// asrsDumpNormalizer.js) - so it can never signal "this row is actually a
// decant/non-tote location" the way the legacy extension's genuinely-raw
// sheet `location` column could (see the Phase 3 investigation's finding
// under "E. Filtering/exclusions"). Passing the synthetic string through
// unchanged would make computeToteUtilisation's STRICT_TOTE location check
// reject every single row (the NXS1-ASRS- prefix never matches it) and
// silently zero out the whole result. Omitting it (null) makes the
// function fall through to its OWN toteId-validity check instead
// (isValidToteId(invBaseOf(r.toteId))), which remains fully meaningful and
// correct against the canonical data - toteId is preserved raw/unfiltered
// by the normalizer, so an invalid/non-tote id is still excluded exactly
// as before.
function toUtilisationRow(r) {
  return { pid: r.pid, toteId: r.toteId, location: null, inventoryCount: r.barcodeCount };
}

// Told after every run that saved a result (auto or "Run now"), so the Dashboard tile reloads at once instead of
// polling. Plain callback list for the live layer to register into (features never import it).
const completedListeners = new Set();
function onCompleted(fn) {
  completedListeners.add(fn);
  return () => completedListeners.delete(fn);
}

// runToteUtilisation(queryId, caps, deps) - deps are injectable purely for
// testing (no real MySQL/Runtime call needed to unit-test orchestration
// wiring); production callers pass only {queryId, caps}.
async function runToteUtilisation(
  queryId,
  caps,
  { queryManager = defaultQueryManager, nexsAsrsDumpEngine = defaultNexsAsrsDumpEngine, db = defaultDb } = {}
) {
  // Synchronous, before any await - see the file-level comment on why this
  // must happen before control ever yields back to the caller.
  const controller = new AbortController();
  queryManager.registerJob(queryId, controller);

  try {
    await queryManager.markRunning(queryId);

    const snapshot = await nexsAsrsDumpEngine.getCurrentSnapshot();
    if (!snapshot || !Array.isArray(snapshot.rows) || !snapshot.rows.length) {
      throw new Error("No NEXS ASRS Tote Dump snapshot available - refresh NEXS ASRS Tote Dump first.");
    }

    const rows = snapshot.rows.map(toUtilisationRow);
    const result = computeToteUtilisation(rows, caps);

    await db.execute(
      "INSERT INTO tote_utilisation_results (query_id, result_json, summary_json, row_count, created_at) VALUES (?, ?, ?, ?, ?)",
      [queryId, await jsonBlob.pack(result), JSON.stringify(summaryOf(result)), result.pipeline.scanned, new Date().toISOString()]
    );
    await queryManager.completeQuery(queryId);
    for (const fn of completedListeners) {
      Promise.resolve().then(fn).catch((err) => console.warn(`[toteUtilisation] completion listener failed: ${err.message || err}`));
    }
  } catch (e) {
    await queryManager.failQuery(queryId, e.message || String(e));
  } finally {
    queryManager.unregisterJob(queryId);
  }
}

// The small top-level pieces every list/tile needs, as ONE array so a reader
// can fetch them with a single cheap column (see migration 0011) instead of
// re-parsing the ~5 MB result_json per field.
function summaryOf(result) {
  return [result.totals, result.stats, result.mixedCount, result.pipeline, result.caps];
}

async function getResult(queryId, { db = defaultDb } = {}) {
  const rows = await db.query("SELECT * FROM tote_utilisation_results WHERE query_id = ?", [queryId]);
  const row = rows[0];
  return row ? jsonBlob.unpack(row.result_json) : null;
}

// listRecentResults({limit}) -> [{queryId, createdAt, runBy,
// rowCount, totals, stats, mixedCount, pipeline, caps}, ...]
//
// Phase 3C: lightweight summary list for the historical-run comparison UI.
// Deliberately pulls only the small top-level fields out of result_json via
// MySQL's own JSON_EXTRACT (never the full ~5MB detail array) - an operator
// browsing recent runs to pick two for comparison should never cause the
// backend to transmit dozens of full per-tote detail sets. The full result
// (including `detail`) for any ONE specific run is still fetched only via
// the existing getResult()/GET /queries/:id/result, unchanged, exactly as
// before - this function adds a read path, it does not replace that one.
// Site-wide: every user sees every run (a run is site data, not personal).
//
// `stats` (Phase FINAL, Dashboard) - the per-category largeLens/largeFrame/
// smallLens/smallFrame breakdown (totes/cap/qty/util each), additive to the
// existing totals/mixedCount/pipeline/caps fields this function already
// returned. Still small (4 fixed keys, not the ~5MB detail array) - this is
// the ONLY way to derive Large%/Small% (as opposed to just the grand total)
// without a second, heavier read, and is exactly what the Dashboard's Tote
// Utilisation/Totes In ASRS sections need - see public/js/dashboard.js.
// Existing consumers of this function are unaffected (they simply receive
// one more field they don't have to read).
async function listRecentResults({ limit = 10 } = {}, { db = defaultDb } = {}) {
  const params = [];
  const where = "q.operation = 'TOTE_UTILISATION' AND q.status = 'COMPLETED'";
  const n = Number(limit);
  const safeLimit = Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 10;
  params.push(safeLimit);

  // summary_json is the fast path. Runs from before migration 0011 have none:
  // for those, ONE multi-path JSON_EXTRACT (one parse of the document, not five)
  // computes it, and it is written back so the next read is instant. That extract
  // is a separate query for the returned rows only: put in this SELECT, MySQL ran
  // it for every row before sorting and limiting (3.6 s for 10 rows).
  const rows = await db.query(
    `SELECT r.query_id AS queryId, r.created_at AS createdAt, r.row_count AS rowCount, u.employee_id AS runBy,
            r.summary_json AS summaryJson
       FROM tote_utilisation_results r
       JOIN queries q ON q.query_id = r.query_id
       JOIN users u ON u.id = q.user_id
      WHERE ${where}
      ORDER BY r.id DESC
      LIMIT ?`,
    params
  );

  const parseMaybe = (v) => (typeof v === "string" ? JSON.parse(v) : v);
  const out = [];
  for (const row of rows) {
    let summary = parseMaybe(row.summaryJson);
    if (!summary) {
      const legacy = await db.query(
        "SELECT JSON_EXTRACT(result_json, '$.totals', '$.stats', '$.mixedCount', '$.pipeline', '$.caps') AS legacyJson FROM tote_utilisation_results WHERE query_id = ?",
        [row.queryId]
      );
      summary = (legacy[0] && parseMaybe(legacy[0].legacyJson)) || [null, null, null, null, null];
      // Best-effort back-fill - a failure here must never fail the read.
      db.execute("UPDATE tote_utilisation_results SET summary_json = ? WHERE query_id = ? AND summary_json IS NULL", [JSON.stringify(summary), row.queryId]).catch(() => {});
    }
    const [totals, stats, mixedCount, pipeline, caps] = summary;
    out.push({ queryId: row.queryId, createdAt: row.createdAt, runBy: row.runBy, rowCount: row.rowCount, totals, stats, mixedCount, pipeline, caps });
  }
  return out;
}

module.exports = { DEFAULT_CAPS, runToteUtilisation, getResult, toUtilisationRow, listRecentResults, summaryOf, onCompleted };
