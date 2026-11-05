// Selector for "Locked Since" persistence - mirrors server/platform/queries/queryManager.js
// and server/runtime/registry.js's own mysql/memory selector pattern
// exactly. classificationEngine.js requires ONLY this file, never
// classificationTimestampsMysql.js or classificationTimestampsMemory.js
// directly, so it is unaware of which one is active.
//
//   Locked Since interface
//           |
//           +-- classificationTimestampsMysql.js   (config.localStoreMode="mysql", default) -> production_tracker
//           +-- classificationTimestampsMemory.js   (config.localStoreMode="local")           -> local JSON file, dev-only
//
// config.localStoreMode is NOT an independently-settable env var - see
// server/config.js and server/platform/queries/queryManager.js's own comment for why:
// it is fully derived from config.localDevAuthEnabled, so it can never be
// enabled independently of ASO_LOCAL_DEV=true + NODE_ENV=development.

const config = require("../../config");

if (config.isProduction && config.localStoreMode === "local") {
  throw new Error(
    "localStoreMode=local is not allowed when NODE_ENV=production. " +
      "This should be structurally unreachable (localStoreMode is derived from " +
      "ASO_LOCAL_DEV+NODE_ENV=development) - if you see this, something upstream computed it incorrectly."
  );
}

let impl;
if (config.localStoreMode === "local") {
  impl = require("./classificationTimestampsMemory");
} else if (config.localStoreMode === "mysql") {
  impl = require("./classificationTimestampsMysql");
} else {
  throw new Error(`Invalid localStoreMode: "${config.localStoreMode}" (expected "mysql" or "local")`);
}

module.exports = impl;
