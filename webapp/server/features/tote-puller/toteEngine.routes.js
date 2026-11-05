// HTTP surface for the Tote Pull Engine FOUNDATION (Manual session only -
// no Auto Mode, no priority scoring, no Supervisor Dump). Deliberately a
// separate top-level router (mounted at /api/v1/tote-engine, not nested
// under /api/v1/queries) so its /sessions/:sessionId path can never collide
// with queries.routes.js's own /:queryId wildcard route.
//
// Every actual Quadron pull a session performs still goes through the
// existing, unmodified capabilityManager.requestCapability("PULL_QUADRON_TOTE",
// ...) - this router only exposes session lifecycle (create/get/stop) on
// top of server/features/tote-puller/totePullEngine.js.

const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const asyncHandler = require("../../platform/http/asyncHandler");
const config = require("../../config");
const { defaultEngine } = require("./totePullEngine");
const { applyDefaultInstanceCode } = require("./zonePicker");

const router = express.Router();
router.use(requireAuth);

// instanceCode is backend/configuration information (e.g. "LK-069"), not
// something the Manual Tote Puller UI collects from the operator anymore -
// applyDefaultInstanceCode() fills it in from config.quadronInstanceCode
// (the same default GET_QUADRON_INVENTORY already uses) wherever the
// client omitted it, before validation ever runs. totePullEngine.js and
// zonePicker.js's own validation/selection logic are completely unchanged -
// instanceCode is still required by the time it reaches them, exactly as
// before; only WHO supplies it changed.
router.post(
  "/sessions",
  asyncHandler(async (req, res) => {
    const { totes, zone, instanceCode, multiZone, zones, purpose } = req.body || {};
    const resolved = applyDefaultInstanceCode({ multiZone: !!multiZone, zone, instanceCode, zones }, config.quadronInstanceCode);
    const result = await defaultEngine.createAndStart({ user: req.user, totes, purpose, ...resolved });
    if (!result.ok) return res.status(result.code).json({ error: result.reason });
    res.status(202).json(result.session);
  })
);

router.get(
  "/sessions/:sessionId",
  asyncHandler(async (req, res) => {
    const result = defaultEngine.get(req.params.sessionId, req.user);
    if (!result.ok) return res.status(result.code).json({ error: result.reason });
    res.json(result.session);
  })
);

router.post(
  "/sessions/:sessionId/stop",
  asyncHandler(async (req, res) => {
    const result = defaultEngine.stop(req.params.sessionId, req.user);
    if (!result.ok) return res.status(result.code).json({ error: result.reason });
    res.json(result.session);
  })
);

module.exports = router;
