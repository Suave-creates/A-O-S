// Coalesces identical, genuinely-concurrent READ-ONLY capability requests
// into ONE real dispatch, and separately serves a short-TTL cache of the
// most recent completed result to a brand-new (non-overlapping) request for
// the same capability+params. Operator request (2026-09-04): "don't burden
// the servers we're fetching data from... extract data effectively and
// efficiently."
//
// Pure state-management only - no knowledge of queries, runtimes, or
// WebSockets. server/integrations/capabilities/capabilityManager.js is the only caller;
// it owns actually creating/completing each caller's own query row, so
// every existing caller still gets back a real, unique query_id and can
// poll/cancel it exactly as before (see that file's own comment for the
// full reasoning on why this is safe to do transparently).
//
// Deliberately NEVER used for PULL_QUADRON_TOTE or any future write
// capability - capabilityManager.js only ever calls this for
// capability.readOnly === true.

const config = require("../../config");

// key -> Promise<result> for the ONE real in-flight dispatch currently
// satisfying that key. A "follower" request awaits this same promise
// instead of sending its own CAPABILITY_REQUEST.
const inFlight = new Map();

// key -> { result, completedAt } for the most recent successful dispatch.
// Pruned lazily - a stale entry is simply never returned by getCached(),
// not proactively swept (this app's capability catalog is small and
// low-cardinality enough that unbounded growth here is not a real concern
// over a process's lifetime).
const recent = new Map();

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// Deterministic, stable regardless of key insertion order in `params`
// (plain JSON.stringify is NOT stable across differing key order for the
// same logical object) - every existing buildPayload() takes a plain,
// JSON-serializable params object (never a class instance/Map/Set), so
// this is safe for the full existing capability catalog.
function buildKey(capabilityName, params) {
  return `${capabilityName}:${stableStringify(params || {})}`;
}

function getInFlight(key) {
  return inFlight.get(key) || null;
}

function setInFlight(key, promise) {
  inFlight.set(key, promise);
}

function clearInFlight(key) {
  inFlight.delete(key);
}

// ttlMs/now are overridable purely for deterministic testing - production
// callers always use the real config value and Date.now().
function getCached(key, { ttlMs = config.capabilityResultCacheTtlMs, now = Date.now() } = {}) {
  if (!ttlMs) return null;
  const entry = recent.get(key);
  if (!entry) return null;
  if (now - entry.completedAt > ttlMs) return null;
  return entry.result;
}

function setCached(key, result, { now = Date.now() } = {}) {
  recent.set(key, { result, completedAt: now });
}

// Test-only reset (matches pullRateLimiter.js's own convention) - never
// called from production code.
function reset() {
  inFlight.clear();
  recent.clear();
}

module.exports = { buildKey, getInFlight, setInFlight, clearInFlight, getCached, setCached, reset };
