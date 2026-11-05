// Query definition for GET_GTP_STATION_CONFIG: the GTP station master data (type, operation, logged-in user,
// state, priority weight) the Picking Monitor uses to judge each station. Read-only; the path is fixed in the
// *Direct.js, never taken from the payload.

function buildPayload(origin, instanceCode) {
  return { origin, instanceCode };
}

// Only these fields leave the integration - anything else the upstream adds (weights, limits) is dropped.
function validateResult(result) {
  if (!result || !Array.isArray(result.stations)) return { ok: false, reason: "result.stations must be an array" };
  for (const s of result.stations) {
    if (!s || typeof s.id !== "string" || !s.id) return { ok: false, reason: "each station needs a string id" };
    if (typeof s.type !== "string" || typeof s.operationType !== "string") return { ok: false, reason: `station ${s.id} needs type and operationType` };
    if (s.priorityWeight != null && !Number.isFinite(s.priorityWeight)) return { ok: false, reason: `station ${s.id} has a non-numeric priorityWeight` };
    if (typeof s.loggedIn !== "boolean") return { ok: false, reason: `station ${s.id} needs loggedIn` };
  }
  return { ok: true };
}

module.exports = { buildPayload, validateResult };
