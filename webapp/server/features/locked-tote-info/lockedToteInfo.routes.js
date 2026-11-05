// Locked Tote Information - read-only. Merges the former "ASRS: Locked
// Totes" and "Classification" tabs into one module. This router must never
// import totePullEngine.js, quadronPullLock.js, or pullQuadronTote.js: the
// whole point of this module is that it cannot pull a tote, create a pull
// session, enter the Quadron pull queue, retry a pull, or call
// PULL_QUADRON_TOTE. See server/features/locked-tote-info/classificationEngine.js.

const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const asyncHandler = require("../../platform/http/asyncHandler");
const queryManager = require("../../platform/queries/queryManager");
const classificationEngine = require("./classificationEngine");

const router = express.Router();
router.use(requireAuth);

// Refresh is a single blocking call from the frontend's perspective - it
// internally requests and awaits all three source capabilities, then
// returns the resulting snapshot directly (unchanged UX from the previous
// standalone Classification tab). The query is created here so it appears
// in Active Queries like every other refresh (LOCKED_TOTE_INFO_REFRESH),
// and classificationEngine.refresh() persists the result to MySQL before
// returning - see that file for the full lifecycle.
router.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const { p0MaxTotes, p1MaxTotes } = req.body || {};
    const query = await queryManager.createQuery({
      userId: req.user.id,
      operation: "LOCKED_TOTE_INFO_REFRESH",
      parameters: { p0MaxTotes: p0MaxTotes ?? null, p1MaxTotes: p1MaxTotes ?? null },
    });
    try {
      const snapshot = await classificationEngine.refresh({ queryId: query.query_id, user: req.user, p0MaxTotes, p1MaxTotes });
      res.json(snapshot);
    } catch (e) {
      res.status(e.code || 502).json({ error: e.message });
    }
  })
);

// The most recent COMPLETED snapshot (MySQL-backed - survives a backend
// restart, unlike the previous in-memory-only currentSnapshot variable).
// null if no refresh has ever completed.
router.get(
  "/current",
  asyncHandler(async (req, res) => {
    const snapshot = await classificationEngine.getCurrentSnapshot();
    res.json(snapshot);
  })
);

// Lightweight history list (summary counts only, never the full per-tote
// dump for more than one run) - site-wide: everyone sees every refresh.
router.get(
  "/history",
  asyncHandler(async (req, res) => {
    const history = await classificationEngine.listRecentResults({ limit: req.query.limit });
    res.json(history);
  })
);

// Full detail for one specific past run, on request only - the history
// list above never carries the full totes array.
router.get(
  "/history/:queryId",
  asyncHandler(async (req, res) => {
    const query = await queryManager.getQuery(req.params.queryId);
    if (!query) return res.status(404).json({ error: "Query not found" });
    if (query.operation !== "LOCKED_TOTE_INFO_REFRESH") {
      return res.status(400).json({ error: "Not a Locked Tote Information refresh query" });
    }
    const snapshot = await classificationEngine.getResult(req.params.queryId);
    if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });
    res.json(snapshot);
  })
);

module.exports = router;
