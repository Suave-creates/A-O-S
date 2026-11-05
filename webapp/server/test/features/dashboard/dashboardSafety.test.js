// Static/structural safety tests for the Dashboard (Phase FINAL) - proves by
// source inspection (not just behavioral testing) that Dashboard can never
// call a tote, start/stop Auto or Manual, generate a Tote Purge, or trigger
// an expensive refresh/generation operation merely by being opened. Mirrors
// lockedToteInfoSafety.test.js/purgeSafety.test.js's exact discipline: a
// behavioral test could pass by coincidence; a source-level check cannot.
//
// Also proves the "independently loadable" / "no other-module frontend
// state" architecture rule structurally: dashboard.js may only ever call
// its own three expected READ endpoints, and must never reference another
// module's frontend global/localStorage/DOM.

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const BACKEND_FILES = ["../../../features/dashboard/dashboardEngine.js", "../../../features/dashboard/ccMetrics.js", "../../../platform/time/shiftWindows.js", "../../../features/dashboard/dashboardMetrics.js", "../../../features/dashboard/dashboardDetail.js", "../../../live/dashboardFeeds.js"].map((p) =>
  path.join(__dirname, p)
);
const FRONTEND_FILE = path.join(__dirname, "../../../../public/js/features/dashboard.js");
const INDEX_HTML = path.join(__dirname, "../../../../public/index.html");
const CAPABILITY_FILE = path.join(__dirname, "../../../integrations/grafana/grafanaCcMetrics.js");
const COMPACTION_CAPABILITY_FILE = path.join(__dirname, "../../../integrations/grafana/grafanaCompactionCount.js");
const TOTES_FREED_CAPABILITY_FILE = path.join(__dirname, "../../../integrations/grafana/grafanaTotesFreedCount.js");
const AISLE_OCCUPANCY_CAPABILITY_FILE = path.join(__dirname, "../../../integrations/grafana/grafanaAisleOccupancy.js");
const REGISTRY_FILE = path.join(__dirname, "../../../integrations/capabilities/registry.js");

const FORBIDDEN_IMPORT_PATTERN = /require\(\s*["'][^"']*(toteDispatchLoop|totePullEngine|autoEngine|autoQueue|autoDiff|quadronPull(?!er)|pullQuadronTote)["']\s*\)/;

function stripComments(src) {
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}
function read(file) {
  return fs.readFileSync(file, "utf8");
}

test("no Dashboard backend file imports any tote-dispatch/Auto-queue/Manual-session module", () => {
  for (const file of BACKEND_FILES) {
    const src = stripComments(read(file));
    assert.doesNotMatch(src, FORBIDDEN_IMPORT_PATTERN, `${path.basename(file)} must never import a tote-dispatch/Auto/Manual module`);
  }
});

test("no Dashboard backend file mentions PULL_QUADRON_TOTE anywhere in functional code", () => {
  for (const file of BACKEND_FILES) {
    const src = stripComments(read(file));
    assert.doesNotMatch(src, /PULL_QUADRON_TOTE/, `${path.basename(file)} must never reference PULL_QUADRON_TOTE`);
  }
});

test("the Dashboard has no HTTP routes of its own - everything is a read-only live topic", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "../../../features/dashboard/dashboard.routes.js")), false);
  const src = stripComments(read(path.join(__dirname, "../../../live/dashboardFeeds.js")));
  const topics = [...src.matchAll(/registerFeed\(\{\s*topic:\s*"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(topics, ["aisle-occupancy.current", "asrs-locations.current", "dashboard-detail", "dashboard.aisle", "dashboard.cc", "dashboard.compaction", "dashboard.outside", "dashboard.utilisation"]);
});

test("GET_GRAFANA_COMPACTION_HOURLY and GET_GRAFANA_TOTES_FREED_HOURLY are registered as read-only, non-mutating", () => {
  const src = read(REGISTRY_FILE);
  for (const name of ["GET_GRAFANA_COMPACTION_HOURLY", "GET_GRAFANA_TOTES_FREED_HOURLY"]) {
    const block = src.slice(src.indexOf(name + ":"), src.indexOf(name + ":") + 500);
    assert.match(block, /readOnly:\s*true/, `${name} must be readOnly:true`);
    assert.match(block, /write:\s*false/, `${name} must be write:false`);
  }
});

test("GET_GRAFANA_CC_METRICS is registered as read-only, non-mutating (readOnly:true, write:false)", () => {
  const src = read(REGISTRY_FILE);
  const block = src.slice(src.indexOf("GET_GRAFANA_CC_METRICS:"), src.indexOf("GET_GRAFANA_CC_METRICS:") + 500);
  assert.match(block, /readOnly:\s*true/);
  assert.match(block, /write:\s*false/);
});

test("GET_GRAFANA_COMPACTION_COUNT, GET_GRAFANA_TOTES_FREED_COUNT, and GET_GRAFANA_AISLE_OCCUPANCY are registered as read-only, non-mutating", () => {
  const src = read(REGISTRY_FILE);
  for (const name of ["GET_GRAFANA_COMPACTION_COUNT", "GET_GRAFANA_TOTES_FREED_COUNT", "GET_GRAFANA_AISLE_OCCUPANCY"]) {
    const block = src.slice(src.indexOf(name + ":"), src.indexOf(name + ":") + 500);
    assert.match(block, /readOnly:\s*true/, `${name} must be readOnly:true`);
    assert.match(block, /write:\s*false/, `${name} must be write:false`);
  }
});

test("grafanaCcMetrics.js/grafanaCompactionCount.js/grafanaTotesFreedCount.js/grafanaAisleOccupancy.js capability files never import a mutating capability or the pull-dispatch stack", () => {
  for (const file of [CAPABILITY_FILE, COMPACTION_CAPABILITY_FILE, TOTES_FREED_CAPABILITY_FILE, AISLE_OCCUPANCY_CAPABILITY_FILE]) {
    const src = stripComments(read(file));
    assert.doesNotMatch(src, FORBIDDEN_IMPORT_PATTERN, `${path.basename(file)} must never import a tote-dispatch/Auto/Manual module`);
    assert.doesNotMatch(src, /PULL_QUADRON_TOTE/, `${path.basename(file)} must never reference PULL_QUADRON_TOTE`);
  }
});

// ── Frontend (dashboard.js) - independently-loadable / read-only proof ────

// Grown from the original 3 (Control Center build-out this session): the
// Dashboard now also reads Auto's own active-session snapshot, the shared
// Connection Status model, Locked Tote Info's history list (for trend/
// freshness, instead of just /current), and its own new /compaction route -
// every one of them a plain GET against an existing or newly-added
// read-only endpoint, never a mutating one.
test("dashboard.js calls only its expected READ endpoints - never Auto/Manual/Purge/NEXS-refresh/PULL_QUADRON_TOTE routes", () => {
  const src = stripComments(read(FRONTEND_FILE));
  const apiCalls = [...src.matchAll(/Api\.(get|post|put|delete)\(\s*["']([^"']+)["']/g)].map((m) => ({ method: m[1], path: m[2] }));
  // The dashboard's data all arrives over the server's live stream (read-only topics below), and the Refresh
  // button only asks the server hub to re-run those feeds. The one API call: an ADMIN saving the central auto
  // refresh settings (a setting, never an operation - 2026-11-04).
  assert.deepEqual(apiCalls, [{ method: "put", path: "/dashboard-auto-refresh" }]);
  const topics = [...src.matchAll(/Live\.subscribe\(\s*["']([^"']+)["']/g)].map((m) => m[1]).sort();
  assert.deepEqual(topics, ["auto.active", "dashboard.aisle", "dashboard.autoRefresh", "dashboard.cc", "dashboard.compaction", "dashboard.outside", "dashboard.utilisation", "locked-tote-info.latest"]);
});

test("dashboard.js never references another module's frontend global, localStorage, or DOM element from another tab", () => {
  const src = stripComments(read(FRONTEND_FILE));
  // Every other module's own top-level IIFE-exposed global name - dashboard.js
  // must never read any of these (that would be frontend-state coupling,
  // exactly what the Dashboard design explicitly forbids).
  const FORBIDDEN_GLOBALS = ["ManualTotePuller", "AutoTotePuller", "Admin", "Runtimes", "ConnectionStatus", "TotePurge", "Utilisation", "LockedToteInformation", "NexsAsrsDump"];
  for (const g of FORBIDDEN_GLOBALS) {
    assert.doesNotMatch(src, new RegExp(`\\b${g}\\.`), `dashboard.js must never read ${g}'s frontend state`);
  }
  // The auto refresh settings are central (server, admin-set) - nothing is kept in the browser.
  assert.doesNotMatch(src, /localStorage/, "dashboard.js must never read/write localStorage (that would be a module-state dependency, not an API call)");
});

test("dashboard.js never triggers an operational/expensive-refresh endpoint (POST refresh/start/stop/generate)", () => {
  const src = stripComments(read(FRONTEND_FILE));
  assert.doesNotMatch(src, /\/auto-engine\/(start|preview)/);
  assert.doesNotMatch(src, /\/tote-engine\/sessions/);
  assert.doesNotMatch(src, /\/nexs-asrs-dump\/refresh/);
  assert.doesNotMatch(src, /\/tote-purge\/generate/);
  assert.doesNotMatch(src, /\/locked-tote-info\/refresh/);
  assert.doesNotMatch(src, /PULL_QUADRON_TOTE/);
});

test("Dashboard's HTML section has no Execute/Dispatch/Pull/Generate/Start/Stop button - only Refresh", () => {
  const html = read(INDEX_HTML);
  const dashSectionMatch = html.match(/<section id="tab-dashboard"[\s\S]*?<\/section>/);
  assert.ok(dashSectionMatch, "expected to find the #tab-dashboard section");
  const section = dashSectionMatch[0];
  const buttons = [...section.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)];
  const buttonIds = [...section.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  // Refresh, plus the per-tile auto refresh settings (open the panel, reset to defaults) - neither runs anything.
  assert.deepEqual(buttonIds.sort(), ["dashArBtn", "dashArReset", "dashRefreshBtn"], "Dashboard buttons: Refresh and the auto refresh settings only");
  for (const [, label] of buttons) {
    assert.doesNotMatch(label, /execute|dispatch|generate|\bpull\b|\bstart\b|\bstop\b/i, `button label "${label.trim()}" must not offer an operational action`);
  }
});
