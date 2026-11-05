// Pure guard for the ASO_LOCAL_DEV / NODE_ENV combination. config.js calls
// assertLocalDevModeSafe() once, at module load time, before the rest of
// the config object is even built - an unsafe combination throws and
// crashes the process before any route, DB, or session code ever runs.
//
// Deliberately extracted as pure functions (no config.js/process.env
// access here) so they are independently unit-testable without spawning a
// child process or manipulating the require cache.

// Refuses to start if ASO_LOCAL_DEV=true is ever combined with
// NODE_ENV=production - the one combination that must be structurally
// impossible, not just "off by default".
function assertLocalDevModeSafe({ asoLocalDev, nodeEnv }) {
  if (asoLocalDev && nodeEnv === "production") {
    throw new Error(
      "Refusing to start: ASO_LOCAL_DEV=true is set while NODE_ENV=production. " +
        "ASO_LOCAL_DEV bypasses database-backed authentication and must never run " +
        "against a production environment. Unset ASO_LOCAL_DEV or fix NODE_ENV before starting."
    );
  }
}

// The ONLY place ASO_LOCAL_DEV actually takes effect. Requires NODE_ENV to
// be EXACTLY "development" - not merely "not production" (e.g. "test" does
// not qualify, so the automated test suite can never accidentally run with
// the bypass active).
function isLocalDevAuthEnabled({ asoLocalDev, nodeEnv }) {
  return !!asoLocalDev && nodeEnv === "development";
}

module.exports = { assertLocalDevModeSafe, isLocalDevAuthEnabled };
