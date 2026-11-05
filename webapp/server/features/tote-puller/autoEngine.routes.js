// HTTP surface for Auto Mode (server/features/tote-puller/autoEngine.js). Mirrors
// toteEngine.routes.js's own conventions exactly - same auth middleware,
// same applyDefaultInstanceCode() reuse for zone config, same response
// shapes. Every actual Quadron pull an Auto session performs still goes
// through the existing, unmodified capabilityManager.requestCapability
// ("PULL_QUADRON_TOTE", ...) via quadronPull.pullOneTote() - this router
// only exposes session lifecycle (start/stop/pause/resume/get) on top of
// server/features/tote-puller/autoEngine.js.

const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const asyncHandler = require("../../platform/http/asyncHandler");
const config = require("../../config");
const { defaultEngine } = require("./autoEngine");
const { applyDefaultInstanceCode } = require("./zonePicker");
const autoPreview = require("./autoPreview");

const router = express.Router();
router.use(requireAuth);

// Builds the session config from server defaults, merged with any explicit
// operator overrides from the request body. Phase 7, Issue 5: P0/P1
// thresholds are a fixed business rule (1 tote -> P0, 2-3 -> P1, 4+ -> P2,
// enforced in server/features/locked-tote-info/classification.js) and are deliberately NOT part
// of this config - there is nothing here for an operator to override.
function resolveAutoConfig(body) {
  const overrides = (body && body.config) || {};
  return {
    batchSize: overrides.batchSize ?? config.autoBatchSize,
    callIntervalMs: overrides.callIntervalMs ?? config.autoCallIntervalMs,
    batchIntervalMs: overrides.batchIntervalMs ?? config.autoBatchIntervalMs,
    retryDelayMs: overrides.retryDelayMs ?? config.autoRetryDelayMs,
    cooldownMs: overrides.cooldownMs ?? config.autoCooldownMs,
    lockedDumpRefreshMs: overrides.lockedDumpRefreshMs ?? config.autoLockedDumpRefreshMs,
    supervisorDumpRefreshMs: overrides.supervisorDumpRefreshMs ?? config.autoSupervisorDumpRefreshMs,
    // "Is anyone watching?" reminder: 1 min .. 24 h; the 1-minute answer window is fixed by the server.
    reminderMs: Math.min(24 * 60 * 60000, Math.max(60000, Number(overrides.reminderMs ?? config.autoReminderMs) || config.autoReminderMs)),
    reminderAckMs: config.autoReminderAckMs,
  };
}

router.post(
  "/start",
  asyncHandler(async (req, res) => {
    const { zone, instanceCode, multiZone, zones } = req.body || {};
    const resolvedZones = applyDefaultInstanceCode({ multiZone: !!multiZone, zone, instanceCode, zones }, config.quadronInstanceCode);
    const result = await defaultEngine.start({ user: req.user, ...resolvedZones, config: resolveAutoConfig(req.body) });
    if (!result.ok) return res.status(result.code).json({ error: result.reason });
    // Phase 7, Issue 6/7: 200 (not 202) when this returned an
    // already-running session instead of creating a new one - lets the
    // frontend tell "reconnected" apart from "just started" without
    // needing a body field, mirroring the existing 202-only convention.
    res.status(result.started === false ? 200 : 202).json(result.session);
  })
);

// Phase 7, Issue 6/7: lets the frontend recover from a browser refresh -
// "is there already an Auto session running that I (the logged-in user)
// started?" - without needing to know its sessionId (which only ever lived
// in the now-reloaded page's JS memory). Read-only, dispatches nothing.
router.get(
  "/sessions/active",
  asyncHandler(async (req, res) => {
    const session = defaultEngine.findActive(); // the one shared Auto line, whoever started it
    if (!session) return res.status(404).json({ error: "No active Auto session" });
    res.json(defaultEngine.snapshot(session));
  })
);

// Auto Preview / Dry-Run - shows exactly what Auto WOULD do right now
// (live Locked/Supervisor/Inventory fetch -> the SAME classifyLockedTotes()
// -> the SAME diffAndMerge() -> the SAME AutoQueue, read via the
// non-mutating peekNext()) without ever creating a real Auto session, a
// queries/audit_logs row, or dispatching PULL_QUADRON_TOTE. See
// server/features/tote-puller/autoPreview.js for the full safety invariants.
//
// Uses the EXACT SAME calling-station configuration model as /start above -
// applyDefaultInstanceCode() fills in config.quadronInstanceCode wherever
// omitted (same call, same default source), then autoPreview.runPreview()
// validates via the same validateZoneConfig() /start's own engine uses. A
// calling station is REQUIRED here too, not optional - Preview fails with
// the same 400 /start would give for the same bad/missing zone config.
router.post(
  "/preview",
  asyncHandler(async (req, res) => {
    const { zone, instanceCode, multiZone, zones, batchSize } = req.body || {};
    const resolvedZones = applyDefaultInstanceCode({ multiZone: !!multiZone, zone, instanceCode, zones }, config.quadronInstanceCode);
    const result = await autoPreview.runPreview({
      user: req.user,
      batchSize,
      ...resolvedZones,
    });
    if (!result.ok) return res.status(result.code).json({ error: result.reason });
    res.json(result.preview);
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
    const result = await defaultEngine.stop(req.params.sessionId, req.user);
    if (!result.ok) return res.status(result.code).json({ error: result.reason });
    res.json(result.session);
  })
);

// Acknowledge the "is anyone watching?" reminder (anyone with the Auto Puller panel) - starts the next interval.
router.post(
  "/sessions/:sessionId/ack",
  asyncHandler(async (req, res) => {
    const result = defaultEngine.acknowledge(req.params.sessionId, req.user);
    if (!result.ok) return res.status(result.code).json({ error: result.reason });
    res.json(result.session);
  })
);

router.post(
  "/sessions/:sessionId/pause",
  asyncHandler(async (req, res) => {
    const result = defaultEngine.pause(req.params.sessionId, req.user);
    if (!result.ok) return res.status(result.code).json({ error: result.reason });
    res.json(result.session);
  })
);

router.post(
  "/sessions/:sessionId/resume",
  asyncHandler(async (req, res) => {
    const result = await defaultEngine.resume(req.params.sessionId, req.user);
    if (!result.ok) return res.status(result.code).json({ error: result.reason });
    res.json(result.session);
  })
);

module.exports = router;
