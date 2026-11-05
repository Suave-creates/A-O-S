// HTTP surface for Locked Tote Analytics - 100% READ-ONLY (toteAnalyticsService.js). Mounted behind
// requireAuth + requirePanel("lockedToteAnalytics") in server/index.js.

const express = require("express");
const asyncHandler = require("../../platform/http/asyncHandler");
const service = require("./toteAnalyticsService");

const router = express.Router();

// GET /?range=today|yesterday|7d|30d
router.get(
  "/",
  asyncHandler(async (req, res) => {
    try {
      res.json(await service.getAnalytics(String(req.query.range || "7d"), { user: req.user, fresh: req.query.fresh === "1" }));
    } catch (e) {
      res.status(e.code === 400 ? 400 : 502).json({ error: e.message });
    }
  })
);

module.exports = router;
