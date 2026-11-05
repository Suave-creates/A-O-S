// Shared-run cache: the app-wide policy for anything expensive that users can trigger (a refresh, a report, an
// analysis). Data in AOS is site data, so the same request from two people must produce ONE run and ONE result:
//
//   - in flight  -> a second caller with the same key JOINS the running job (same promise, same result) instead of
//                   starting a duplicate upstream fetch that could race it and write a conflicting result;
//   - just done  -> within `freshMs` of a successful run, callers get that result back instead of a new run;
//   - failed     -> never cached: the next caller runs again.
//
// Results are reused as-is (the caller's own run already persisted them for everyone). Keys must encode every
// input that changes the result (e.g. a date, caps, a facility, the tote list).

const MAX_KEYS = 100; // bounded: per-tote-list keys must not grow without limit

function createSharedRun({ now = Date.now } = {}) {
  const inflight = new Map(); // key -> promise
  const done = new Map(); // key -> { at, value }, oldest first

  async function run(key, { freshMs = 0 } = {}, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const hit = done.get(key);
    if (hit && freshMs > 0 && now() - hit.at < freshMs) return hit.value;

    const p = Promise.resolve().then(fn);
    inflight.set(key, p);
    try {
      const value = await p;
      done.delete(key);
      done.set(key, { at: now(), value });
      while (done.size > MAX_KEYS) done.delete(done.keys().next().value);
      return value;
    } finally {
      inflight.delete(key);
    }
  }

  return {
    run,
    isRunning: (key) => inflight.has(key),
    forget: (key) => done.delete(key),
  };
}

// Stable key part for a list of ids (order and duplicates don't change the result).
function listKey(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((x) => String(x).trim().toUpperCase()).filter(Boolean))].sort().join(",");
}

module.exports = { createSharedRun, listKey };
