const express = require("express");
const requireAuth = require("../../platform/http/requireAuth");
const requirePanel = require("../../platform/http/requirePanel");
const asyncHandler = require("../../platform/http/asyncHandler");
const queryManager = require("../../platform/queries/queryManager");
const { runToteUtilisation, getResult, listRecentResults } = require("./toteUtilisationJob");
const capabilityManager = require("../../integrations/capabilities/capabilityManager");
const capabilityRegistry = require("../../integrations/capabilities/registry");
const quadronInventory = require("../../integrations/quadron/quadronInventory");
const pullQuadronTote = require("../../integrations/quadron/pullQuadronTote");
const quadronPullLock = require("../../integrations/quadron/quadronPullLock");
const { waitForTerminal } = require("../../integrations/quadron/quadronPull");
const { toPublicQuery } = require("../../integrations/capabilities/toPublicQuery");

const router = express.Router();
router.use(requireAuth);

const CAP_FIELDS = ["largeLens", "largeFrame", "smallLens", "smallFrame"];

function sanitiseCaps(input) {
  const caps = {};
  if (!input || typeof input !== "object") return caps;
  for (const key of CAP_FIELDS) {
    if (input[key] == null || input[key] === "") continue;
    const n = Number(input[key]);
    if (!Number.isFinite(n) || n <= 0) {
      const err = new Error(`caps.${key} must be a positive number`);
      err.status = 400;
      throw err;
    }
    caps[key] = n;
  }
  return caps;
}

router.post(
  "/tote-utilisation",
  requirePanel("utilisation"),
  asyncHandler(async (req, res) => {
    let caps;
    try {
      caps = sanitiseCaps((req.body || {}).caps);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }

    const query = await queryManager.createQuery({
      userId: req.user.id,
      operation: "TOTE_UTILISATION",
      parameters: { caps },
    });

    // Fire-and-forget: the job runs asynchronously; the client polls
    // GET /queries/:queryId for status/result and may call cancel while it's
    // QUEUED/RUNNING. This is what makes query status + cancellation
    // observable rather than instantaneous.
    runToteUtilisation(query.query_id, caps).catch(() => {
      /* runToteUtilisation itself persists FAILED/CANCELLED/TIMEOUT - nothing
         further to do with a rejected promise here. */
    });

    res.status(202).json(toPublicQuery(await queryManager.getQuery(query.query_id)));
  })
);

// Phase 3C: lightweight history list for the Tote Utilisation UI's
// historical-run comparison feature - read-only, reuses the existing
// tote_utilisation_results rows (no schema change), never the full detail
// blob for more than one run at a time (see listRecentResults()'s own
// comment). Site-wide: everyone sees every run.
router.get(
  "/tote-utilisation/history",
  requirePanel("utilisation"),
  asyncHandler(async (req, res) => {
    const history = await listRecentResults({ limit: req.query.limit });
    res.json(history);
  })
);

// Phase 2: capability-backed operations follow the exact same
// create-query-then-poll shape as tote-utilisation above - the only
// difference is the work happens on a remote runtime instead of a direct
// backend fetch. See server/integrations/capabilities/capabilityManager.js.
//
// (Standalone POST /grafana-locked-totes and POST /quadron-inventory routes
// were removed as part of the Locked Tote Information unification - that
// module now gets both via classificationEngine.js's own refresh(), which
// already dispatches GET_GRAFANA_LOCKED_TOTES/GET_QUADRON_INVENTORY as part
// of every classification run; its own persisted lockedQueryId/
// inventoryQueryId are reused directly by /reconcile-quadron-grafana below,
// so no second, standalone fetch of either capability is needed anywhere.)

// The first MUTATING capability - real-world effect: physically requests
// Quadron move a container to a station. Validated here before a query is
// even created (mirrors the existing extension's own Start-button gating:
// host/tote/zone all required before a call is ever attempted), and guarded
// against a duplicate in-flight pull for the same tote (no new table - see
// queryManager.findActiveByParam).
//
// Single-flight (added for the Tote Pull Engine): this is an interactive,
// human-initiated request, so it fails fast with 409 if the global
// PULL_QUADRON_TOTE lock is already held (by the Engine's own sequential
// loop, or by another concurrent standalone request) - it does NOT queue
// and silently block the HTTP response. The response shape/timing below is
// otherwise UNCHANGED from before this lock existed: 202 with the freshly
// created query, immediately, same as every other capability route - the
// lock is acquired and held in the background for the pull's full
// dispatch-through-terminal duration, so the NEXT pull (Engine or another
// standalone request) genuinely cannot start until this one is done, even
// though this HTTP response doesn't wait for that.
router.post(
  "/pull-quadron-tote",
  requirePanel("totePuller"),
  asyncHandler(async (req, res) => {
    const { toteId, zone, instanceCode } = req.body || {};

    if (typeof toteId !== "string" || !pullQuadronTote.TOTE_ID_REGEX.test(toteId)) {
      return res.status(400).json({ error: `toteId must match ${pullQuadronTote.TOTE_ID_REGEX}` });
    }
    if (typeof zone !== "string" || !zone.trim()) {
      return res.status(400).json({ error: "zone is required" });
    }
    if (typeof instanceCode !== "string" || !instanceCode.trim()) {
      return res.status(400).json({ error: "instanceCode is required" });
    }

    const inFlight = await queryManager.findActiveByParam("PULL_QUADRON_TOTE", "toteId", toteId);
    if (inFlight) {
      return res.status(409).json({ error: `Tote ${toteId} already has a pull in progress (${inFlight.query_id})` });
    }

    if (quadronPullLock.isBusy()) {
      return res.status(409).json({ error: "A Quadron pull is already in progress. Try again shortly." });
    }

    let resolveDispatch, rejectDispatch;
    const dispatched = new Promise((res_, rej_) => {
      resolveDispatch = res_;
      rejectDispatch = rej_;
    });

    quadronPullLock
      .withPullLock(async () => {
        const result = await capabilityManager.requestCapability({
          user: req.user,
          capabilityName: "PULL_QUADRON_TOTE",
          params: { toteId, zone: zone.trim(), instanceCode: instanceCode.trim() },
        });
        resolveDispatch(result);
        if (result.ok) {
          // Hold the lock until THIS pull is actually finished on the
          // runtime side, not merely until a query row exists for it.
          await waitForTerminal(result.query.query_id).catch(() => {});
        }
      })
      .catch((e) => rejectDispatch(e));

    const result = await dispatched;
    if (!result.ok) return res.status(result.code).json({ error: result.reason });
    res.status(202).json(toPublicQuery(result.query));
  })
);

// Pure comparison of two already-completed queries the requesting user is
// already authorized to see - computed on demand, nothing persisted (same
// "no new table this phase" decision as the capabilities themselves).
router.post(
  "/reconcile-quadron-grafana",
  requirePanel("lockedToteInfo"),
  asyncHandler(async (req, res) => {
    const { grafanaQueryId, quadronQueryId } = req.body || {};
    if (typeof grafanaQueryId !== "string" || typeof quadronQueryId !== "string" || !grafanaQueryId || !quadronQueryId) {
      return res.status(400).json({ error: "grafanaQueryId and quadronQueryId are required" });
    }

    const [grafanaQuery, quadronQuery] = await Promise.all([
      queryManager.getQuery(grafanaQueryId),
      queryManager.getQuery(quadronQueryId),
    ]);
    if (!grafanaQuery || !quadronQuery) return res.status(404).json({ error: "Query not found" });

    if (grafanaQuery.operation !== "GET_GRAFANA_LOCKED_TOTES") {
      return res.status(400).json({ error: "grafanaQueryId is not a GET_GRAFANA_LOCKED_TOTES query" });
    }
    if (quadronQuery.operation !== "GET_QUADRON_INVENTORY") {
      return res.status(400).json({ error: "quadronQueryId is not a GET_QUADRON_INVENTORY query" });
    }
    // Terminal-but-not-COMPLETED (FAILED/TIMEOUT/CANCELLED) is rejected here,
    // same as a still-running query - never silently reconciled as if it had
    // succeeded (a failed Quadron leg must never read as "everything matched").
    if (grafanaQuery.status !== "COMPLETED") {
      return res.status(409).json({ error: `Grafana query is ${grafanaQuery.status}, not COMPLETED` });
    }
    if (quadronQuery.status !== "COMPLETED") {
      return res.status(409).json({ error: `Quadron query is ${quadronQuery.status}, not COMPLETED` });
    }

    const grafanaResult = capabilityManager.getResult(grafanaQueryId);
    const quadronResult = capabilityManager.getResult(quadronQueryId);
    if (!grafanaResult || !quadronResult) {
      return res.status(404).json({ error: "Result not found (backend may have restarted since these queries ran)" });
    }

    res.json(quadronInventory.reconcileWithGrafana(grafanaResult, quadronResult));
  })
);

router.get(
  "/:queryId",
  asyncHandler(async (req, res) => {
    const query = await queryManager.getQuery(req.params.queryId);
    if (!query) return res.status(404).json({ error: "Query not found" });
    res.json(toPublicQuery(query));
  })
);

router.get(
  "/:queryId/result",
  asyncHandler(async (req, res) => {
    const query = await queryManager.getQuery(req.params.queryId);
    if (!query) return res.status(404).json({ error: "Query not found" });
    if (query.status !== "COMPLETED") {
      return res.status(409).json({ error: `Query is ${query.status}, no result available yet` });
    }

    const isCapabilityBacked = !!capabilityRegistry.getCapability(query.operation);
    const result = isCapabilityBacked ? capabilityManager.getResult(query.query_id) : await getResult(query.query_id);
    if (!result) return res.status(404).json({ error: "Result not found" });
    res.json(result);
  })
);

router.post(
  "/:queryId/cancel",
  asyncHandler(async (req, res) => {
    const result = await queryManager.cancelQuery(req.params.queryId, req.user);
    if (!result.ok) return res.status(result.code).json({ error: result.reason });
    res.json(toPublicQuery(result.query));
  })
);

module.exports = { router, toPublicQuery };
