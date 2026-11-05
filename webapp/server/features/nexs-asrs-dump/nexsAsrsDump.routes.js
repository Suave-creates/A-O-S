// HTTP surface for the NEXS ASRS Dump - the single canonical source every
// consumer (this UI, future Tote Purge, future Tote Utilisation) reads.
// Mirrors queries.routes.js's own create-then-poll shape exactly: /refresh
// creates a query and returns immediately (202), the client polls the
// existing generic GET /queries/:queryId route for status, then reads the
// canonical dataset from /current once COMPLETED. No second query-polling
// mechanism invented here.

const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const asyncHandler = require("../../platform/http/asyncHandler");
const queryManager = require("../../platform/queries/queryManager");
const nexsAsrsDumpEngine = require("./nexsAsrsDumpEngine");
const { toPublicQuery } = require("../../integrations/capabilities/toPublicQuery");

const router = express.Router();
router.use(requireAuth);

router.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    if (nexsAsrsDumpEngine.isRunning()) {
      return res.status(409).json({ error: "A NEXS ASRS Dump refresh is already in progress. Wait for it to finish." });
    }

    const query = await queryManager.createQuery({
      userId: req.user.id,
      operation: "NEXS_ASRS_DUMP_REFRESH",
      parameters: {},
    });
    await queryManager.markRunning(query.query_id);

    // Fire-and-forget, matching every other long-running-fetch route in
    // this codebase (Classification refresh, Tote Utilisation) - the HTTP
    // response returns immediately; progress is polled separately via the
    // existing GET /queries/:queryId route.
    nexsAsrsDumpEngine.refresh(query.query_id, req.user).catch(() => {
      /* refresh() persists its own terminal status in every path */
    });

    res.status(202).json(toPublicQuery(await queryManager.getQuery(query.query_id)));
  })
);

// The canonical, current dataset - whatever the most recent SUCCESSFUL
// refresh produced. `status` always tells the caller exactly what they're
// looking at - never silently presents stale data as fresh:
//   "CURRENT"        - the most recent refresh attempt succeeded; this IS that result
//   "STALE_PREVIOUS" - the most recent attempt FAILED; this is an OLDER good result
//   "NO_SNAPSHOT"    - no refresh has ever succeeded (404 - not an empty dataset,
//                       so the UI can distinguish "never refreshed" from
//                       "refreshed, but the source has 0 rows")
router.get(
  "/current",
  asyncHandler(async (req, res) => {
    const snapshot = await nexsAsrsDumpEngine.getCurrentSnapshot();
    const lastAttempt = await nexsAsrsDumpEngine.getLastAttempt();
    const status = await nexsAsrsDumpEngine.getStatus();
    if (!snapshot) return res.status(404).json({ error: "No ASRS Dump refresh has completed yet.", status, lastAttempt });
    res.json({ ...snapshot, status, lastAttempt });
  })
);

module.exports = router;
