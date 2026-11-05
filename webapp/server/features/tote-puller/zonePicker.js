// Exact port of the existing extension's pickNextZone() (background/index.js:1223)
// and MultiZone.validate() (ui/components/multizone.js) - a smooth weighted
// round-robin over configured zone percentages. Pure, dependency-free -
// deliberately kept that way so the algorithm itself can be unit-tested in
// total isolation from the Engine, the database, and the Query Manager.
//
// No per-tote zone assignment, no per-zone queues, no parallel execution,
// no randomness: one shared zone configuration, one call at a time, the
// zone for THAT call decided by accumulated credit.

// zoneConfig shape: { multiZone: boolean, zone, instanceCode, zones: [{id, zone, instanceCode, percentage}] }
// credits: a plain object, mutated in place across calls within one session
// (session.zoneCredits) - reset to {} at the start of every new session.
function pickNextZone(zoneConfig, credits) {
  if (!zoneConfig.multiZone || !zoneConfig.zones || zoneConfig.zones.length === 0) {
    return { zone: zoneConfig.zone, instanceCode: zoneConfig.instanceCode };
  }
  const active = zoneConfig.zones.filter((z) => z.zone && z.percentage > 0);
  if (active.length === 0) {
    return { zone: zoneConfig.zone, instanceCode: zoneConfig.instanceCode };
  }
  if (active.length === 1) {
    return { zone: active[0].zone, instanceCode: active[0].instanceCode };
  }
  const totalWeight = active.reduce((s, z) => s + z.percentage, 0);
  for (const z of active) {
    if (credits[z.id] === undefined) credits[z.id] = 0;
    credits[z.id] += z.percentage;
  }
  // Strict greater-than: a tie leaves `best` as whichever zone the loop
  // started with (the first-listed active zone), exactly matching the
  // existing extension's own tie-breaking behavior.
  let best = active[0];
  for (const z of active) {
    if (credits[z.id] > credits[best.id]) best = z;
  }
  credits[best.id] -= totalWeight;
  return { zone: best.zone, instanceCode: best.instanceCode };
}

// Exact port of MultiZone.validate(), adapted for a backend that can't rely
// on a UI always having pre-filled a default instanceCode - so this adds
// one rule the client-side original didn't need (every zone must carry a
// non-empty instanceCode), never loosens any existing rule.
function validateZoneConfig({ multiZone, zone, instanceCode, zones }) {
  if (!multiZone) {
    if (typeof zone !== "string" || !zone.trim()) return { ok: false, reason: "zone is required" };
    if (typeof instanceCode !== "string" || !instanceCode.trim()) return { ok: false, reason: "instanceCode is required" };
    return { ok: true };
  }
  if (!Array.isArray(zones) || zones.length === 0) {
    return { ok: false, reason: "Add at least one zone." };
  }
  if (zones.some((z) => !z || typeof z.zone !== "string" || !z.zone.trim())) {
    return { ok: false, reason: "All zones need a zone number." };
  }
  if (zones.some((z) => typeof z.instanceCode !== "string" || !z.instanceCode.trim())) {
    return { ok: false, reason: "All zones need an instance code." };
  }
  const total = zones.reduce((s, z) => s + (Number(z.percentage) || 0), 0);
  if (total > 100) return { ok: false, reason: `Total is ${total}% — cannot exceed 100%.` };
  if (total < 100) return { ok: false, reason: `Total is ${total}% — must equal 100%.` };
  return { ok: true };
}

// Fills in a default instanceCode wherever the caller didn't supply one.
// instanceCode is backend/configuration information (e.g. "LK-069") - the
// Manual Tote Puller UI no longer collects it from the operator, so the
// route layer (toteEngine.routes.js) applies config.quadronInstanceCode
// here before validation, rather than requiring the client to send it.
// Pure - takes the default as a plain argument instead of reading config
// itself, so it stays dependency-free and testable like the rest of this
// file. validateZoneConfig()'s own instanceCode-required rule is
// deliberately UNCHANGED - this function's job is only to make sure that
// rule is always satisfied by the time it runs, not to loosen it.
function applyDefaultInstanceCode(zoneConfigInput, defaultInstanceCode) {
  if (!zoneConfigInput.multiZone) {
    return {
      ...zoneConfigInput,
      instanceCode: (zoneConfigInput.instanceCode && String(zoneConfigInput.instanceCode).trim()) || defaultInstanceCode,
    };
  }
  return {
    ...zoneConfigInput,
    zones: Array.isArray(zoneConfigInput.zones)
      ? zoneConfigInput.zones.map((z) => ({
          ...z,
          instanceCode: (z.instanceCode && String(z.instanceCode).trim()) || defaultInstanceCode,
        }))
      : zoneConfigInput.zones,
  };
}

module.exports = { pickNextZone, validateZoneConfig, applyDefaultInstanceCode };
