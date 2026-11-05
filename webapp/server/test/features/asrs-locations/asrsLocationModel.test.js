// Pure unit tests for server/features/asrs-locations/asrsLocationModel.js - ASRS Locations'
// structural/parsing model. No I/O, no capability dispatch.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  levelsForAisle,
  levelBlocks,
  parseLocation,
  generateAllSlots,
  buildOccupancyModel,
} = require("../../../features/asrs-locations/asrsLocationModel");

test("levelsForAisle: aisles 1-4 have 19 levels, aisles 5-6 have 24", () => {
  assert.equal(levelsForAisle(1), 19);
  assert.equal(levelsForAisle(4), 19);
  assert.equal(levelsForAisle(5), 24);
  assert.equal(levelsForAisle(6), 24);
});

test("levelBlocks: bottom-up blocks of 5, remainder in the top block", () => {
  assert.deepEqual(levelBlocks(24), [[1, 5], [6, 10], [11, 15], [16, 20], [21, 24]]);
  assert.deepEqual(levelBlocks(19), [[1, 5], [6, 10], [11, 15], [16, 19]]);
});

test("parseLocation: the operator's own worked example - 006-03-1-183-1-02 -> aisle 3, level 3, pillar 91, left, back", () => {
  const r = parseLocation("006-03-1-183-1-02");
  assert.equal(r.ok, true);
  assert.deepEqual(r.slot, { aisle: 3, level: 3, position: 183, depth: "back", depthCode: "02", side: "left", pillar: 91, slotKey: "3-3-91-L-02" });
});

test("parseLocation: position 1 -> pillar 0, left (the low edge - pillar 0 legitimately exists)", () => {
  const r = parseLocation("004-01-1-001-1-01");
  assert.equal(r.ok, true);
  assert.equal(r.slot.pillar, 0);
  assert.equal(r.slot.side, "left");
});

test("parseLocation: position 2 -> pillar 1, right", () => {
  const r = parseLocation("004-01-1-002-1-01");
  assert.equal(r.ok, true);
  assert.equal(r.slot.pillar, 1);
  assert.equal(r.slot.side, "right");
});

test("parseLocation: position 225 -> pillar 112, left; position 226 -> pillar 113, right (the high edge)", () => {
  const left = parseLocation("004-01-1-225-1-01");
  assert.equal(left.slot.pillar, 112);
  assert.equal(left.slot.side, "left");
  const right = parseLocation("004-01-1-226-1-01");
  assert.equal(right.slot.pillar, 113);
  assert.equal(right.slot.side, "right");
});

test("parseLocation: depth 01 is front, 02 is back", () => {
  assert.equal(parseLocation("004-01-1-010-1-01").slot.depth, "front");
  assert.equal(parseLocation("004-01-1-010-1-02").slot.depth, "back");
});

test("parseLocation: rejects an unknown aisle code", () => {
  const r = parseLocation("003-01-1-010-1-01");
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown aisle code/);
});

test("parseLocation: rejects a level beyond that aisle's own range (19-level aisle, level 20)", () => {
  const r = parseLocation("004-20-1-010-1-01");
  assert.equal(r.ok, false);
  assert.match(r.reason, /level 20 out of range for aisle 1/);
});

test("parseLocation: level 24 is valid for a 24-level aisle but not a 19-level one", () => {
  assert.equal(parseLocation("008-24-1-010-1-01").ok, true);
  assert.equal(parseLocation("004-24-1-010-1-01").ok, false);
});

test("parseLocation: rejects a position beyond 226", () => {
  const r = parseLocation("004-01-1-227-1-01");
  assert.equal(r.ok, false);
  assert.match(r.reason, /position 227 out of range/);
});

test("parseLocation: rejects anything not matching the AAA-LL-1-PPP-1-DD shape, including the literal 'OUT'", () => {
  assert.equal(parseLocation("OUT").ok, false);
  assert.equal(parseLocation("006-03-183-02").ok, false);
  assert.equal(parseLocation("").ok, false);
  assert.equal(parseLocation(null).ok, false);
});

test("generateAllSlots: total slot counts match aisle 1 (19 levels) = 8,588 and aisle 5 (24 levels) = 10,848", () => {
  const slots = generateAllSlots();
  assert.equal(slots.filter((s) => s.aisle === 1).length, 19 * 226 * 2);
  assert.equal(slots.filter((s) => s.aisle === 1).length, 8588);
  assert.equal(slots.filter((s) => s.aisle === 5).length, 24 * 226 * 2);
  assert.equal(slots.filter((s) => s.aisle === 5).length, 10848);
  assert.equal(slots.length, 4 * 8588 + 2 * 10848);
});

test("generateAllSlots: every slotKey is unique (no accidental collisions in the coordinate scheme)", () => {
  const slots = generateAllSlots();
  assert.equal(new Set(slots.map((s) => s.slotKey)).size, slots.length);
});

test("buildOccupancyModel: 'OUT' and null/empty locations are excluded entirely, never counted or reported as anomalies", () => {
  const model = buildOccupancyModel([
    { container: "T1", location: "OUT" },
    { container: "T2", location: null },
    { container: "T3", location: "" },
  ]);
  assert.equal(model.occupiedSlots.length, 0);
  assert.equal(model.unparsedLocations.length, 0);
});

test("buildOccupancyModel: a real location occupies exactly one slot and is reflected in that aisle's summary", () => {
  const model = buildOccupancyModel([{ container: "T1", tracker: 101, location: "006-03-1-183-1-02", zone: "aisle_03_zone_03", shuttle: "QD_Shuttle_03_03" }]);
  assert.equal(model.occupiedSlots.length, 1);
  assert.equal(model.occupiedSlots[0].container, "T1");
  assert.equal(model.occupiedSlots[0].slotKey, "3-3-91-L-02");
  const aisle3 = model.aisles.find((a) => a.aisle === 3);
  assert.equal(aisle3.occupied, 1);
  assert.equal(aisle3.total, 19 * 226 * 2);
  assert.equal(aisle3.empty, aisle3.total - 1);
});

test("buildOccupancyModel: an unparseable location is reported, never silently dropped or crashed on", () => {
  const model = buildOccupancyModel([{ container: "T1", location: "garbage" }]);
  assert.equal(model.occupiedSlots.length, 0);
  assert.equal(model.unparsedLocations.length, 1);
  assert.equal(model.unparsedLocations[0].container, "T1");
});

test("buildOccupancyModel: two containers resolving to the exact same slot - the first wins the slot, the rest are reported as duplicates", () => {
  const model = buildOccupancyModel([
    { container: "T1", location: "006-03-1-183-1-02" },
    { container: "T2", location: "006-03-1-183-1-02" },
  ]);
  assert.equal(model.occupiedSlots.length, 1);
  assert.equal(model.occupiedSlots[0].container, "T1");
  assert.equal(model.duplicateSlots.length, 1);
  assert.deepEqual(model.duplicateSlots[0], { slotKey: "3-3-91-L-02", containers: ["T1", "T2"] });
});

test("buildOccupancyModel: front (01) and back (02) at the same aisle/level/position are two independent slots, both occupied simultaneously", () => {
  const model = buildOccupancyModel([
    { container: "T1", location: "006-03-1-183-1-01" },
    { container: "T2", location: "006-03-1-183-1-02" },
  ]);
  assert.equal(model.occupiedSlots.length, 2);
  assert.equal(model.duplicateSlots.length, 0);
});

test("buildOccupancyModel: every aisle is always present in the summary, even with zero occupied totes", () => {
  const model = buildOccupancyModel([]);
  assert.deepEqual(model.aisles.map((a) => a.aisle), [1, 2, 3, 4, 5, 6]);
  assert.ok(model.aisles.every((a) => a.occupied === 0 && a.empty === a.total));
});
