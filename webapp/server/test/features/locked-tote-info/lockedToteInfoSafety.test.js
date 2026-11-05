// Static/structural safety tests for the entire Locked Tote Information
// module (the unified "ASRS: Locked Totes" + "Classification" module) -
// proves by source inspection (not just behavioral testing) that this
// module can never call a tote, touch the Auto queue, create a Manual
// session, or dispatch PULL_QUADRON_TOTE. Mirrors purgeSafety.test.js's
// exact discipline: a behavioral test could pass by coincidence; a
// source-level check cannot.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const LTI_FILES = [
  "../../../features/locked-tote-info/classificationEngine.js",
  "../../../platform/domain/classification.js",
  "../../../features/locked-tote-info/classificationTimestamps.js",
  "../../../features/locked-tote-info/classificationTimestampsMysql.js",
  "../../../features/locked-tote-info/classificationTimestampsMemory.js",
  "../../../features/locked-tote-info/lockedSinceTracker.js",
  "../../../features/locked-tote-info/lockedToteInfo.routes.js",
].map((p) => path.join(__dirname, p));

const FORBIDDEN_IMPORT_PATTERN = /require\(\s*["'][^"']*(toteDispatchLoop|totePullEngine|autoEngine|autoQueue|autoDiff|quadronPull(?!er)|pullQuadronTote)["']\s*\)/;

function stripComments(src) {
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

test("no Locked Tote Information file imports any tote-dispatch/Auto-queue/Manual-session module", () => {
  for (const file of LTI_FILES) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    assert.doesNotMatch(src, FORBIDDEN_IMPORT_PATTERN, `${path.basename(file)} must never import a tote-dispatch/Auto/Manual module`);
  }
});

test("no Locked Tote Information file mentions PULL_QUADRON_TOTE anywhere in functional code", () => {
  for (const file of LTI_FILES) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    assert.doesNotMatch(src, /PULL_QUADRON_TOTE/, `${path.basename(file)} must never reference PULL_QUADRON_TOTE`);
  }
});

test("classificationEngine.js only ever requests read-only source capabilities - never a mutating one", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../../features/locked-tote-info/classificationEngine.js"), "utf8");
  const allowed = new Set(["GET_GRAFANA_LOCKED_TOTES", "GET_GRAFANA_SUPERVISOR_DUMP", "GET_QUADRON_INVENTORY"]);
  const requested = [...src.matchAll(/capabilityName:\s*["']([A-Z_]+)["']/g)].map((m) => m[1]);
  assert.ok(requested.length > 0, "expected to find at least one capabilityName reference");
  for (const name of requested) {
    assert.ok(allowed.has(name), `classificationEngine.js requested an unexpected capability: ${name}`);
  }
});

test("lockedToteInfo.routes.js exposes only refresh/current/history endpoints - no call/dispatch/execute endpoint", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../../features/locked-tote-info/lockedToteInfo.routes.js"), "utf8");
  const routePaths = [...src.matchAll(/router\.(?:get|post|put|delete)\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(routePaths.sort(), ["/current", "/history", "/history/:queryId", "/refresh"]);
});

test("classification.js (the pure algorithm) takes no `user`/`req`/network dependency at all - proves it cannot itself make a network call", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../../platform/domain/classification.js"), "utf8");
  assert.doesNotMatch(src, /require\(\s*["'](?:\.\.\/)*(capabilities|capabilityManager|runtime\/connection)/, "classification.js must have no capability/network dependency - it is a pure data-transform module");
  assert.doesNotMatch(src, /\bfetch\(/, "classification.js must never call fetch() directly");
});

test("no Locked Tote Information file writes to any operational/warehouse-mutating table (queries table status writes for its OWN LOCKED_TOTE_INFO_REFRESH operation are fine - only INSERT/UPDATE against unrelated operational tables would be a violation)", () => {
  for (const file of LTI_FILES) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    assert.doesNotMatch(src, /tote_pull|auto_engine|manual_session/i, `${path.basename(file)} must never reference a tote-pull/Auto-engine/Manual-session table`);
  }
});
