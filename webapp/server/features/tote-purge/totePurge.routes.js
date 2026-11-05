// HTTP surface for Tote Purge - read-only, analysis-only. Mirrors
// nexsAsrsDump.routes.js's create-then-poll shape exactly: /generate
// creates a query and returns immediately (202), the client polls the
// existing generic GET /queries/:queryId route for status, then reads the
// canonical report from /current once COMPLETED. No second query-polling
// mechanism invented here, and no route in this file ever dispatches a
// tote, starts Auto/Manual, or touches PULL_QUADRON_TOTE.

const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const asyncHandler = require("../../platform/http/asyncHandler");
const queryManager = require("../../platform/queries/queryManager");
const purgeEngine = require("./purgeEngine");
const { toPublicQuery } = require("../../integrations/capabilities/toPublicQuery");
const nexsLease = require("../../integrations/logins/nexsLease");

const router = express.Router();
router.use(requireAuth);

router.post(
  "/generate",
  asyncHandler(async (req, res) => {
    if (purgeEngine.isRunning()) {
      return res.status(409).json({ error: "A Tote Purge report is already being generated. Wait for it to finish." });
    }

    const filters = (req.body && req.body.filters) || {};
    const facilityCode = (req.body && req.body.facilityCode) || "NXS1";

    // Purge needs NexS for its whole run. The job holds its own lease so leaving the page
    // mid-calculation never disconnects NexS underneath it; not connected -> 409 (connect popup).
    const endJob = nexsLease.guardJob(res, "Tote Purge");
    if (!endJob) return;

    let query;
    try {
      query = await queryManager.createQuery({
        userId: req.user.id,
        operation: "TOTE_PURGE_GENERATE",
        parameters: { filters, facilityCode },
      });
      await queryManager.markRunning(query.query_id);
    } catch (e) {
      endJob();
      throw e;
    }

    // Fire-and-forget, matching every other long-running-fetch route in
    // this codebase (NEXS ASRS Dump refresh, Tote Utilisation) - the HTTP
    // response returns immediately; progress is polled separately via the
    // existing GET /queries/:queryId route.
    purgeEngine.generate(query.query_id, req.user, { filters, facilityCode }).catch(() => {
      /* generate() persists its own terminal status in every path */
    }).finally(endJob);

    res.status(202).json(toPublicQuery(await queryManager.getQuery(query.query_id)));
  })
);

// The canonical, current report - whatever the most recent SUCCESSFUL
// generate produced. `status` always tells the caller exactly what
// they're looking at - same CURRENT/STALE_PREVIOUS/NO_SNAPSHOT convention
// as GET /nexs-asrs-dump/current.
router.get(
  "/current",
  asyncHandler(async (req, res) => {
    const report = purgeEngine.getCurrentReport();
    const lastAttempt = purgeEngine.getLastAttempt();
    const status = purgeEngine.getStatus();
    if (!report) return res.status(404).json({ error: "No Tote Purge report has been generated yet.", status, lastAttempt });
    res.json({ ...report, status, lastAttempt });
  })
);

module.exports = router;
