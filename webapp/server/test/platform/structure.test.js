// Enforces RULES.md / STRUCTURE.md so the layout can't drift back into
// "everything in lib/". This is a RATCHET: the allowlists below hold the
// couplings that already existed when the structure was introduced - they may
// only shrink. A new violation fails the test; fix the code (or, for a
// genuine composition feature, add the pair here WITH a reason in review).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const WEBAPP = path.join(__dirname, "..", "..", "..");
const SERVER = path.join(WEBAPP, "server");
const PUBLIC_JS = path.join(WEBAPP, "public", "js");

function walk(dir, filter, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "vendor", "migrations"].includes(e.name)) continue;
      walk(p, filter, out);
    } else if (filter(p)) out.push(p);
  }
  return out;
}

const serverSources = walk(SERVER, (p) => p.endsWith(".js") && !p.includes(`${path.sep}test${path.sep}`));
const rel = (p) => path.relative(SERVER, p).split(path.sep).join("/");

function requiresOf(file) {
  const src = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  const out = [];
  for (const m of src.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)) out.push(path.resolve(path.dirname(file), m[1]));
  return out;
}

// "features/<name>" for feature code, else the top-level folder.
function areaOf(relPath) {
  const parts = relPath.split("/");
  return parts[0] === "features" ? `features/${parts[1]}` : parts[0];
}

// ── Allowed legacy couplings (shrink only) ───────────────────────────────
// A feature importing another feature. One-Pager is a deliberate composition
// of other features' engines; the rest are tracked debt.
const ALLOWED_FEATURE_TO_FEATURE = new Set([
  "features/one-pager-report -> features/dashboard",
  "features/one-pager-report -> features/locked-tote-info",
  "features/one-pager-report -> features/tote-utilisation",
  "features/one-pager-report -> features/tracker",
  "features/tote-puller -> features/locked-tote-info", // autoPreview reads classificationTimestamps
  "features/tote-purge -> features/nexs-asrs-dump", // purgeEngine needs the dump
  "features/tote-purge -> features/tote-utilisation", // purgeAggregate reuses toteUtilisation
  "features/tote-utilisation -> features/nexs-asrs-dump", // job reads the dump
]);
// platform must not know about features/integrations (it is the base layer).
const ALLOWED_PLATFORM_UPWARD = new Set([]);
// integrations must not know about features.
const ALLOWED_INTEGRATION_TO_FEATURE = new Set([]);

test("features do not import other features (except the tracked legacy couplings)", () => {
  const found = new Set();
  for (const f of serverSources) {
    const from = areaOf(rel(f));
    if (!from.startsWith("features/")) continue;
    for (const t of requiresOf(f)) {
      const to = areaOf(rel(t));
      if (to.startsWith("features/") && to !== from) found.add(`${from} -> ${to}`);
    }
  }
  const unexpected = [...found].filter((x) => !ALLOWED_FEATURE_TO_FEATURE.has(x));
  assert.deepEqual(unexpected, [], `New cross-feature import(s): ${unexpected.join(", ")}. Move the shared logic to platform/ or integrations/ (RULES.md §3).`);
});

test("platform/ (the base layer) imports no integrations or features", () => {
  const found = new Set();
  for (const f of serverSources) {
    if (areaOf(rel(f)) !== "platform") continue;
    for (const t of requiresOf(f)) {
      const to = areaOf(rel(t));
      if (to === "integrations" || to.startsWith("features/")) found.add(`${rel(f)} -> ${rel(t)}`);
    }
  }
  const unexpected = [...found].filter((x) => !ALLOWED_PLATFORM_UPWARD.has(x));
  assert.deepEqual(unexpected, [], `platform/ may not depend upward: ${unexpected.join(", ")}`);
});

test("integrations/ import no features", () => {
  const found = new Set();
  for (const f of serverSources) {
    if (areaOf(rel(f)) !== "integrations") continue;
    for (const t of requiresOf(f)) if (areaOf(rel(t)).startsWith("features/")) found.add(`${rel(f)} -> ${rel(t)}`);
  }
  const unexpected = [...found].filter((x) => !ALLOWED_INTEGRATION_TO_FEATURE.has(x));
  assert.deepEqual(unexpected, [], `integrations/ may not import features: ${unexpected.join(", ")}`);
});

test("route files live only in features/<name>/ (or live/), and server/ has no catch-all lib/ routes/ capabilities/ middleware/", () => {
  const routeFiles = serverSources.filter((f) => f.endsWith(".routes.js")).map(rel);
  for (const r of routeFiles) assert.match(r, /^(features\/[a-z-]+|live)\/[A-Za-z]+\.routes\.js$/, `misplaced route file: ${r}`);
  for (const dir of ["lib", "routes", "capabilities", "middleware", "db"]) {
    assert.equal(fs.existsSync(path.join(SERVER, dir)), false, `server/${dir}/ must not exist - put the file in features/, platform/ or integrations/`);
  }
});

test("a feature folder contains only that feature (no files directly in server/ besides index.js and config.js)", () => {
  const top = fs.readdirSync(SERVER, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  assert.deepEqual(top, ["config.js", "index.js"]);
});

test("browser code: no loose files in public/js (core/ for the shell, features/ for screens, vendor/ for libs)", () => {
  const loose = fs.readdirSync(PUBLIC_JS, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  assert.deepEqual(loose, [], `move into public/js/core or public/js/features: ${loose.join(", ")}`);
});

test("the ASO Browser Runtime / WebSocket relay is gone for good", () => {
  const offenders = [];
  for (const f of serverSources) {
    const src = fs.readFileSync(f, "utf8");
    if (/require\(\s*["']ws["']\s*\)/.test(src)) offenders.push(rel(f));
  }
  assert.deepEqual(offenders, []);
  assert.equal(fs.existsSync(path.join(WEBAPP, "..", "runtime")), false);
});

// ── File size ratchet: new files stay readable ───────────────────────────
const MAX_LINES = 700;
const OVERSIZE_ALLOWED = new Set(["public/js/features/asrsLocations3d.js"]); // 3D scene; split when next touched

test(`no source file exceeds ${MAX_LINES} lines (except tracked oversize files)`, () => {
  const files = [...serverSources, ...walk(PUBLIC_JS, (p) => p.endsWith(".js"))];
  const tooBig = files
    .map((f) => ({ f: path.relative(WEBAPP, f).split(path.sep).join("/"), n: fs.readFileSync(f, "utf8").split("\n").length }))
    .filter((x) => x.n > MAX_LINES && !OVERSIZE_ALLOWED.has(x.f));
  assert.deepEqual(tooBig, [], `split these: ${tooBig.map((x) => `${x.f} (${x.n})`).join(", ")}`);
});

// ── Live-update discipline (RULES.md §6) ─────────────────────────────────
test("browser screens never call upstream services or run service logins themselves", () => {
  const offenders = [];
  for (const f of walk(PUBLIC_JS, (p) => p.endsWith(".js"))) {
    const src = fs.readFileSync(f, "utf8");
    if (/api\/v1\/(?:auth\/service|service-credentials)/.test(src)) offenders.push(path.relative(WEBAPP, f));
    if (/fetch\(\s*["'`]https?:\/\/(?!localhost)/.test(src)) offenders.push(path.relative(WEBAPP, f));
  }
  assert.deepEqual(offenders, []);
});

test("live feeds are registered only inside server/live (feeds.js, dashboardFeeds.js, alertsFeed.js)", () => {
  const callers = serverSources.filter((f) => /\.registerFeed\(/.test(fs.readFileSync(f, "utf8"))).map(rel).sort();
  assert.deepEqual(callers, ["live/alertsFeed.js", "live/dashboardFeeds.js", "live/feeds.js"]);
});

test("browser screens never poll: no setInterval/setTimeout polling of the API (use Live.subscribe / Live.watch)", () => {
  const offenders = [];
  for (const f of walk(PUBLIC_JS, (p) => p.endsWith(".js"))) {
    const name = path.relative(WEBAPP, f).split(path.sep).join("/");
    const src = fs.readFileSync(f, "utf8");
    // The dashboard's wall clock is the one legitimate interval (no network).
    const intervals = (src.match(/setInterval\(/g) || []).length;
    // Legitimate intervals: the dashboard wall clock and the alert tray's "x min ago" repaint (no
    // network) and the NexS lease heartbeat (a keep-alive POST, not data polling). The Picking Monitor carries the same
    // header wall clock as the dashboard (no network; it runs only while that tab is open).
    // core/autoReminder.js: the Auto Puller reminder pop-up's countdown, only while it is open (no network).
    // The dashboard clock also drives its per-tile auto refresh (operator decision 2026-11-04): when a tile's time
    // is up it asks through Live.refresh(), never Api.get itself.
    // features/totePurge.js: the run's time-left countdown, ticking between server estimates while a run is going (no network).
    const allowed = name === "public/js/features/dashboard.js" || name === "public/js/features/pickingMonitor.js" || name === "public/js/core/nexsConnect.js" || name === "public/js/core/alertsTray.js" || name === "public/js/core/autoReminder.js" || name === "public/js/features/totePurge.js" ? 1 : 0;
    if (intervals > allowed) offenders.push(`${name}: setInterval`);
    if (/setTimeout\(\s*async/.test(src) && /Api\.get\(/.test(src)) offenders.push(`${name}: async setTimeout + Api.get (a poll loop)`);
  }
  assert.deepEqual(offenders, [], "Live data must come from Live.subscribe(); see RULES.md section 6");
});

test("only the NexS lease manager opens a NexS session (connect-on-demand: nothing else may log in)", () => {
  const offenders = [];
  for (const f of serverSources) {
    const r = rel(f);
    if (r.startsWith("integrations/logins/")) continue; // nexsAuth itself + nexsLease
    if (/nexsAuth\.(connect|login)\(/.test(fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, ""))) offenders.push(r);
  }
  assert.deepEqual(offenders, [], "use nexsLease.acquire() (a person connecting) - never log in to NexS directly");
});

test("a NexS action's route holds a job lease (so leaving the page can't cut NexS off mid-calculation)", () => {
  for (const f of ["features/tote-purge/totePurge.routes.js", "features/tracker/tracker.routes.js", "features/cng-validator/cngValidator.routes.js"]) {
    assert.match(fs.readFileSync(path.join(SERVER, f), "utf8"), /nexsLease\.guardJob\(/, `${f} must guard its NexS work with a job lease`);
  }
});
