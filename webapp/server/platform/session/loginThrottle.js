// Login throttling (2026-11-04, before opening AOS to other users on the office network): too many wrong
// passwords block further tries for a while, so a password cannot be guessed by trying many.
//   - per employee ID: 5 failures within 15 min -> that ID is blocked for 15 min (from the last failure);
//   - per client address: 20 failures within 15 min -> that address is blocked for 15 min (guessing across IDs).
// A successful login clears its employee ID's count. Kept in memory: one process, and a restart simply starts over.

const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;
const MAX_PER_ID = 5;
const MAX_PER_ADDRESS = 20;

function create({ now = () => Date.now() } = {}) {
  const fails = new Map(); // key -> [failure times]

  const recent = (key) => {
    const t = now();
    const list = (fails.get(key) || []).filter((at) => t - at < Math.max(WINDOW_MS, BLOCK_MS));
    if (list.length) fails.set(key, list);
    else fails.delete(key);
    return list;
  };
  const keys = (employeeId, address) => [["id:" + String(employeeId || "").trim().toLowerCase(), MAX_PER_ID], ["ip:" + String(address || ""), MAX_PER_ADDRESS]];

  // ms until a try is allowed again (0 = allowed now)
  function blockedFor(employeeId, address) {
    const t = now();
    let wait = 0;
    for (const [key, max] of keys(employeeId, address)) {
      const list = recent(key);
      if (list.length >= max) wait = Math.max(wait, list[list.length - 1] + BLOCK_MS - t);
    }
    return Math.max(0, wait);
  }

  function fail(employeeId, address) {
    const t = now();
    for (const [key] of keys(employeeId, address)) fails.set(key, [...recent(key), t]);
    // keep the map small: forget keys with nothing recent
    if (fails.size > 5000) for (const k of [...fails.keys()]) recent(k);
  }

  function succeed(employeeId) {
    fails.delete(keys(employeeId, "")[0][0]);
  }

  return { blockedFor, fail, succeed };
}

module.exports = { create, ...create(), WINDOW_MS, BLOCK_MS, MAX_PER_ID, MAX_PER_ADDRESS };
