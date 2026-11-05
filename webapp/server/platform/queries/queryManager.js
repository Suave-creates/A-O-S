// Selector for the Query Manager interface. Every consumer
// (capabilityManager.js, toteEngine.routes.js, autoEngine.js,
// queries.routes.js, admin.routes.js, toteUtilisationJob.js) requires ONLY
// this file, never queryManagerMysql.js or queryManagerMemory.js directly -
// so they are completely unaware of which backend is active. Mirrors
// server/runtime/registry.js's own mysql/memory selector exactly.
//
//   Query Manager interface
//           |
//           +-- queryManagerMysql.js   (config.queryManagerMode="mysql", default) -> production_tracker
//           +-- queryManagerMemory.js  (config.queryManagerMode="memory")          -> in-process Map, dev-only
//
// Production refuses to boot on the memory adapter - see the guard below.
//
// config.queryManagerMode is NOT an independently-settable env var - it is
// fully derived from config.localDevAuthEnabled (see server/config.js),
// which is itself already gated to ASO_LOCAL_DEV=true AND
// NODE_ENV=development by server/platform/session/localDevGuard.js. There is
// deliberately no separate QUERY_MANAGER_MODE knob: the requirement is that
// memory mode activates ONLY under that exact combination, and giving it
// its own env var would create a way to decouple the two. The explicit
// production guard below is still kept, matching registry.js's own belt-
// and-suspenders style, even though isLocalDevAuthEnabled() already makes
// this combination unreachable in production by construction.

const config = require("../../config");

if (config.isProduction && config.queryManagerMode === "memory") {
  throw new Error(
    "queryManagerMode=memory is not allowed when NODE_ENV=production. " +
      "This should be structurally unreachable (queryManagerMode is derived from " +
      "ASO_LOCAL_DEV+NODE_ENV=development) - if you see this, something upstream computed it incorrectly."
  );
}

let impl;
if (config.queryManagerMode === "memory") {
  console.warn(
    "[queryManager] ASO_LOCAL_DEV local development mode - Query Manager is IN-MEMORY ONLY and will be " +
      "lost on restart. This is a development convenience, never used in production. Classification/" +
      "Manual/Auto sessions created now will not survive a backend restart."
  );
  impl = require("./queryManagerMemory");
} else if (config.queryManagerMode === "mysql") {
  impl = require("./queryManagerMysql");
} else {
  throw new Error(`Invalid queryManagerMode: "${config.queryManagerMode}" (expected "mysql" or "memory")`);
}

module.exports = impl;
