// Connect-on-demand for NexS (see integrations/logins/nexsLease.js).
//
//   POST /api/v1/nexs/connect    { label }    log in if needed, take a lease -> { leaseId, ttlMs }
//   POST /api/v1/nexs/heartbeat  { leaseId }  renew while the screen is open  -> { ok }
//   POST /api/v1/nexs/release    { leaseId }  the user left                   -> { ok }
//   GET  /api/v1/nexs/status                  { connected, leases, inflight }
//
// NexS is only ever logged in on an explicit connect (a person starting a NexS
// action). Nothing in the background connects.

const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const asyncHandler = require("../../platform/http/asyncHandler");
const lease = require("../../integrations/logins/nexsLease");

const router = express.Router();
router.use(requireAuth);
// sendBeacon posts text/plain; accept it as JSON too.
router.use(express.json({ type: ["application/json", "text/plain"] }));

const CODE_STATUS = { MULTIPLE_SESSIONS: 409, NO_CREDENTIALS: 503, LOGIN_FAILED: 502 };

router.post(
  "/connect",
  asyncHandler(async (req, res) => {
    const label = String((req.body && req.body.label) || "").slice(0, 60);
    try {
      res.json(await lease.acquire({ userId: req.user.id, label }));
    } catch (e) {
      const code = e.code || "CONNECT_FAILED";
      res.status(CODE_STATUS[code] || 502).json({ error: e.message, code });
    }
  })
);

router.post("/heartbeat", (req, res) => {
  res.json({ ok: lease.heartbeat(String((req.body && req.body.leaseId) || ""), req.user.id) });
});

router.post("/release", (req, res) => {
  res.json({ ok: lease.release(String((req.body && req.body.leaseId) || ""), req.user.id) });
});

router.get("/status", (req, res) => {
  res.json(lease.state());
});

module.exports = router;
