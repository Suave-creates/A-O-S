// Pure unit tests for server/platform/session/localDevGuard.js - the ASO_LOCAL_DEV /
// NODE_ENV=production startup guard. No database, no network, no Express,
// no process spawning.

const test = require("node:test");
const assert = require("node:assert/strict");
const { assertLocalDevModeSafe, isLocalDevAuthEnabled } = require("../../../platform/session/localDevGuard");

test("ASO_LOCAL_DEV=true + NODE_ENV=production throws (refuses to start)", () => {
  assert.throws(() => assertLocalDevModeSafe({ asoLocalDev: true, nodeEnv: "production" }), /production/);
});

test("ASO_LOCAL_DEV=true + NODE_ENV=development does NOT throw", () => {
  assert.doesNotThrow(() => assertLocalDevModeSafe({ asoLocalDev: true, nodeEnv: "development" }));
});

test("ASO_LOCAL_DEV=false + NODE_ENV=production does NOT throw (the normal production case)", () => {
  assert.doesNotThrow(() => assertLocalDevModeSafe({ asoLocalDev: false, nodeEnv: "production" }));
});

test("ASO_LOCAL_DEV=false + NODE_ENV=development does NOT throw", () => {
  assert.doesNotThrow(() => assertLocalDevModeSafe({ asoLocalDev: false, nodeEnv: "development" }));
});

test("isLocalDevAuthEnabled: true only when BOTH asoLocalDev AND nodeEnv==='development'", () => {
  assert.equal(isLocalDevAuthEnabled({ asoLocalDev: true, nodeEnv: "development" }), true);
  assert.equal(isLocalDevAuthEnabled({ asoLocalDev: false, nodeEnv: "development" }), false);
  assert.equal(isLocalDevAuthEnabled({ asoLocalDev: true, nodeEnv: "production" }), false);
});

test("isLocalDevAuthEnabled: NODE_ENV must be EXACTLY 'development' - 'test' does not qualify", () => {
  assert.equal(isLocalDevAuthEnabled({ asoLocalDev: true, nodeEnv: "test" }), false);
});

test("isLocalDevAuthEnabled: an unset/undefined nodeEnv does not qualify", () => {
  assert.equal(isLocalDevAuthEnabled({ asoLocalDev: true, nodeEnv: undefined }), false);
});

test("isLocalDevAuthEnabled: a falsy/undefined asoLocalDev never enables the bypass, regardless of nodeEnv", () => {
  assert.equal(isLocalDevAuthEnabled({ asoLocalDev: undefined, nodeEnv: "development" }), false);
  assert.equal(isLocalDevAuthEnabled({ asoLocalDev: 0, nodeEnv: "development" }), false);
});
