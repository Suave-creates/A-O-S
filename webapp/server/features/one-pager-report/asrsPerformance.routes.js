// HTTP surface for ASRS Performance (the One Pager kept day by day - see asrsPerformance.js). Reading is
// open to anyone with the panel; "fill missing days" starts the same backfill the server runs by itself.
// Mounted behind requireAuth + requirePanel("asrsPerformance") in server/index.js.

const express = require("express");
const asyncHandler = require("../../platform/http/asyncHandler");
const asrsPerformance = require("./asrsPerformance");

const router = express.Router();
const fail = (res, e) => res.status(e.code === 400 ? 400 : 500).json({ error: e.message });

// GET /month?month=YYYY-MM - every day of the month so far and its summary
router.get(
  "/month",
  asyncHandler(async (req, res) => {
    try {
      res.json({ ...(await asrsPerformance.getMonth(String(req.query.month || ""))), filling: asrsPerformance.isFilling() });
    } catch (e) {
      fail(res, e);
    }
  })
);

// POST /fill {month} - saves the month's missing days in the background (answers at once)
router.post(
  "/fill",
  asyncHandler(async (req, res) => {
    const month = String((req.body || {}).month || "");
    try {
      if (month > asrsPerformance.yesterdayIST().slice(0, 7)) return res.status(400).json({ error: "There are no finished days in that month yet." });
      asrsPerformance.fillMonth(month, { user: req.user }).catch((e) => console.warn("[asrs-performance] fill failed:", e.message || e));
      res.status(202).json({ started: true });
    } catch (e) {
      fail(res, e);
    }
  })
);

// GET /export.csv?month=YYYY-MM - one row per day, then the MTD total and the daily average
router.get(
  "/export.csv",
  asyncHandler(async (req, res) => {
    try {
      const data = await asrsPerformance.getMonth(String(req.query.month || ""));
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", `attachment; filename="asrs-performance-${data.month}.csv"`);
      res.send("﻿" + asrsPerformance.toCsv(data));
    } catch (e) {
      fail(res, e);
    }
  })
);

module.exports = router;
