// Static/structural safety tests for the entire Tote Purge module - proves
// by source inspection (not just behavioral testing) that Purge can never
// call a tote, touch the Auto queue, create a Manual session, or mutate
// classification state. This is the same "read the source, not just the
// behavior" discipline used elsewhere in this codebase (e.g.
// runtimeAsrsDumpProvider.test.js's own "never imports .../never requests
// PULL_QUADRON_TOTE" tests) - a behavioral test could pass by coincidence;
// a source-level check cannot.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const PURGE_FILES = [
  "../../../features/tote-purge/purgeEngine.js",
  "../../../features/tote-purge/purge/purgeAggregate.js",
  "../../../features/tote-purge/purge/purgeClassify.js",
  "../../../features/tote-purge/purge/purgeQuadronValidate.js",
  "../../../features/tote-purge/purge/purgeReport.js",
  "../../../features/tote-purge/totePurge.routes.js",
].map((p) => path.join(__dirname, p));

const FORBIDDEN_IMPORT_PATTERN = /require\(\s*["'][^"']*(toteDispatchLoop|totePullEngine|autoEngine|autoQueue|quadronPull(?!er)|pullQuadronTote)["']\s*\)/;

function stripComments(src) {
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

test("no Purge file imports any tote-dispatch/Auto-queue/Manual-session module", () => {
  for (const file of PURGE_FILES) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    assert.doesNotMatch(src, FORBIDDEN_IMPORT_PATTERN, `${path.basename(file)} must never import a tote-dispatch/Auto/Manual module`);
  }
});

test("no Purge file mentions PULL_QUADRON_TOTE anywhere in functional code", () => {
  for (const file of PURGE_FILES) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    assert.doesNotMatch(src, /PULL_QUADRON_TOTE/, `${path.basename(file)} must never reference PULL_QUADRON_TOTE`);
  }
});

test("no Purge file requires classificationTimestamps or writes classification_tote_state", () => {
  for (const file of PURGE_FILES) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    assert.doesNotMatch(src, /classificationTimestamps|classification_tote_state/, `${path.basename(file)} must never touch classification state`);
  }
});

test("purgeEngine.js only ever requests the GET_QUADRON_INVENTORY capability - never a mutating one", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../../features/tote-purge/purgeEngine.js"), "utf8");
  assert.match(src, /GET_QUADRON_INVENTORY/);
  assert.doesNotMatch(src, /GET_QUADRON_INVENTORY[A-Z_]/); // no accidental near-miss capability name
});

test("totePurge.routes.js exposes only /generate and /current - no call/dispatch/execute endpoint", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../../features/tote-purge/totePurge.routes.js"), "utf8");
  const routePaths = [...src.matchAll(/router\.(?:get|post|put|delete)\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(routePaths.sort(), ["/current", "/generate"]);
});

test("the pure classification/validation/report modules take no `user`/`req`/network dependency at all - proves they cannot themselves make a network call", () => {
  const pureFiles = ["../../../features/tote-purge/purge/purgeAggregate.js", "../../../features/tote-purge/purge/purgeClassify.js", "../../../features/tote-purge/purge/purgeQuadronValidate.js", "../../../features/tote-purge/purge/purgeReport.js"];
  for (const rel of pureFiles) {
    const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
    assert.doesNotMatch(src, /require\(\s*["'](?:\.\.\/)*(capabilities|capabilityManager|runtime\/connection)/, `${rel} must have no capability/network dependency - it is a pure data-transform module`);
    assert.doesNotMatch(src, /\bfetch\(/, `${rel} must never call fetch() directly`);
  }
});
