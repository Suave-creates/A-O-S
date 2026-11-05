// Tests for server/platform/queries/queryManager.js's mode-selection logic itself
// (mirrors server/runtime/registry.js's own selector). Each scenario needs
// its own fresh require of config.js/queryManager.js with different
// process.env values, so this spawns tiny child processes rather than
// mutating process.env in-process (config.js computes its exported object
// once at require-time - a later env mutation in the same process would
// not change an already-cached module). No real MySQL, no real Quadron
// call anywhere in this file.

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

function runWithEnv(env, script) {
  return execFileSync(process.execPath, ["-e", script], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("default (no ASO_LOCAL_DEV): queryManager selects the MySQL implementation", () => {
  const out = runWithEnv(
    { ASO_LOCAL_DEV: "", NODE_ENV: "production" },
    "const c=require('./server/config.js'); console.log(c.queryManagerMode); const qm=require('./server/platform/queries/queryManager.js'); console.log(require.resolve('./server/platform/queries/queryManager.js') && (qm===require('./server/platform/queries/queryManagerMysql.js')))"
  );
  assert.match(out, /^mysql/);
});

test("ASO_LOCAL_DEV=true + NODE_ENV=development: queryManager selects the memory implementation", () => {
  const out = runWithEnv(
    { ASO_LOCAL_DEV: "true", NODE_ENV: "development" },
    "const c=require('./server/config.js'); console.log(c.queryManagerMode); const qm=require('./server/platform/queries/queryManager.js'); console.log(qm===require('./server/platform/queries/queryManagerMemory.js'))"
  );
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "memory");
  assert.equal(lines[1], "true");
});

test("ASO_LOCAL_DEV=true + NODE_ENV=production: refuses to start (config.js throws)", () => {
  assert.throws(() => {
    runWithEnv({ ASO_LOCAL_DEV: "true", NODE_ENV: "production" }, "require('./server/config.js')");
  });
});

test("ASO_LOCAL_DEV=true + NODE_ENV=test: queryManagerMode stays mysql - NODE_ENV must be EXACTLY development", () => {
  const out = runWithEnv(
    { ASO_LOCAL_DEV: "true", NODE_ENV: "test" },
    "const c=require('./server/config.js'); console.log(c.queryManagerMode);"
  );
  assert.match(out, /^mysql/);
});

test("the selected implementation's exported function set is identical between mysql and memory (same public API)", () => {
  const mysqlKeys = Object.keys(require("../../../platform/queries/queryManagerMysql")).sort();
  const memoryKeys = Object.keys(require("../../../platform/queries/queryManagerMemory")).sort();
  assert.deepEqual(memoryKeys, mysqlKeys);
});

test("queryManager.js itself (the selector) re-exports exactly the currently-selected implementation - no extra/missing keys", () => {
  const selector = require("../../../platform/queries/queryManager");
  const mysqlKeys = Object.keys(require("../../../platform/queries/queryManagerMysql")).sort();
  assert.deepEqual(Object.keys(selector).sort(), mysqlKeys);
});
