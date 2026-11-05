// Graceful shutdown - drains in-flight work and releases external resources
// (the MySQL pool) on SIGTERM/
// SIGINT instead of the process just dying mid-flight, which is what has
// been silently orphaning MySQL connections on every restart until now.
//
// Database review finding (2026-09-04): server/index.js previously had NO
// signal handling at all - every restart (dev iteration, a deploy, a
// crash-restart) abandoned that process's pool instead of draining it.
// Confirmed live against the real production database: 13 connections open
// from this one dev machine, most in Sleep state, several ~2 hours old -
// all orphaned by past restarts during this session. MySQL's own
// wait_timeout/interactive_timeout on that server measured at 28800s (8h),
// so every one of those restarts left up to connectionLimit Sleep
// connections sitting there for up to 8 hours before MySQL itself reaped
// them. This is the actual fix for that: pool.end() is now always called
// on the way out, whether the shutdown drains cleanly or has to be forced.
//
// Exposed as its own small, injectable module (rather than inlined in
// server/index.js, which self-executes start() on require and so can never
// itself be imported by a test) specifically so this logic is independently
// unit-testable against fakes - see server/test/shutdown.test.js.
//
// Guarantee: closeDb() is called EXACTLY ONCE, no matter which path this
// takes - the happy path (the HTTP server drains cleanly, the pool
// close after) or the forced path (something - a long-lived keep-alive
// connection, a hung request - kept the server from draining within
// forceExitMs). The whole point of a "force exit" safety net is worthless
// if the one thing it was protecting (releasing the DB pool) never actually
// runs on that path - so closeDb() is invoked from BOTH the normal
// completion callback and the force-timer callback, guarded to run once.

const DEFAULT_FORCE_EXIT_MS = 10000;

function gracefulShutdown({ httpServer, closeDb, log = console.log, warn = console.warn, forceExitMs = DEFAULT_FORCE_EXIT_MS }) {
  return new Promise((resolve) => {
    let dbClosed = false;
    let settled = false;

    const finish = (drainedCleanly) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolve(drainedCleanly);
    };

    const closeDbOnce = async () => {
      if (dbClosed) return;
      dbClosed = true;
      try {
        await closeDb();
        log("[shutdown] database pool closed.");
      } catch (e) {
        warn("[shutdown] error closing database pool:", e.message);
      }
    };

    const forceTimer = setTimeout(() => {
      warn(`[shutdown] did not drain within ${forceExitMs}ms - forcing the database pool closed and proceeding.`);
      closeDbOnce().then(() => finish(false));
    }, forceExitMs);

    log("[shutdown] closing HTTP server (no new connections accepted)...");
    httpServer.close((err) => {
      if (err) warn("[shutdown] error closing HTTP server:", err.message);
      closeDbOnce().then(() => finish(true));
    });
  });
}

module.exports = { gracefulShutdown };
