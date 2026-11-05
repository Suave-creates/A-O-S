// HTTP surface for the CNG Inv Validator - 100% READ-ONLY. This router must
// never import pullQuadronTote.js, totePullEngine.js, autoEngine.js,
// quadronPull.js, or quadronPullLock.js, and has no code path that can
// create a pull session or dispatch PULL_QUADRON_TOTE. Every capability it
// dispatches (GET_QUADRON_INVENTORY, GET_GRAFANA_TOTE_PARTITION_COUNTS,
// GET_NEXS_DISCREPANCY_REPORT_BATCH) is readOnly:true in the registry.
//
// Single blocking call from the frontend's perspective (matches Dashboard's
// own /cc-metrics shape) - internally requests all 3 capabilities and
// returns the fully reconciled result directly.

const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const asyncHandler = require("../../platform/http/asyncHandler");
const queryManager = require("../../platform/queries/queryManager");
const cngValidator = require("./cngValidator");
const sharedResults = require("../../platform/storage/sharedResults");

const PANEL = "cngValidator";
const nexsLease = require("../../integrations/logins/nexsLease");

const router = express.Router();
router.use(requireAuth);

router.post(
  "/run",
  asyncHandler(async (req, res) => {
    const { totes, facility, focusMode } = req.body || {};
    const validation = cngValidator.validateTotes(totes);
    if (!validation.ok) return res.status(400).json({ error: validation.reason });

    const endJob = nexsLease.guardJob(res, "CNG Inv Validator");
    if (!endJob) return;
    try {
      const query = await queryManager.createQuery({
        userId: req.user.id,
        operation: "CNG_VALIDATOR_RUN",
        parameters: { totes, facility: facility || "NXS1", focusMode: !!focusMode },
      });
      const result = await cngValidator.run({ queryId: query.query_id, user: req.user, totes, facility: facility || "NXS1", focusMode: !!focusMode });
      await sharedResults.set(PANEL, { result, runBy: (req.user.employeeId || `user ${req.user.id}`), meta: { count: totes.length } });
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
