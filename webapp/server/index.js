const path = require("node:path");
const express = require("express");
const config = require("./config");
const migrate = require("./platform/db/migrate");
const seedDevUsers = require("./platform/db/seed");
const db = require("./platform/db");
const requireAuth = require("./platform/http/requireAuth");
const requirePanel = require("./platform/http/requirePanel");
const { isMysqlConnectivityError, isMysqlUnavailableError } = require("./platform/db/dbErrorClassifier");
const { gracefulShutdown } = require("./platform/http/shutdown");


async function start() {
  // STRICT LOCAL DEVELOPMENT AUTH MODE (ASO_LOCAL_DEV=true, see
  // server/platform/session/localDevGuard.js) skips MySQL-requiring startup work -
  // without this, a genuinely unreachable office MySQL would make migrate()
  // throw and the whole process would still refuse to start even with the
  // auth bypass on, defeating its entire purpose.
  if (config.localDevAuthEnabled) {
    console.warn(
      "[startup] Skipping database migrations and user seeding (ASO_LOCAL_DEV=true). Any endpoint that itself requires MySQL remains unavailable until it is reachable - authentication itself does not require it in this mode."
    );
  } else {
    await migrate();
    await seedDevUsers();
    db.startWarmPing();
  }

  const app = express();
  app.use(express.json());

  // No auth required - used to verify the process is up and can reach MySQL.
  app.get("/api/health", async (req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ ok: true, db: "up" });
    } catch (e) {
      res.status(503).json({ ok: false, db: "down" });
    }
  });

  app.use("/api/v1/auth", require("./features/auth/auth.routes"));
  app.use("/api/v1/queries", require("./features/tote-utilisation/queries.routes").router);
  app.use("/api/v1/tote-engine", requireAuth, requirePanel("totePuller"), require("./features/tote-puller/toteEngine.routes"));
  app.use("/api/v1/auto-engine", requireAuth, requirePanel("autoPuller"), require("./features/tote-puller/autoEngine.routes"));
  app.use("/api/v1/connection-status", require("./features/connection-status/connectionStatus.routes"));
  app.use("/api/v1/nexs", require("./features/nexs-connection/nexsConnection.routes"));
  app.use("/api/v1/alerts", requireAuth, requirePanel("alerts"), require("./features/alerts/alerts.routes"));
  app.use("/api/v1/users", require("./features/users/users.routes"));
  const liveRouter = require("./live/live.routes")();
  app.use("/api/v1/live", liveRouter);
  app.use("/api/v1/locked-tote-info", requireAuth, requirePanel("lockedToteInfo"), require("./features/locked-tote-info/lockedToteInfo.routes"));
  app.use("/api/v1/nexs-asrs-dump", requireAuth, requirePanel("utilisation", "totePurge", "lockedToteInfo", "asrsLocations"), require("./features/nexs-asrs-dump/nexsAsrsDump.routes"));
  app.use("/api/v1/tote-purge", requireAuth, requirePanel("totePurge"), require("./features/tote-purge/totePurge.routes"));
  app.use("/api/v1/admin", require("./features/admin/admin.routes"));
  app.use("/api/v1/cng-validator", requireAuth, requirePanel("cngValidator"), require("./features/cng-validator/cngValidator.routes"));
  app.use("/api/v1/tracker", requireAuth, requirePanel("tracker"), require("./features/tracker/tracker.routes"));
  app.use("/api/v1/asrs-locations", requireAuth, requirePanel("asrsLocations"), require("./features/asrs-locations/asrsLocations.routes"));
  app.use("/api/v1/one-pager-report", requireAuth, requirePanel("onePagerReport"), require("./features/one-pager-report/onePagerReport.routes"));
  // the Dashboard's central auto refresh settings: everyone with the Dashboard reads them, only an ADMIN changes them
  app.use("/api/v1/dashboard-auto-refresh", requireAuth, requirePanel("dashboard"), require("./live/dashboardAutoRefresh.routes"));
  app.use("/api/v1/asrs-performance", requireAuth, requirePanel("asrsPerformance"), require("./features/one-pager-report/asrsPerformance.routes"));
  app.use("/api/v1/tote-analytics", requireAuth, requirePanel("lockedToteAnalytics"), require("./features/locked-tote-info/toteAnalytics.routes"));
  app.use("/api/v1/bulk-inventory-check", requireAuth, requirePanel("bulkInventoryCheck"), require("./features/bulk-inventory-check/bulkInventoryCheck.routes"));
  app.use("/api/v1/pull-logs", requireAuth, requirePanel("pullerLogs"), require("./features/pull-logs/pullLogs.routes"));

  app.use(
    express.static(path.join(__dirname, "..", "public"), {
      // This installation's mime lookup serves .js as
      // "application/javascript", which classic <script> tags accept fine
      // but Chrome's stricter ES-module MIME check (type="module" and
      // dynamic import(), used by asrsLocations3d.js and the vendored
      // Three.js files) silently rejects - only "text/javascript" passes.
      // Confirmed live: fetch() of a vendored .js file succeeded while
      // import() of the exact same URL failed with "Failed to fetch
      // dynamically imported module", which is Chrome's generic wrapper for
      // this exact MIME mismatch.
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".js")) res.setHeader("Content-Type", "text/javascript; charset=UTF-8");
      },
    })
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Logged server-side only (never in the response): error code + message
    // only, same discipline as db/index.js's own classifyAndLog - never the
    // raw err.sql mysql2 sometimes attaches (can carry bound parameter
    // values), never a stack trace's full local variable context beyond
    // what console.error(err) already includes for the operator reading
    // this log, which is what it's for.
    console.error(err);

    // Only in STRICT LOCAL DEVELOPMENT AUTH MODE, and only for an error
    // that actually looks like MySQL connectivity failing, swap the
    // generic 500 for a clearer message - authentication itself never
    // needed MySQL in this mode, but this particular endpoint's own data
    // does. Every other mode, and every other kind of error, is completely
    // unaffected - this never masks a real application bug as "DB down",
    // never changes behavior when the flag is off, and never fabricates a
    // successful response.
    if (config.localDevAuthEnabled && isMysqlConnectivityError(err)) {
      return res.status(503).json({
        error: "Database unavailable (local dev mode) - this endpoint requires MySQL, which is unreachable.",
      });
    }

    // Database review remediation (2026-09-04, Task 5): the SAME "tell the
    // client this was a database-availability problem, not an application
    // bug" treatment, now in EVERY mode including production - not just
    // local-dev. Previously any of these (MySQL genuinely unreachable, the
    // pool exhausted and db/index.js's own acquire-timeout fired, mysql2's
    // per-statement timeout firing) fell through to the same generic
    // "Internal server error" as a real code bug, indistinguishable to
    // an operator watching the frontend. Still never leaks the host,
    // credentials, or raw SQL - isMysqlUnavailableError() only inspects
    // err.code, and the message below is fixed text, never err.message.
    if (isMysqlUnavailableError(err)) {
      return res.status(503).json({ error: "Database temporarily unavailable - please retry shortly." });
    }

    res.status(500).json({ error: "Internal server error" });
  });

  const server = app.listen(config.port, () => {
    console.log(`ASRS Intelligence & Automation | AOS listening on http://localhost:${config.port}`);
  });

  // Database review remediation (2026-09-04): graceful shutdown on
  // SIGTERM/SIGINT - previously absent entirely, which is the confirmed
  // root cause of the review's "multiple Sleep connections" observation
  // (see server/platform/http/shutdown.js's own header for the live evidence). Wired
  // here rather than left for the OS/process manager to handle via a bare
  // kill, so every restart - dev iteration, a deploy, `pm2 restart`,
  // Ctrl+C - cleanly releases this process's MySQL pool instead of
  // orphaning it. Skipped when MySQL was never touched at startup (memory/
  // local-dev modes) - nothing to close in that case, and db.close() would
  // itself try to reach a pool that was still created (harmless either
  // way, but the log line would be misleading about what actually
  // happened).
  let shuttingDown = false;
  const handleShutdownSignal = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal} - starting graceful shutdown...`);
    // Release this app's NexS session first (NexS allows one per account), so
    // the next start can log in instead of being refused.
    liveRouter.closeAll(); // end SSE streams so the HTTP server can drain
    require("./integrations/logins/nexsAuth").logout().then(() => gracefulShutdown({ httpServer: server, closeDb: db.close })).then((drainedCleanly) => {
      console.log(`[shutdown] complete (${drainedCleanly ? "drained cleanly" : "forced"}). Exiting.`);
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));
  process.on("SIGINT", () => handleShutdownSignal("SIGINT"));

  // The 6-hourly NexS dump schedule is off (operator decision 2026-11-04: no automatic refresh timers) - a screen's
  // refresh asks for a dump when the last one is over 6 hours old (live/dashboardFeeds.js).

  // ASRS Performance: saves the day before every morning at 06:05 IST and fills the month's missing days
  // (needs MySQL, so not in local-dev mode) - see server/live/asrsPerformanceAuto.js.
  if (!config.localDevAuthEnabled) require("./live/asrsPerformanceAuto").start();
  if (!config.localDevAuthEnabled) require("./live").dashboardAutoRefresh.load(); // the admin-set Dashboard auto refresh
}

start().catch((e) => {
  console.error("Failed to start AOS backend:", e.message);
  process.exit(1);
});
