// GET /api/v1/connection-status - the shared Connection Status model's HTTP
// surface (see lib/connectionStatus.js). Deliberately available to every
// authenticated role, not admin-only: the header component must render for
// every operator on every page.

const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const asyncHandler = require("../../platform/http/asyncHandler");
const { getConnectionStatus } = require("../../integrations/logins/connectionStatus");

const router = express.Router();
router.use(requireAuth);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await getConnectionStatus());
  })
);

module.exports = router;
