const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const requireRole = require("../../platform/http/requireRole");
const asyncHandler = require("../../platform/http/asyncHandler");
const queryManager = require("../../platform/queries/queryManager");
const { toPublicQuery } = require("../../integrations/capabilities/toPublicQuery");

const router = express.Router();
router.use(requireAuth, requireRole("ADMIN"));

router.get(
  "/queries",
  asyncHandler(async (req, res) => {
    const rows = await queryManager.listQueries({ isAdmin: true, limit: 200 });
    res.json(rows.map((r) => ({ ...toPublicQuery(r), user: r.employee_id })));
  })
);

router.post(
  "/queries/:queryId/cancel",
  asyncHandler(async (req, res) => {
    const result = await queryManager.cancelQuery(req.params.queryId, req.user);
    if (!result.ok) return res.status(result.code).json({ error: result.reason });
    res.json(toPublicQuery(result.query));
  })
);

module.exports = router;
