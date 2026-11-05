// Pure unit tests for server/features/tote-puller/zonePicker.js - the exact port of the
// existing extension's pickNextZone()/MultiZone.validate(). No database, no
// network, no Quadron call of any kind.

const test = require("node:test");
const assert = require("node:assert/strict");
const { pickNextZone, validateZoneConfig, applyDefaultInstanceCode } = require("../../../features/tote-puller/zonePicker");

// ── Single-zone behavior ────────────────────────────────────────────────

test("single-zone: always returns the flat zone/instanceCode, credits untouched", () => {
  const cfg = { multiZone: false, zone: "5", instanceCode: "LK-069" };
  const credits = {};
  const r1 = pickNextZone(cfg, credits);
  const r2 = pickNextZone(cfg, credits);
  assert.deepEqual(r1, { zone: "5", instanceCode: "LK-069" });
  assert.deepEqual(r2, { zone: "5", instanceCode: "LK-069" });
  assert.deepEqual(credits, {});
});

test("multi-zone with exactly one active zone behaves like single-zone (no credit accounting)", () => {
  const cfg = { multiZone: true, zone: "", instanceCode: "", zones: [{ id: "z1", zone: "9", instanceCode: "LK-001", percentage: 100 }] };
  const credits = {};
  const r = pickNextZone(cfg, credits);
  assert.deepEqual(r, { zone: "9", instanceCode: "LK-001" });
  assert.deepEqual(credits, {}, "the single-active-zone shortcut never touches credits");
});

test("multi-zone with zero active zones (all percentage 0) falls back to the flat zone/instanceCode", () => {
  const cfg = { multiZone: true, zone: "5", instanceCode: "LK-069", zones: [{ id: "z1", zone: "9", instanceCode: "LK-001", percentage: 0 }] };
  assert.deepEqual(pickNextZone(cfg, {}), { zone: "5", instanceCode: "LK-069" });
});

// ── Exact smooth-WRR sequence, 70/30 (matches the Blueprint's worked example) ──

test("exact smooth-WRR sequence for a 70/30 split over 5 calls", () => {
  const cfg = {
    multiZone: true,
    zone: "",
    instanceCode: "",
    zones: [
      { id: "z5", zone: "5", instanceCode: "LK-069", percentage: 70 },
      { id: "z12", zone: "12", instanceCode: "LK-070", percentage: 30 },
    ],
  };
  const credits = {};
  const sequence = [1, 2, 3, 4, 5].map(() => pickNextZone(cfg, credits).zone);

  // Credit trace (Z5, Z12), matching the Blueprint exactly:
  //  call1: +70,+30 -> 70,30  -> pick Z5  -> -100 -> -30,30
  //  call2: +70,+30 -> 40,60  -> pick Z12 -> -100 -> 40,-40
  //  call3: +70,+30 -> 110,-10-> pick Z5  -> -100 -> 10,-10
  //  call4: +70,+30 -> 80,20  -> pick Z5  -> -100 -> -20,20
  //  call5: +70,+30 -> 50,50  -> TIE -> first-listed (Z5) -> -100 -> -50,50
  assert.deepEqual(sequence, ["5", "12", "5", "5", "5"]);
});

test("70/30 sequence also returns the correct instanceCode paired with each selected zone", () => {
  const cfg = {
    multiZone: true,
    zone: "",
    instanceCode: "",
    zones: [
      { id: "z5", zone: "5", instanceCode: "LK-A", percentage: 70 },
      { id: "z12", zone: "12", instanceCode: "LK-B", percentage: 30 },
    ],
  };
  const credits = {};
  const picks = [1, 2, 3, 4, 5].map(() => pickNextZone(cfg, credits));
  assert.deepEqual(picks, [
    { zone: "5", instanceCode: "LK-A" },
    { zone: "12", instanceCode: "LK-B" },
    { zone: "5", instanceCode: "LK-A" },
    { zone: "5", instanceCode: "LK-A" },
    { zone: "5", instanceCode: "LK-A" },
  ]);
});

// ── Tie-breaking ─────────────────────────────────────────────────────────

test("tie-breaking: an exact 50/50 split always resolves to the first-listed zone on a tie", () => {
  const cfgFirstIsA = {
    multiZone: true, zone: "", instanceCode: "",
    zones: [
      { id: "a", zone: "A", instanceCode: "IC", percentage: 50 },
      { id: "b", zone: "B", instanceCode: "IC", percentage: 50 },
    ],
  };
  // call 1: credits +50,+50 -> tie 50,50 -> first-listed (A) wins
  assert.equal(pickNextZone(cfgFirstIsA, {}).zone, "A");

  const cfgFirstIsB = {
    multiZone: true, zone: "", instanceCode: "",
    zones: [
      { id: "b", zone: "B", instanceCode: "IC", percentage: 50 },
      { id: "a", zone: "A", instanceCode: "IC", percentage: 50 },
    ],
  };
  assert.equal(pickNextZone(cfgFirstIsB, {}).zone, "B", "reordering the config changes which zone wins the tie - first-listed, not alphabetical or id-based");
});

// ── Credit reset between sessions ───────────────────────────────────────

test("credit reset: a fresh credits object produces the exact same sequence as any other fresh session", () => {
  const cfg = {
    multiZone: true, zone: "", instanceCode: "",
    zones: [
      { id: "z5", zone: "5", instanceCode: "LK-069", percentage: 70 },
      { id: "z12", zone: "12", instanceCode: "LK-070", percentage: 30 },
    ],
  };
  const sessionACredits = {};
  const sessionBCredits = {};

  // Drive session A through 3 calls first...
  const seqA = [1, 2, 3].map(() => pickNextZone(cfg, sessionACredits).zone);
  // ...then a brand-new session B, with its OWN fresh credits object,
  // reproduces the exact same opening sequence - proving state does not
  // leak between sessions when credits are reset (== a new {} per session).
  const seqB = [1, 2, 3].map(() => pickNextZone(cfg, sessionBCredits).zone);

  assert.deepEqual(seqA, seqB);
  assert.deepEqual(seqA, ["5", "12", "5"]);
});

// ── Validation ───────────────────────────────────────────────────────────

test("validateZoneConfig: single-zone requires zone and instanceCode", () => {
  assert.equal(validateZoneConfig({ multiZone: false, zone: "", instanceCode: "LK-069" }).ok, false);
  assert.equal(validateZoneConfig({ multiZone: false, zone: "5", instanceCode: "" }).ok, false);
  assert.equal(validateZoneConfig({ multiZone: false, zone: "5", instanceCode: "LK-069" }).ok, true);
});

test("validateZoneConfig: multi-zone requires at least one zone", () => {
  const v = validateZoneConfig({ multiZone: true, zones: [] });
  assert.equal(v.ok, false);
  assert.match(v.reason, /at least one zone/i);
});

test("validateZoneConfig: multi-zone requires every zone to have a zone value and instanceCode", () => {
  const missingZone = validateZoneConfig({ multiZone: true, zones: [{ id: "a", zone: "", instanceCode: "LK-069", percentage: 100 }] });
  assert.equal(missingZone.ok, false);
  assert.match(missingZone.reason, /zone number/i);

  const missingInstance = validateZoneConfig({ multiZone: true, zones: [{ id: "a", zone: "5", instanceCode: "", percentage: 100 }] });
  assert.equal(missingInstance.ok, false);
  assert.match(missingInstance.reason, /instance code/i);
});

test("validateZoneConfig: percentage total must equal exactly 100 - both under and over are rejected", () => {
  const under = validateZoneConfig({
    multiZone: true,
    zones: [
      { id: "a", zone: "5", instanceCode: "LK-069", percentage: 60 },
      { id: "b", zone: "12", instanceCode: "LK-070", percentage: 30 },
    ],
  });
  assert.equal(under.ok, false);
  assert.match(under.reason, /90%/);

  const over = validateZoneConfig({
    multiZone: true,
    zones: [
      { id: "a", zone: "5", instanceCode: "LK-069", percentage: 60 },
      { id: "b", zone: "12", instanceCode: "LK-070", percentage: 50 },
    ],
  });
  assert.equal(over.ok, false);
  assert.match(over.reason, /110%/);

  const exact = validateZoneConfig({
    multiZone: true,
    zones: [
      { id: "a", zone: "5", instanceCode: "LK-069", percentage: 70 },
      { id: "b", zone: "12", instanceCode: "LK-070", percentage: 30 },
    ],
  });
  assert.equal(exact.ok, true);
});

// ── applyDefaultInstanceCode: proves removing Instance Code from the UI
//    does not break the backend Quadron request - the route always fills
//    in a real instanceCode before validation/dispatch ever runs ────────

test("applyDefaultInstanceCode: single-zone - fills in the default when the client omitted instanceCode", () => {
  const resolved = applyDefaultInstanceCode({ multiZone: false, zone: "5", instanceCode: "" }, "LK-069");
  assert.equal(resolved.instanceCode, "LK-069");
  assert.equal(resolved.zone, "5");
});

test("applyDefaultInstanceCode: single-zone - a client-supplied instanceCode is preserved, not overridden", () => {
  const resolved = applyDefaultInstanceCode({ multiZone: false, zone: "5", instanceCode: "LK-CUSTOM" }, "LK-069");
  assert.equal(resolved.instanceCode, "LK-CUSTOM");
});

test("applyDefaultInstanceCode: multi-zone - fills in the default for every zone row missing one", () => {
  const resolved = applyDefaultInstanceCode(
    {
      multiZone: true,
      zones: [
        { id: "a", zone: "5", instanceCode: "", percentage: 70 },
        { id: "b", zone: "12", instanceCode: "LK-CUSTOM", percentage: 30 },
      ],
    },
    "LK-069"
  );
  assert.equal(resolved.zones[0].instanceCode, "LK-069");
  assert.equal(resolved.zones[1].instanceCode, "LK-CUSTOM", "an explicitly supplied instanceCode is never overridden");
});

test("applyDefaultInstanceCode's output always passes validateZoneConfig when zone/percentages are otherwise valid (proves the UI can safely omit instanceCode entirely)", () => {
  const noInstanceCodeAtAll = { multiZone: true, zones: [{ id: "a", zone: "5", percentage: 100 }] };
  const resolved = applyDefaultInstanceCode(noInstanceCodeAtAll, "LK-069");
  assert.deepEqual(validateZoneConfig(resolved), { ok: true });

  const singleZoneNoInstanceCode = { multiZone: false, zone: "5", instanceCode: undefined };
  const resolvedSingle = applyDefaultInstanceCode(singleZoneNoInstanceCode, "LK-069");
  assert.deepEqual(validateZoneConfig(resolvedSingle), { ok: true });
});
