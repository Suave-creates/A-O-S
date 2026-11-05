// Historical Report Cache (2026-09-22, operator-reported: "recently we have
// lot of database issue due to many queries... want server side caching so
// we don't burden the server"). See migration 0010's own comment for the
// table shape/reasoning.
//
// Root cause this targets: capabilityManager.js already has a short-TTL
// (default 3s) in-memory result cache for every Grafana/Quadron/NexS call
// (server/integrations/capabilities/requestCoalescer.js), but that cache only ever skips
// the RUNTIME round-trip - every call still creates a `queries` row
// (INSERT+UPDATE+SELECT via queryManager.createQuery), calls markRunning(),
// and on completion writes completeQuery() plus TWO audit_logs INSERTs
// (REQUESTED/COMPLETED) - roughly 7-9 SQL statements, EVEN ON A CACHE HIT.
// onePagerReportBulkEngine.js's own 15-day report alone fires 150+ of these
// calls in one burst, which is what was actually straining the database -
// not the Grafana round-trip itself.
//
// The fix this file enables: CC Metrics/Compaction/ASRS Production for a
// day whose own Shift C window has ALREADY fully closed (isDateClosed()
// below) can never change again - it is safe to remember PERMANENTLY. A
// cache hit for a closed day, checked by onePagerReportEngine.js's own
// runCcMetricsForDate/runCompactionForDate/runAsrsProductionForDate BEFORE
// any of the above bookkeeping starts, skips the Grafana dispatch AND every
// one of those DB writes - just a single cheap SELECT. "Today" (or any day
// still in progress) is NEVER read from or written to this cache, since its
// numbers can still change before Shift C ends - that path is completely
// unchanged from before this file existed.

const db = require("../db");
const { shiftWindowsForDate } = require("../time/shiftWindows");

const SECTIONS = new Set(["ccMetricsV4", "compaction", "asrsProduction", "asrsProductionV2"]);

function assertSection(section) {
  if (!SECTIONS.has(section)) throw new Error(`Unknown historical report cache section: ${section}`);
}

// A day is "closed" (permanently immutable) once its own Shift C window has
// actually ended - not merely "before today's calendar date": Shift C for
// date D runs until 06:00 IST on D+1, so D isn't truly closed until that
// instant passes. Reuses shiftWindowsForDate() - no second definition of
// shift boundaries anywhere in this file. Pure/no I/O - safe to call on
// every request with no added DB cost for a day that's still open.
function isDateClosed(dateStr, now = Date.now()) {
  return now >= shiftWindowsForDate(dateStr).C.to;
}

async function get(section, dateStr) {
  assertSection(section);
  const rows = await db.query("SELECT result_json FROM historical_report_cache WHERE section = ? AND date_str = ?", [section, dateStr]);
  return rows[0] ? JSON.parse(rows[0].result_json) : null;
}

// Upsert - a second write for the same (section, dateStr) simply overwrites
// with the latest fetch. Closed-day data is expected to be byte-identical
// every time (it's already-elapsed history), so this is never a meaningful
// correctness concern, just idempotent re-caching.
async function set(section, dateStr, result) {
  assertSection(section);
  await db.execute(
    `INSERT INTO historical_report_cache (section, date_str, result_json, cached_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE result_json = VALUES(result_json), cached_at = VALUES(cached_at)`,
    [section, dateStr, JSON.stringify(result), new Date().toISOString()]
  );
}

module.exports = { isDateClosed, get, set, SECTIONS };
