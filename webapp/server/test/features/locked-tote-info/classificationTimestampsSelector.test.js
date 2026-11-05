// Tests for server/features/locked-tote-info/classificationTimestamps.js's mode-selection logic
// itself (mirrors server/test/queryManagerSelector.test.js exactly - see
// that file's own comment for why subprocesses are needed: config.js
// computes its exported object once at require-time). No real MySQL, no
// real Quadron/Grafana/Concinity call anywhere in this file.

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

test("default (no ASO_LOCAL_DEV): classificationTimestamps selects the MySQL implementation", () => {
  const out = runWithEnv(
    { ASO_LOCAL_DEV: "", NODE_ENV: "production" },
    "const c=require('./server/config.js'); console.log(c.localStoreMode); const ct=require('./server/features/locked-tote-info/classificationTimestamps.js'); console.log(ct===require('./server/features/locked-tote-info/classificationTimestampsMysql.js'))"
  );
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "mysql");
  assert.equal(lines[1], "true");
});

test("ASO_LOCAL_DEV=true + NODE_ENV=development: classificationTimestamps selects the memory implementation", () => {
  const out = runWithEnv(
    { ASO_LOCAL_DEV: "true", NODE_ENV: "development" },
    "const c=require('./server/config.js'); console.log(c.localStoreMode); const ct=require('./server/features/locked-tote-info/classificationTimestamps.js'); console.log(ct===require('./server/features/locked-tote-info/classificationTimestampsMemory.js'))"
  );
  const lines = out.trim().split("\n");
  assert.equal(lines[0], "local");
  assert.equal(lines[1], "true");
});

test("ASO_LOCAL_DEV=true + NODE_ENV=production: refuses to start (config.js throws)", () => {
  assert.throws(() => {
    runWithEnv({ ASO_LOCAL_DEV: "true", NODE_ENV: "production" }, "require('./server/config.js')");
  });
});

test("ASO_LOCAL_DEV=true + NODE_ENV=test: localStoreMode stays mysql - NODE_ENV must be EXACTLY development", () => {
  const out = runWithEnv(
    { ASO_LOCAL_DEV: "true", NODE_ENV: "test" },
    "const c=require('./server/config.js'); console.log(c.localStoreMode);"
  );
  assert.match(out, /^mysql/);
});

test("mysql and memory implementations export the same public API", () => {
  const mysqlKeys = Object.keys(require("../../../features/locked-tote-info/classificationTimestampsMysql")).sort();
  const memoryKeys = Object.keys(require("../../../features/locked-tote-info/classificationTimestampsMemory")).sort();
  assert.deepEqual(memoryKeys, mysqlKeys);
});
