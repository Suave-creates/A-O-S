// ASRS Performance's daily save: every morning at 06:05 IST the day before is saved (Shift C closes at
// 06:00, so its production / CC / compaction are final by then; locked, outside, utilisation and aisle are
// taken as they stand at that moment). On start, and after each morning save, the current month's missing
// days are filled in (asrsPerformance.fillMonth), so a server that was off at 06:05 catches up by itself. A save
// that fails (the database unreachable, Grafana down) is retried every RETRY_MS until it succeeds.
// Runs as the first ADMIN, like the other automatic jobs (there is no service account).

const asrsPerformance = require("../features/one-pager-report/asrsPerformance");
const { getSystemUser } = require("./systemUser");

const SAVE_AT = { h: 6, m: 5 }; // IST
const START_DELAY_MS = 90 * 1000; // let the server settle before the first catch-up
const RETRY_MS = 15 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60000;

// ms until the next SAVE_AT in IST
function msUntilNextSave(now = Date.now()) {
  const ist = new Date(now + IST_OFFSET_MS);
  let next = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), SAVE_AT.h, SAVE_AT.m) - IST_OFFSET_MS;
  if (next <= now) next += 86400000;
  return next - now;
}

let retryTimer = null;
async function catchUp() {
  let ok = false;
  try {
    const user = await getSystemUser();
    // the month yesterday belongs to (on the 1st that is last month, so its last day is saved too)
    const r = await asrsPerformance.fillMonth(asrsPerformance.yesterdayIST().slice(0, 7), { user });
    ok = !r || r.saved >= r.missing;
  } catch (e) {
    console.warn("[asrs-performance] daily save failed:", e.message || e);
  }
  if (!ok && !retryTimer) {
    console.warn(`[asrs-performance] will try again in ${RETRY_MS / 60000} min.`);
    retryTimer = setTimeout(() => { retryTimer = null; catchUp(); }, RETRY_MS);
    if (retryTimer.unref) retryTimer.unref();
  }
}

let timer = null;
function scheduleNext() {
  timer = setTimeout(async () => {
    await catchUp();
    scheduleNext();
  }, msUntilNextSave());
  if (timer.unref) timer.unref();
}

function start() {
  if (timer) return;
  const first = setTimeout(catchUp, START_DELAY_MS);
  if (first.unref) first.unref();
  scheduleNext();
}

module.exports = { start, msUntilNextSave };
