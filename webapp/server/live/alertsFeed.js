// Live topic `alerts`: the alert list for the Alerts page and the sidebar notices.
//
// Evaluation: a server timer evaluates the rules against today's stock-check rows every `alertEvaluateEveryMs`,
// whether or not anyone has the app open (a hidden tab drops its stream after 30 s, so tying alerting to viewers
// made alerts arrive hours late). The rows come from the SAME cached CC read the Dashboard uses, so a viewer and
// the timer share one Grafana read per interval. Events are persisted (deduplicated) so they survive restarts and
// are shown until acknowledged.
//
// The feed itself is a cheap MySQL read every few seconds; evaluation runs in the background and never blocks it.

const config = require("../config");
const store = require("../features/alerts/alertStore");
const engine = require("../features/alerts/alertEngine");
const { RULES } = require("../features/alerts/alertRules");
const { currentCcRows } = require("./dashboardFeeds");

const HISTORY_DAYS = 7;

let evaluating = null;
let lastEvaluatedAt = 0;
let lastError = null;
let dailyBuiltFrom = null; // ISO; null = the per-day rollup has not been fully built since start

function maybeEvaluate({ force = false } = {}) {
  if (evaluating) return evaluating;
  if (!force && Date.now() - lastEvaluatedAt < config.alertEvaluateEveryMs) return null;
  evaluating = (async () => {
    try {
      const { stockRows, discRows, purgeMarks } = await currentCcRows();
      await engine.evaluate(stockRows, discRows, purgeMarks);
      lastError = null;
    } catch (e) {
      lastError = e.message || String(e);
      console.warn("[alerts] evaluation failed:", lastError);
    } finally {
      await rollupDaily(); // acknowledgements and remarks change the rollup too, so it runs even if evaluation failed
      lastEvaluatedAt = Date.now();
      evaluating = null;
    }
  })();
  return evaluating;
}

// Keeps alert_daily current: a full rebuild once after start, then only the days whose alerts changed since the
// last run. The 5 s overlap picks up a write that landed while the previous rebuild was running.
async function rollupDaily() {
  const startedAt = new Date(Date.now() - 5000).toISOString();
  try {
    await store.rebuildDaily({ changedSinceIso: dailyBuiltFrom });
    dailyBuiltFrom = startedAt;
  } catch (e) {
    console.warn("[alerts] daily rollup failed:", e.message);
  }
}

async function describeRules() {
  const s = await engine.settings();
  return s.rules.map((r) => ({ key: r.key, level: RULES[r.key].level, label: RULES[r.key].label, unit: RULES[r.key].unit, description: RULES[r.key].describe(r.threshold), enabled: r.enabled, threshold: r.threshold, default: r.default, updatedBy: r.updatedBy, updatedAt: r.updatedAt }));
}

let timer = null;

function registerAlertsFeed(hub) {
  if (!timer && config.alertEvaluateEveryMs > 0) {
    timer = setInterval(() => maybeEvaluate(), config.alertEvaluateEveryMs);
    timer.unref();
  }
  hub.registerFeed({
    topic: "alerts",
    intervalMs: 5 * 1000,
    minRefreshMs: 1000,
    fetch: async ({ manual }) => {
      maybeEvaluate({ force: !!manual }); // background - never awaited here
      const startMs = Date.parse(config.alertsStartAt);
      const since = new Date(Math.max(Date.now() - HISTORY_DAYS * 24 * 3600 * 1000, Number.isFinite(startMs) ? startMs : 0)).toISOString();
      return {
        alerts: await store.listRecent({ limit: 300, sinceIso: since }),
        rules: await describeRules(),
        engine: { ok: !lastError, error: lastError },
      };
    },
  });
}

module.exports = { registerAlertsFeed, maybeEvaluate };
