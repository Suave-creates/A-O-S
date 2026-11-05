// Global rolling-window pull-rate limiter, shared by Manual AND Auto alike -
// mirrors quadronPullLock.js's own style (plain, dependency-free, module-
// singleton state). A genuine gap in the existing replication: the only
// prior pacing concept was Auto's per-tote `cooldownMs` (autoEngine.js),
// which prevents re-pulling the SAME tote too soon - a different mechanism
// (anti-duplicate-recall) from a cap on total pull THROUGHPUT. This module
// is that cap: at most `max` real Quadron pull attempts in any rolling
// `windowMs` window, counted across every session (Manual or Auto, one or
// several) at once, protecting the real Quadron backend the same way the
// single shared quadronPullLock protects it from concurrent overlap.
//
// Enforcement lives in toteDispatchLoop.js (the one shared dispatch point
// for both engines) - this module only tracks state and reports it; it
// never itself blocks or throws.

const DEFAULT_MAX_PULLS = 100;
const DEFAULT_WINDOW_MS = 6 * 60000; // 6 minutes - matches the reference extension's own default

let max = DEFAULT_MAX_PULLS;
let windowMs = DEFAULT_WINDOW_MS;
let timestamps = []; // ms epoch, oldest first

function prune(now) {
  const cutoff = now - windowMs;
  while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
}

// Records one real pull attempt (called once per actual dispatchOne() call,
// including retries - each is a real request against Quadron and must count
// toward the cap regardless of its outcome).
function record() {
  timestamps.push(Date.now());
}

// Current state, pruned to the live window. `nextFreeAt` is the instant the
// oldest counted timestamp ages out of the window - the moment exactly one
// slot frees up - or null if the limit isn't currently reached.
function snapshot() {
  const now = Date.now();
  prune(now);
  const count = timestamps.length;
  const remaining = Math.max(0, max - count);
  const limitReached = count >= max;
  const nextFreeAt = limitReached && timestamps.length ? timestamps[0] + windowMs : null;
  return { timestamps: [...timestamps], max, windowMs, count, remaining, limitReached, nextFreeAt };
}

// Test-only override - production code never calls this (matches how other
// engines expose injectable config for tests, e.g. totePullEngine.js's own
// constructor options).
function configure({ max: newMax, windowMs: newWindowMs } = {}) {
  if (typeof newMax === "number" && newMax > 0) max = newMax;
  if (typeof newWindowMs === "number" && newWindowMs > 0) windowMs = newWindowMs;
}

function reset() {
  timestamps = [];
  max = DEFAULT_MAX_PULLS;
  windowMs = DEFAULT_WINDOW_MS;
}

module.exports = { record, snapshot, configure, reset, DEFAULT_MAX_PULLS, DEFAULT_WINDOW_MS };
