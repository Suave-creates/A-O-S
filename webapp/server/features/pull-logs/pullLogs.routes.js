// HTTP surface for Pull Logs history - 100% READ-ONLY. This router must never import the pull engines,
// quadronPull or PULL_QUADRON_TOTE; it only reads finished sessions from audit_logs.
// Mounted behind requireAuth + requirePanel("pullerLogs") in server/index.js.

const express = require("express");
const asyncHandler = require("../../platform/http/asyncHandler");
const { getConnectionStatus } = require("../../integrations/logins/connectionStatus");
const pullLogsEngine = require("./pullLogsEngine");

const router = express.Router();

const fail = (res, e) => res.status(e.code === 400 ? 400 : 500).json({ error: e.message });

// GET /history?from=YYYY-MM-DD&to=YYYY-MM-DD&kind=ALL|MANUAL|AUTO&status=ALL|COMPLETED|STOPPED&q=&before=&limit=
router.get(
  "/history",
  asyncHandler(async (req, res) => {
    try {
      res.json(await pullLogsEngine.history(req.query, await getConnectionStatus()));
    } catch (e) {
      fail(res, e);
    }
  })
);

// GET /export.csv - same filters, every session in the range, one row per tote.
router.get(
  "/export.csv",
  asyncHandler(async (req, res) => {
    try {
      const { csv, truncated } = await pullLogsEngine.exportCsv(req.query, await getConnectionStatus());
      const name = `pull-logs-${req.query.from}${req.query.to && req.query.to !== req.query.from ? "_to_" + req.query.to : ""}.csv`;
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", `attachment; filename="${name.replace(/[^\w.-]/g, "")}"`);
      if (truncated) res.set("X-Truncated", String(pullLogsEngine.EXPORT_MAX));
      res.send("﻿" + csv); // BOM so Excel reads it as UTF-8
    } catch (e) {
      fail(res, e);
    }
  })
);

module.exports = router;
