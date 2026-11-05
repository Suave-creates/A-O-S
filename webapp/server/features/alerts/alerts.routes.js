// HTTP surface for Alerts. The Alerts page and the sidebar notices read the live topic `alerts`
// (server/live/alertsFeed.js); these routes are the actions:
//
//   GET  /api/v1/alerts                       recent alerts (fallback / debugging; the UI uses the live topic)
//   GET  /api/v1/alerts/analytics?period=     summary for today | 7d | 30d | 90d | 365d (the Analytics view)
//   GET  /api/v1/alerts/:id/history           everything that happened to one alert (alert_events)
//   POST /api/v1/alerts/:id/acknowledge       take the alert (shared: closes the sidebar notice for everyone)
//   POST /api/v1/alerts/:id/remark  {text}    save the remark (who + when are recorded); refused if one exists
//   POST /api/v1/alerts/:id/remark/undo       take back the latest remark save - once
//
// Every user may acknowledge and remark. Each action is also written to the audit log.

const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const asyncHandler = require("../../platform/http/asyncHandler");
const auditLog = require("../../platform/audit/auditLog");
const requireRole = require("../../platform/http/requireRole");
const store = require("./alertStore");
const { RULES } = require("./alertRules");
const { summarize } = require("./alertAnalytics");

const router = express.Router();
router.use(requireAuth);

const MAX_REMARK = 1000;
const PERIOD_DAYS = { today: 1, "7d": 7, "30d": 30, "90d": 90, "365d": 365 };
const IST_OFFSET_MS = 5.5 * 3600000;

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid alert id" });
    return null;
  }
  return id;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await store.listRecent({ limit: req.query.limit }));
  })
);

// A period is whole IST calendar days ending today ("7d" = today and the 6 days before), so the per-day rollup
// and the alert-level figures cover exactly the same alerts.
router.get(
  "/analytics",
  asyncHandler(async (req, res) => {
    const period = String(req.query.period || "7d");
    if (!PERIOD_DAYS[period]) return res.status(400).json({ error: "Period must be today, 7d, 30d, 90d or 365d" });
    const nowMs = Date.now();
    const todayStartMs = Math.floor((nowMs + IST_OFFSET_MS) / 86400000) * 86400000 - IST_OFFSET_MS;
    const sinceMs = todayStartMs - (PERIOD_DAYS[period] - 1) * 86400000;
    const sinceIso = new Date(sinceMs).toISOString();
    const istDay = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
    const [{ alerts, capped }, events, daily] = await Promise.all([
      store.listSince(sinceIso),
      store.eventsForAlertsSince(sinceIso),
      store.dailyBetween(istDay(sinceMs), istDay(nowMs)),
    ]);
    res.json({ period, generatedAt: new Date(nowMs).toISOString(), capped, ...summarize(alerts, { sinceMs, nowMs, events, daily }) });
  })
);

// Edit a rule's limit / switch it off. Admins only; the next evaluation uses it.
router.put(
  "/rules/:key",
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    const key = req.params.key;
    if (!RULES[key]) return res.status(404).json({ error: "Unknown alert rule" });
    const threshold = Number(req.body && req.body.threshold);
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100000) return res.status(400).json({ error: "Limit must be a whole number between 0 and 100000" });
    const enabled = !(req.body && req.body.enabled === false);
    await store.saveRuleSetting(key, { enabled, threshold }, req.user.employeeId);
    await auditLog.record(req.user.id, "ALERT_RULE_CHANGED", { ruleKey: key, enabled, threshold });
    res.json({ key, enabled, threshold });
  })
);

router.get(
  "/:id/history",
  asyncHandler(async (req, res) => {
    const id = parseId(req, res);
    if (!id) return;
    const alert = await store.get(id);
    if (!alert) return res.status(404).json({ error: "Alert not found" });
    res.json({ alert, history: await store.history(id) });
  })
);

router.post(
  "/:id/acknowledge",
  asyncHandler(async (req, res) => {
    const id = parseId(req, res);
    if (!id) return;
    const before = await store.get(id);
    if (!before) return res.status(404).json({ error: "Alert not found" });
    const alert = await store.acknowledge(id, req.user.employeeId);
    if (before.status === "OPEN") await auditLog.record(req.user.id, "ALERT_ACKNOWLEDGED", { alertId: id, ruleKey: before.ruleKey, title: before.title });
    res.json(alert);
  })
);

router.post(
  "/:id/remark/undo",
  asyncHandler(async (req, res) => {
    const id = parseId(req, res);
    if (!id) return;
    const before = await store.get(id);
    if (!before) return res.status(404).json({ error: "Alert not found" });
    if (!before.undoAvailable) return res.status(409).json({ error: "Nothing to undo" });
    const alert = await store.undoRemark(id, req.user.employeeId);
    await auditLog.record(req.user.id, "ALERT_REMARK_UNDONE", { alertId: id, ruleKey: before.ruleKey });
    res.json(alert);
  })
);

router.post(
  "/:id/remark",
  asyncHandler(async (req, res) => {
    const id = parseId(req, res);
    if (!id) return;
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return res.status(400).json({ error: "Remark cannot be empty" });
    if (text.length > MAX_REMARK) return res.status(400).json({ error: `Remark is limited to ${MAX_REMARK} characters` });
    const before = await store.get(id);
    if (!before) return res.status(404).json({ error: "Alert not found" });
    if (before.remark) return res.status(409).json({ error: "A remark is already saved - undo it first to write a new one" });
    const alert = await store.setRemark(id, text, req.user.employeeId);
    await auditLog.record(req.user.id, "ALERT_REMARK", { alertId: id, ruleKey: before.ruleKey, remark: text });
    res.json(alert);
  })
);

module.exports = router;
