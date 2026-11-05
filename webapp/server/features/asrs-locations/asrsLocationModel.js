// ASRS Locations - pure structural/parsing model. No I/O here at all (see
// asrsLocationsEngine.js for the capability dispatch). Confirmed with the
// operator, verbatim:
//
//   - Location string: AAA-LL-1-PPP-1-DD (e.g. "006-03-1-183-1-02").
//     AAA = aisle code (004-009 -> aisle 1-6), LL = level, the two "1"s are
//     ignored, PPP = position (1-226), DD = depth ("01" front, "02" back) -
//     two independent physical slots at the same aisle/level/pillar/side.
//   - Aisles 1-4 have 19 levels; aisles 5-6 have 24 levels. Hard floors
//     break the levels into blocks of 5, bottom-up, with the remainder in
//     the top block (confirmed for the 24-level case: 1-5/6-10/11-15/
//     16-20/21-24; the 19-level case assumes the same pattern:
//     1-5/6-10/11-15/16-19 - cosmetic-only, affects only where a gap line
//     is drawn, never occupancy correctness).
//   - pillar = floor(position / 2); side = left if position is odd, right
//     if even (confirmed twice against the operator's own worked example:
//     position 183 -> floor(91.5) = pillar 91, left - NOT a "cleaned up"
//     symmetric 1-113 scheme; pillar 0 legitimately exists on the left,
//     from position 1).

const AISLE_CODE_TO_NUMBER = { "004": 1, "005": 2, "006": 3, "007": 4, "008": 5, "009": 6 };
const LOCATION_RE = /^(\d{3})-(\d{2})-1-(\d{3})-1-(0[12])$/;

function levelsForAisle(aisle) {
  return aisle <= 4 ? 19 : 24;
}

// Bottom-up blocks of 5 levels, remainder in the top (last) block - the
// hard-floor break points for the elevation view.
function levelBlocks(levelCount) {
  const blocks = [];
  let start = 1;
  while (start <= levelCount) {
    const end = Math.min(start + 4, levelCount);
    blocks.push([start, end]);
    start = end + 1;
  }
  return blocks;
}

function sideAndPillar(position) {
  const side = position % 2 === 1 ? "left" : "right";
  const pillar = Math.floor(position / 2);
  return { side, pillar };
}

function slotKeyFor(aisle, level, pillar, side, depthCode) {
  return `${aisle}-${level}-${pillar}-${side === "left" ? "L" : "R"}-${depthCode}`;
}

// Parses one location string into its slot coordinates, or reports exactly
// why it couldn't - never silently dropped, never guessed.
function parseLocation(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "location is not a string" };
  const m = raw.match(LOCATION_RE);
  if (!m) return { ok: false, reason: `does not match the expected AAA-LL-1-PPP-1-DD format: ${raw}` };

  const [, aisleCode, levelStr, posStr, depthCode] = m;
  const aisle = AISLE_CODE_TO_NUMBER[aisleCode];
  if (!aisle) return { ok: false, reason: `unknown aisle code: ${aisleCode}` };

  const level = Number(levelStr);
  const maxLevel = levelsForAisle(aisle);
  if (level < 1 || level > maxLevel) return { ok: false, reason: `level ${level} out of range for aisle ${aisle} (max ${maxLevel})` };

  const position = Number(posStr);
  if (position < 1 || position > 226) return { ok: false, reason: `position ${position} out of range (1-226)` };

  const depth = depthCode === "01" ? "front" : "back";
  const { side, pillar } = sideAndPillar(position);
  const slotKey = slotKeyFor(aisle, level, pillar, side, depthCode);
  return { ok: true, slot: { aisle, level, position, depth, depthCode, side, pillar, slotKey } };
}

// The full theoretical slot space - every aisle x level x pillar x side x
// depth combination. Used server-side for aisle total counts (and directly
// in tests); the frontend recomputes the same cheap, deterministic math
// itself when drawing a selected aisle's grid rather than have the server
// ship all ~56,000 mostly-empty slot placeholders over the wire - only
// buildOccupancyModel()'s small occupied/anomaly lists cross the network.
function generateAllSlots() {
  const slots = [];
  for (let aisle = 1; aisle <= 6; aisle++) {
    const maxLevel = levelsForAisle(aisle);
    for (let level = 1; level <= maxLevel; level++) {
      for (let position = 1; position <= 226; position++) {
        const { side, pillar } = sideAndPillar(position);
        for (const depthCode of ["01", "02"]) {
          slots.push({
            aisle, level, position, side, pillar,
            depth: depthCode === "01" ? "front" : "back",
            slotKey: slotKeyFor(aisle, level, pillar, side, depthCode),
          });
        }
      }
    }
  }
  return slots;
}

// Merges live container-tracking rows (see grafanaContainerTracking.js) onto
// the theoretical slot space. 'OUT'/nullish locations are excluded (those
// totes aren't in the ASRS at all - out of scope for this module). Anomalies
// are always surfaced, never swallowed: a location that doesn't parse at all
// (unparsedLocations), and more than one container resolving to the exact
// same slot (duplicateSlots - the first occupant wins the slot itself; every
// container after it is reported as a duplicate, never silently dropped or
// silently overwriting the first).
function buildOccupancyModel(containerRows) {
  const occupiedBySlotKey = new Map();
  const unparsedLocations = [];
  const duplicatesByKey = new Map();
  const aisleCounts = new Map(); // aisle -> occupied count

  for (const row of containerRows || []) {
    if (!row || row.location == null || row.location === "" || row.location === "OUT") continue;

    const parsed = parseLocation(row.location);
    if (!parsed.ok) {
      unparsedLocations.push({ container: row.container, location: row.location, reason: parsed.reason });
      continue;
    }

    const { slot } = parsed;
    if (occupiedBySlotKey.has(slot.slotKey)) {
      if (!duplicatesByKey.has(slot.slotKey)) duplicatesByKey.set(slot.slotKey, [occupiedBySlotKey.get(slot.slotKey).container]);
      duplicatesByKey.get(slot.slotKey).push(row.container);
      continue;
    }

    occupiedBySlotKey.set(slot.slotKey, {
      ...slot,
      container: row.container,
      tracker: row.tracker,
      zone: row.zone,
      shuttle: row.shuttle,
      shuttleHealthStatus: row.shuttleHealthStatus,
    });
    aisleCounts.set(slot.aisle, (aisleCounts.get(slot.aisle) || 0) + 1);
  }

  const aisles = [];
  for (let aisle = 1; aisle <= 6; aisle++) {
    const total = levelsForAisle(aisle) * 226 * 2;
    const occupied = aisleCounts.get(aisle) || 0;
    aisles.push({ aisle, total, occupied, empty: total - occupied });
  }

  return {
    occupiedSlots: [...occupiedBySlotKey.values()],
    aisles,
    unparsedLocations,
    duplicateSlots: [...duplicatesByKey.entries()].map(([slotKey, containers]) => ({ slotKey, containers })),
  };
}

module.exports = {
  AISLE_CODE_TO_NUMBER,
  levelsForAisle,
  levelBlocks,
  parseLocation,
  generateAllSlots,
  buildOccupancyModel,
};
