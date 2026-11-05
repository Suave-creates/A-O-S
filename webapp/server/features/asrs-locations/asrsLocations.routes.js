// HTTP surface for ASRS Locations - a READ-ONLY replica of the physical
// ASRS racking (occupied vs. empty slots), for the manual audit workflow.
// Never touches Manual/Auto Tote Puller state, never dispatches a write
// capability. The only thing it writes is the auditors' own findings
// (location_audit_marks, this site day only):
//   POST /audit-marks        {slotKeys, outcome: EMPTY|TOTE_FOUND, toteId?}
//   POST /audit-marks/clear  {slotKeys}
// The screen reads the marks from the live topic "asrs-locations.marks".

const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const asyncHandler = require("../../platform/http/asyncHandler");
const queryManager = require("../../platform/queries/queryManager");
const asrsLocationsEngine = require("./asrsLocationsEngine");
const auditMarks = require("./auditMarks");
const auditLog = require("../../platform/audit/auditLog");

const router = express.Router();
router.use(requireAuth);

router.get(
  "/current",
  asyncHandler(async (req, res) => {
    const query = await queryManager.createQuery({
      userId: req.user.id,
      operation: "ASRS_LOCATIONS_CURRENT",
      parameters: {},
    });
    try {
      const result = await asrsLocationsEngine.getAsrsLocations({ queryId: query.query_id, user: req.user });
      res.json(result);
    } catch (e) {
      res.status(e.code || 502).json({ error: e.message });
    }
  })
);

router.post(
  "/audit-marks",
  asyncHandler(async (req, res) => {
    const { slotKeys, outcome, toteId } = req.body || {};
    const r = await auditMarks.mark({ slotKeys, outcome, toteId, userId: req.user.id });
    if (r.error) return res.status(400).json({ error: r.error });
    await auditLog.record(req.user.id, "LOCATION_AUDIT_MARKED", { outcome, count: r.count, siteDay: r.siteDay, ...(r.count === 1 ? { slotKey: slotKeys[0] } : {}) });
    res.json(r);
  })
);

router.post(
  "/audit-marks/clear",
  asyncHandler(async (req, res) => {
    const { slotKeys } = req.body || {};
    const r = await auditMarks.clear({ slotKeys });
    if (r.error) return res.status(400).json({ error: r.error });
    await auditLog.record(req.user.id, "LOCATION_AUDIT_CLEARED", { count: r.count, siteDay: r.siteDay });
    res.json(r);
  })
);

module.exports = router;
