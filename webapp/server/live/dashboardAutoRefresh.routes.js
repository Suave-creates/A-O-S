// The Dashboard's central auto refresh settings (live/dashboardAutoRefresh.js). Read by everyone with the
// Dashboard panel (mounted behind requireAuth + requirePanel("dashboard")); changed only by an ADMIN
// (operator decision 2026-11-04), so nobody can raise the Grafana load for the whole site by accident.

const express = require("express");
const asyncHandler = require("../platform/http/asyncHandler");
const requireRole = require("../platform/http/requireRole");
const hub = require("./index");

const router = express.Router();

router.get("/", (req, res) => res.json(hub.dashboardAutoRefresh.view()));

// body: { minutes: { "<topic>": n, ... } } (0 = off, up to 240) or { reset: true }
router.put(
  "/",
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    res.json(await hub.dashboardAutoRefresh.save(req.body || {}, req.user.employeeId || `user ${req.user.id}`));
  })
);

module.exports = router;
