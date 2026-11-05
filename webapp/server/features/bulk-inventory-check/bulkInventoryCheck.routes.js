// HTTP surface for Bulk Inventory Check - 100% READ-ONLY lookup of
// per-partition barcode/SKU data for a bulk-pasted list of totes. Never
// touches Manual/Auto Tote Puller state, never dispatches a write
// capability. Synchronous (like /asrs-locations/current and /one-pager-
// report/generate) rather than create-then-poll - this is a single bounded
// capability dispatch, not a long multi-step job.

const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const asyncHandler = require("../../platform/http/asyncHandler");
const queryManager = require("../../platform/queries/queryManager");
const bulkInventoryCheckEngine = require("./bulkInventoryCheckEngine");
const sharedResults = require("../../platform/storage/sharedResults");

const PANEL = "bulkInventoryCheck";

const router = express.Router();
router.use(requireAuth);

router.post(
  "/check",
  asyncHandler(async (req, res) => {
    const totes = (req.body && req.body.totes) || [];
    const query = await queryManager.createQuery({
      userId: req.user.id,
      operation: "BULK_INVENTORY_CHECK",
      parameters: { toteCount: Array.isArray(totes) ? totes.length : 0 },
    });
    try {
      const result = await bulkInventoryCheckEngine.checkBulkInventory({ queryId: query.query_id, user: req.user, totes });
      await sharedResults.set(PANEL, { result, runBy: (req.user.employeeId || `user ${req.user.id}`), meta: { count: totes.length } });
      res.json(result);
    } catch (e) {
      res.status(e.code || 502).json({ error: e.message });
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
