// One Pager Report (2026-09-07) - Locked Totes + Tote Utilisation + Outside
// Totes, each freshly fetched on every generate (see
// server/features/one-pager-report/onePagerReportEngine.js's own header comment on why this never
// depends on another tab's already-refreshed state), plus a "send to
// Slack" action. Available to any authenticated user, like every other
// read-only refresh in this app (Locked Tote Information, Tote Utilisation) -
// not admin-only.

const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const asyncHandler = require("../../platform/http/asyncHandler");
const queryManager = require("../../platform/queries/queryManager");
const onePagerReportEngine = require("./onePagerReportEngine");
const onePagerReportBulkEngine = require("./onePagerReportBulkEngine");
const slackNotifier = require("../../integrations/slack/slackNotifier");
const onePagerReportSheet = require("./onePagerReportSheet");
const onePagerReportExcel = require("./onePagerReportExcel");
const { toPublicQuery } = require("../../integrations/capabilities/toPublicQuery");

const router = express.Router();
router.use(requireAuth);

// Sanitises caller-supplied capacity overrides the same shape/rules
// queries.routes.js's own sanitiseCaps() uses for Tote Utilisation -
// positive finite numbers only, unknown keys ignored, everything else
// falls back to DEFAULT_UTILISATION_CAPS (never NaN/negative/zero silently
// accepted).
function sanitiseCaps(raw) {
  if (raw == null) return {};
  const caps = {};
  for (const key of ["largeLens", "largeFrame", "smallLens", "smallFrame"]) {
    if (!(key in raw)) continue;
    const n = Number(raw[key]);
    if (!Number.isFinite(n) || n <= 0) {
      const err = new Error(`caps.${key} must be a positive number`);
      err.status = 400;
      throw err;
    }
    caps[key] = n;
  }
  return caps;
}

router.post(
  "/generate",
  asyncHandler(async (req, res) => {
    let caps;
    try {
      caps = sanitiseCaps((req.body || {}).utilisationCaps);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
    // Which date's Compaction/CC Metrics/Station Coverage shifts to report -
    // everything else in the report is always live regardless (see
    // onePagerReportEngine.js's own header comment). Omitted -> today, same
    // as before this was added.
    const reportDate = (req.body || {}).reportDate || undefined;

    const query = await queryManager.createQuery({
      userId: req.user.id,
      operation: "ONE_PAGER_REPORT",
      parameters: { utilisationCaps: caps, reportDate },
    });

    try {
      const report = await onePagerReportEngine.generate({ queryId: query.query_id, user: req.user, utilisationCaps: caps, reportDate });
      res.json(report);
    } catch (e) {
      res.status(e.code || 502).json({ error: e.message });
    }
  })
);

router.get(
  "/current",
  asyncHandler(async (req, res) => {
    const report = await onePagerReportEngine.getCurrentReport();
    res.json(report);
  })
);

router.post(
  "/slack",
  asyncHandler(async (req, res) => {
    const report = await onePagerReportEngine.getCurrentReport();
    if (!report) return res.status(400).json({ error: "No report has been generated yet - click Generate first" });
    try {
      await slackNotifier.postReport(report);
      res.json({ ok: true });
    } catch (e) {
      res.status(e.code === "NOT_CONFIGURED" ? 501 : 502).json({ error: e.message });
    }
  })
);

router.post(
  "/sheet",
  asyncHandler(async (req, res) => {
    const report = await onePagerReportEngine.getCurrentReport();
    if (!report) return res.status(400).json({ error: "No report has been generated yet - click Generate first" });
    try {
      const result = await onePagerReportSheet.saveReport(report);
      res.json(result);
    } catch (e) {
      res.status(e.code === "NOT_CONFIGURED" ? 501 : 502).json({ error: e.message });
    }
  })
);

// Excel download (2026-09-08, operator-approved fallback while the Sheets
// write path is blocked by Workspace policy - manually pasted into the
// Sheet each day in the meantime). GET, not POST, so a plain <a href>
// download link works with the browser's own session cookie, no separate
// fetch/blob dance needed. Replaces the earlier flat-CSV download
// ("Current CSV is very basic instead create a excel which depicts same to
// same as the report") - same trigger, real formatted tables instead.
router.get(
  "/xlsx",
  asyncHandler(async (req, res) => {
    const report = await onePagerReportEngine.getCurrentReport();
    if (!report) return res.status(400).json({ error: "No report has been generated yet - click Generate first" });
    const workbook = onePagerReportExcel.buildWorkbook(report);
    const date = report.reportDate || (report.generatedAt || "").slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="asrs-one-pager-report-${date}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  })
);

// Bulk (day-range) report (2026-09-14, operator-requested: "bulk daywise
// individual report... total and avg so I can make 15 days report") - see
// onePagerReportBulkEngine.js's own header comment for exactly which 3
// sections this covers and why the rest of the single-day report can't be
// meaningfully made historical. Same create-then-poll shape as Tote Purge
// (totePurge.routes.js): /generate returns 202 immediately, the client
// polls the existing generic GET /queries/:queryId route, then reads the
// canonical result from /bulk/current once COMPLETED.
router.post(
  "/bulk/generate",
  asyncHandler(async (req, res) => {
    if (onePagerReportBulkEngine.isRunning()) {
      return res.status(409).json({ error: "A bulk report is already being generated. Wait for it to finish." });
    }
    const startDate = (req.body || {}).startDate;
    const endDate = (req.body || {}).endDate;
    try {
      onePagerReportBulkEngine.enumerateDateRange(startDate, endDate); // validates up front, before creating a query row for a request that can't possibly succeed
    } catch (e) {
      return res.status(e.code || 400).json({ error: e.message });
    }

    const query = await queryManager.createQuery({
      userId: req.user.id,
      operation: "ONE_PAGER_REPORT_BULK",
      parameters: { startDate, endDate },
    });
    await queryManager.markRunning(query.query_id);

    onePagerReportBulkEngine.generate(query.query_id, req.user, { startDate, endDate }).catch(() => {
      /* generate() persists its own terminal status in every path */
    });

    res.status(202).json(toPublicQuery(await queryManager.getQuery(query.query_id)));
  })
);

router.get(
  "/bulk/current",
  asyncHandler(async (req, res) => {
    const report = onePagerReportBulkEngine.getCurrentReport();
    const lastAttempt = onePagerReportBulkEngine.getLastAttempt();
    const status = onePagerReportBulkEngine.getStatus();
    if (!report) return res.status(404).json({ error: "No bulk report has been generated yet.", status, lastAttempt });
    res.json({ ...report, status, lastAttempt });
  })
);

router.get(
  "/bulk/xlsx",
  asyncHandler(async (req, res) => {
    const report = onePagerReportBulkEngine.getCurrentReport();
    if (!report) return res.status(400).json({ error: "No bulk report has been generated yet - click Generate first" });
    const workbook = onePagerReportExcel.buildBulkWorkbook(report);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="asrs-bulk-report-${report.startDate}-to-${report.endDate}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  })
);

module.exports = router;
