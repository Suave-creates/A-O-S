// The NexS ASRS dump, on request (it used to run on a 6-hour timer from index.js; operator decision 2026-11-04:
// no automatic refresh timers). A screen's refresh (its user's auto-refresh tick, or Refresh) on the Dashboard or
// Tote Utilisation asks for a dump when the last completed one is older than MAX_AGE_MS - the same 6-hour freshness
// as before, now driven by people looking at the data. Fire-and-forget: the dump takes minutes; when it lands,
// nexsAsrsDumpEngine.onCompleted() starts the utilisation run and the screens update (live/dashboardFeeds.js).
// Same steps as the dump route's POST /refresh: isRunning() guard, a Query Manager row, then refresh(), which
// records its own final status. Runs as the first ADMIN, like the other automatic jobs.

const nexsAsrsDumpEngine = require("../features/nexs-asrs-dump/nexsAsrsDumpEngine");
const dumpStore = require("../features/nexs-asrs-dump/nexsAsrsDumpMysqlStore");
const queryManager = require("../platform/queries/queryManager");
const { getSystemUser } = require("./systemUser");

const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000; // a failed dump is not retried by every tick

let lastAttemptAt = 0;

async function dumpIfOld({ maxAgeMs = MAX_AGE_MS } = {}) {
  try {
    if (nexsAsrsDumpEngine.isRunning()) return false;
    if (Date.now() - lastAttemptAt < RETRY_AFTER_FAILURE_MS) return false;
    const meta = await dumpStore.getCurrentMeta();
    const doneAt = meta && meta.completed_at ? Date.parse(meta.completed_at) : 0;
    if (Date.now() - doneAt < maxAgeMs) return false;
    lastAttemptAt = Date.now();
    const user = await getSystemUser();
    const query = await queryManager.createQuery({ userId: user.id, operation: "NEXS_ASRS_DUMP_REFRESH", parameters: { onRequest: true } });
    await queryManager.markRunning(query.query_id);
    console.log(`[nexsAsrsDump] refresh on request (last dump over ${Math.round(maxAgeMs / 3600000)} h old, query ${query.query_id}).`);
    nexsAsrsDumpEngine.refresh(query.query_id, { id: user.id, role: user.role }).catch((e) => console.warn("[nexsAsrsDump] refresh on request failed:", e.message || e));
    return true;
  } catch (e) {
    console.warn("[nexsAsrsDump] refresh on request failed:", e.message || e);
    return false;
  }
}

module.exports = { dumpIfOld };
