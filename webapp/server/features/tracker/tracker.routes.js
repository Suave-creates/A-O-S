// HTTP surface for Outside Tote Analysis (Tracker) - 100% READ-ONLY. This
// router must never import pullQuadronTote.js, totePullEngine.js,
// autoEngine.js, quadronPull.js, or quadronPullLock.js, and has no code path
// that can create a pull session or dispatch PULL_QUADRON_TOTE.

const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const asyncHandler = require("../../platform/http/asyncHandler");
const queryManager = require("../../platform/queries/queryManager");
const trackerEngine = require("./trackerEngine");
const nexsLease = require("../../integrations/logins/nexsLease");
const sharedResults = require("../../platform/storage/sharedResults");

const PANEL = "tracker";

const router = express.Router();
router.use(requireAuth);

router.post(
  "/run",
  asyncHandler(async (req, res) => {
    const { totes, facility } = req.body || {};
    const validation = trackerEngine.validateTotes(totes);
    if (!validation.ok) return res.status(400).json({ error: validation.reason });

    const endJob = nexsLease.guardJob(res, "Outside Tote Analysis");
    if (!endJob) return;
    try {
      const query = await queryManager.createQuery({
        userId: req.user.id,
        operation: "TRACKER_RUN",
        parameters: { totes, facility: facility || "NXS1" },
      });
      const result = await trackerEngine.run({ queryId: query.query_id, user: req.user, totes, facility: facility || "NXS1" });
      await sharedResults.set(PANEL, { result, runBy: (req.user.employeeId || `user ${req.user.id}`), meta: { mode: "manual", count: totes.length } });
      res.json(result);
    } catch (e) {
      res.status(typeof e.code === "number" ? e.code : 502).json({ error: e.message });
    } finally {
      endJob();
    }
  })
);

router.post(
  "/run-auto",
  asyncHandler(async (req, res) => {
    const { facility } = req.body || {};

    const endJob = nexsLease.guardJob(res, "Outside Tote Analysis (Auto)");
    if (!endJob) return;
    try {
      const query = await queryManager.createQuery({
        userId: req.user.id,
        operation: "TRACKER_RUN_AUTO",
        parameters: { facility: facility || "NXS1" },
      });
      const result = await trackerEngine.runAuto({ queryId: query.query_id, user: req.user, facility: facility || "NXS1" });
      await sharedResults.set(PANEL, { result, runBy: (req.user.employeeId || `user ${req.user.id}`), meta: { mode: "auto", count: (result.rows || []).length } });
      res.json(result);
    } catch (e) {
      res.status(typeof e.code === "number" ? e.code : 502).json({ error: e.message });
    } finally {
      endJob();
    }
  })
);

// The latest run, whoever ran it (shared with everyone until someone runs it again - operator decision 2026-11-04).
router.get(
  "/last",
  asyncHandler(async (req, res) => {
    const last = await sharedResults.get(PANEL);
    if (!last) return res.status(404).json({ error: "Nothing has been run yet" });
    res.json(last);
  })
);

module.exports = router;
