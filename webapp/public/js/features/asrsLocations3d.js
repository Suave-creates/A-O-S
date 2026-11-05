// ASRS Locations - 3D view (2026-09-09 redesign). Same aisle/Level scope as
// the 2D grid (asrsLocations.js) - X = pillar position (the walking length
// of the aisle), Z = side (left rack at negative Z, right rack at positive
// Z, walkway/centerline at Z=0), Y = shelf row. This module NEVER decides
// what a location's aisle/side/position/level/depth means - asrsLocations.js
// owns that entirely and only ever hands this module small accessor
// callbacks (isOccupied/isDuplicate/tooltipHtml/locationLabel) plus the
// current {aisle, lo, hi} selection. Changing anything in here can change
// how the ASRS looks, never what a location IS.
//
// STRUCTURAL RACK vs STORAGE LOCATIONS (operator-requested redesign, 2026-
// 09-09 - replaces the "pillars as slabs spanning the walkway" and "No
// Walkway = push the racks together" design from the previous pass): these
// are now two separate, independent pieces of geometry.
//   - Structural rack (renderUprights/renderBeams/floor): thin vertical
//     uprights and horizontal beams, steel-looking, one set per side, each
//     confined to its OWN side's shallow footprint - never spans across the
//     walkway, never becomes a location.
//   - Storage locations (the InstancedMesh built in render()): the coloured
//     occupied/empty/duplicate cubes, unchanged math from the previous
//     pass (same pillar/level/side/depth -> x/y/z placement) - still one
//     InstancedMesh for the whole Level block, since there can be ~2,260 of
//     them and per-object Meshes would be wasteful.
//
// TWO CAMERA MODES, not two geometries (the operator's own core
// requirement): "Walkway" and "Audit" describe a VIEWPOINT on the exact
// same rack geometry, never a different rack layout. LANE_GAP is a single
// fixed constant again - there is no more "compress the racks together"
// variant.
//   - Walkway: the existing free-fly perspective camera, standing inside
//     the aisle, unchanged from the previous pass.
//   - Audit: a NEW orthographic camera, sitting on the walkway centerline
//     (Z=0) and looking sideways (-Z for the left rack, +Z for the right
//     rack) rather than down the aisle - an elevation-drawing-style view of
//     one rack wall at a time, with no perspective distortion. Standing at
//     Z=0 looking sideways means the OTHER rack is directly behind the
//     camera, never between the camera and the audited wall - no
//     obstruction, no need to hide/rebuild anything when switching sides.
// Switching cameraMode or auditSide (setCameraMode/setAuditSide, exported
// below) ONLY repositions a camera - it never touches the rack/location
// geometry, per the operator's explicit "do not destroy and rebuild the
// entire scene when changing sides" requirement. A full render() call (new
// aisle/Level/data) is the only thing that rebuilds geometry.

import * as THREE from "three";

const LEFT_PILLARS = 113;
const RIGHT_PILLARS = 113;
const PILLAR_SPACING = 1;

// Real structural pillars - NOT the same thing as the per-tote-column
// `pillar` field elsewhere in this file/asrsLocationModel.js (that's a
// location-numbering coordinate, one per tote column; a REAL pillar is a
// physical support that only appears every few columns). Operator-
// confirmed layout: the narrow 3-column group sits at the position ~221-226
// end, every other group (all the way to position 001) is 5 columns. 22
// groups of 5 plus the 3 accounts for all 113 columns exactly (3+22*5=113).
//
// This array is written in increasing VISUAL X order (X=0 first) and is
// UNCHANGED by the 2026-09-10 position-direction fix below - it doesn't
// need to be, because that fix already reversed which end of visual X
// position ~226 sits at (now X=0, the entrance - see the placement loop in
// render()). This array's own 3-group already sat at X=0..2.5, so once
// cubes flipped to put position ~221-226 there too, the two automatically
// line up correctly without touching this array. (Before that fix, this
// same X=0..2.5 zone held positions 001/003/005 - the operator-reported
// bug - because position 001 used to be the one at X=0.)
const PILLAR_GROUP_SIZES = [3, ...Array(22).fill(5)];

function computePillarXPositions() {
  const positions = [-0.5 * PILLAR_SPACING]; // the aisle's own starting pillar, before column 0
  let col = 0;
  for (const size of PILLAR_GROUP_SIZES) {
    col += size;
    positions.push((col - 0.5) * PILLAR_SPACING); // one pillar after each group
  }
  return positions;
}
const PILLAR_X_POSITIONS = computePillarXPositions();

// 2026-09-10 density correction (geometry-only, no coordinate/logic change -
// these two constants are pure rendering pitch, not part of any location's
// logical identity): the previous 0.5/0.15 pair gave each level a 1.15-unit
// vertical pitch against a 0.25-unit tall tote - ~78% empty air per level,
// the reported "floating boxes with huge gaps" look. Shrunk to just past
// what's needed to (a) keep the front/back row pair from visually merging
// and (b) leave the shelf beam (RACK_BEAM_HEIGHT) just enough clearance to
// sit in the gap without intersecting a tote - not derived from LOCATION_
// HEIGHT programmatically (kept as its own explicit tuned value, same
// independence principle as the dimension-constants group above), but
// sized against it: 0.28 leaves a 0.03 clear gap between the front/back
// pair (tight/continuous, no beam needed there - same shelf), and 0.28+0.05
// leaves a 0.08 gap between one level's back row and the next level's front
// row for the 0.06-tall beam to sit inside with a small margin each side.
// 2026-09-23 urgent fix (operator on-site, live at the aisle): "reduce this
// current gap between the shelves by 80%". The visible between-shelf gap is
// ROW_SPACING + SHELF_GAP - LOCATION_HEIGHT (0.28+0.01-0.25 = 0.04 just
// before this edit) - and critically, ROW_SPACING ALONE already contributes
// 0.03 of that (0.28-0.25), MORE than the 0.008 target (20% of 0.04) on its
// own. SHELF_GAP was already at a safe-minimum floor from the previous
// pass, so hitting an 80% cut is only possible by shrinking ROW_SPACING too
// - there is no way to satisfy this within SHELF_GAP alone. Mechanical
// consequence (not a separate request, just how this geometry model works -
// see rowY()): the front/back (01/02) SAME-shelf gap is also
// ROW_SPACING-LOCATION_HEIGHT, so it tightens to the same ~0.008 by this
// same change. Both gaps end up equal and uniformly tight.
const ROW_SPACING = 0.258; // vertical spacing between the 10 (2 per shelf) stacked rows
const SHELF_GAP = 0; // between-shelf gap is now carried entirely by ROW_SPACING's own margin above LOCATION_HEIGHT - see comment above
const LANE_GAP = 3; // walkway half-width, fixed - left rack at Z=-LANE_GAP, right rack at Z=+LANE_GAP, ALWAYS (no more "None" variant)
const SPAN_X = Math.max(LEFT_PILLARS, RIGHT_PILLARS) * PILLAR_SPACING; // every aisle has the same pillar count

// ── Dimension constants (2026-09-10 geometry correction) ─────────────────
// Three INDEPENDENT groups, deliberately never cross-derived from each
// other (operator's own explicit requirement: "the location size must not
// determine the pillar size; the pillar size must not determine the
// walkway width") - the previous pass's `RACK_DEPTH = CUBE + 0.24` broke
// this by tying the rack's own structural depth to the tote's size, which
// is exactly why the rack and the totes always overlapped regardless of
// how big/small either one was tuned.

// Location (the tote/storage-slot visual only). Position is UNCHANGED here -
// only the rendered size changes; placeInstance()'s x/y/z assignment never
// reads these constants.
//
// 2026-09-23 urgent fix (operator on-site: "how much space (blue area) is
// still pending between column... I want them just inch apart like real
// life"). ROOT CAUSE: LOCATION_WIDTH used to be tied to LOCATION_DEPTH/
// LOCATION_HEIGHT via `= LOCATION_WIDTH` / `= LOCATION_WIDTH / 2` - a single
// shared 0.5 value (half of PILLAR_SPACING=1) left HALF of every column's
// own X pitch as pure empty air between adjacent totes along the aisle (the
// "blue area" circled) - visually identical in spirit to the "huge gap
// between shelves" bug already fixed on the Y axis, just on X instead.
// FIX: LOCATION_WIDTH is now its OWN independent constant (per this
// section's own header rule - "never cross-derived from each other"),
// widened to close most of that X gap WITHOUT touching LOCATION_DEPTH/
// LOCATION_HEIGHT (already carefully tuned for the vertical-gap/beam-
// leaking fixes earlier today - widening the shared old formula would have
// silently doubled LOCATION_HEIGHT too and reintroduced the shelf-beam
// intersection bug). 0.85 is the safe maximum here, not an arbitrary
// choice: a real structural upright sits at every PILLAR_GROUP_SIZES
// boundary, exactly RACK_UPRIGHT_WIDTH/2 (0.05) + LOCATION_WIDTH/2 from the
// nearest location's own center, against a fixed 0.5-unit spacing between
// an upright's half-integer X and a location's integer X - 0.85 leaves a
// real 0.025-unit clearance there (see renderUprights()'s own comment);
// anything much higher risks the tote visually touching/overlapping the
// upright at those boundary columns.
const LOCATION_WIDTH = 0.85; // X footprint along the aisle - leaves a ~0.15 gap to the next column (was 0.5, a 50% gap)
const LOCATION_DEPTH = 0.5;  // Z footprint (into the shelf) - UNCHANGED, independent of LOCATION_WIDTH
const LOCATION_HEIGHT = 0.25; // Y footprint (tote height) - UNCHANGED, independent of LOCATION_WIDTH

// Structural rack (uprights + beams) - 2026-09-10, THIRD pass, root-cause
// fix rather than another size tweak. The previous two passes both got the
// STRUCTURE-TO-LOCATION RELATIONSHIP wrong in opposite directions:
//   - depth > LOCATION_DEPTH, same Z as the location -> the frame's own
//     face projected CLOSER to the camera than the location it sits next
//     to (visually "on top of" it - the boxes-and-bars complaint).
//   - depth small but pushed to a SEPARATE Z plane behind the location,
//     with a visible empty gap and nothing bridging it -> reads as a
//     disconnected cage floating behind a wall of totes (the "rebar"
//     complaint).
// Neither extreme is what a real rack looks like: the frame's depth
// roughly MATCHES what it holds, at the SAME centerline (LANE_GAP) as the
// location - the tote sits INSIDE the bay, not behind a second structure.
// RACK_BAY_DEPTH is shared by both uprights and beams (their junctions sit
// flush at the same depth, not two mismatched boxes) and only barely
// exceeds LOCATION_DEPTH (a few cm of margin, not a different magnitude).
// This has no X-collision risk with any location regardless of depth: an
// upright only ever exists at a PILLAR_X_POSITIONS boundary (a half-integer
// X), while every location sits at an integer X - the minimum gap between
// an upright's own center and any location's is 0.5 world units against a
// combined half-width of 0.475 (RACK_UPRIGHT_WIDTH/2 + LOCATION_WIDTH/2 =
// 0.05+0.425, per LOCATION_WIDTH's own 2026-09-23 widening to close the
// X-axis "blue area" gap between columns - see that constant's own
// comment), a real but deliberately thin 0.025-unit clearance, confirmed by
// direct measurement.
const RACK_UPRIGHT_WIDTH = 0.1; // X thickness of a vertical upright - thin, "steel" not "block"
// 2026-09-23 urgent fix (operator on-site: "shelf base is leaking out due to
// which unable to see 02 location"). ROOT CAUSE: RACK_BAY_DEPTH used to be
// LOCATION_DEPTH+0.06 - LARGER than the location it holds - so the beam/
// upright's own walkway-facing front face sat 0.03 world units CLOSER to
// the camera than the location's own front face, and even closer to the
// camera than the location's own label decal (placed at LOCATION_DEPTH/2 +
// 0.01 = 0.26 from center). At the tight vertical margins between shelves,
// that forward protrusion visually crossed right over the label - exactly
// the "leaking beam hiding the 02 location" reported. FIX: RACK_BAY_DEPTH
// is now SMALLER than LOCATION_DEPTH, so its front face sits safely BEHIND
// both the location's own face (0.25) and its label decal (0.26) - the
// beam/upright can never again render in front of a location or its label,
// on either side. Recessed further still (0.42 -> 0.15, operator follow-up)
// for extra clearance/margin from the label plane.
const RACK_BAY_DEPTH = 0.15; // front face at 0.075 from center - well behind both the location's own face (0.25) and its label decal (0.26)
const RACK_BEAM_HEIGHT = 0.005; // Y thickness of a horizontal beam - thinned to fit the ~0.008 between-shelf gap above (80% cut) with a small safe margin
const STEEL_COLOR = 0x56627a; // restrained, darker slate - low contrast against the totes' own saturated status colors, not competing with them
const FLOOR_COLOR = 0x0b1018;

// ── Camera constants ─────────────────────────────────────────────────────
// Walkway (perspective, free-fly) - unchanged reasoning from the previous
// pass: at LANE_GAP=3 a cube dead-level with the camera in X needs a very
// wide FOV to avoid top/bottom cropping; 120 is a deliberate, previously
// operator-confirmed stop short of the (unreachable) FOV that would fully
// close that gap.
const CAMERA_FOV_WALKWAY = 85; // 120 stretched the rack faces near the edges and made the location labels unreadable
const PAN_SPEED = 0.012; // world units per pixel dragged (walkway)
const DOLLY_SPEED = 0.02; // world units per wheel-delta unit (walkway)
const TURN_SPEED = 0.006; // radians per pixel right-dragged (walkway)
const GATE_SETBACK = 3; // walkway starting camera position, meters back from x=0

// Audit (orthographic, fixed sideways look) - new. AUDIT_PAD is a pan-bound
// margin only (how far past the rack's own edge positionAuditCamera/
// onPointerMove let the operator pan) - it is NOT part of the camera fit
// itself (see fitOrthoFrustum()'s own comment for why baking it into the
// fit used to cause most of the viewport to be empty space). AUDIT_FILL_
// FRACTION is how much of the viewport the rack's tighter (limiting)
// dimension should occupy - see fitOrthoFrustum()'s own comment for why
// this is fit-by-max, not fit-by-min, of the two candidate zooms.
const AUDIT_PAD_X = 4;
const AUDIT_PAD_Y = 2;
const AUDIT_FILL_FRACTION = 0.82; // within the operator's requested 75-90%/80-90% band
// How much further in than the best-fit zoom the operator may go, to read
// individual locations - a MULTIPLIER of fitOrthoFrustum()'s own computed
// fitZoom, not an absolute zoom value (2026-09-10 fix: the previous
// AUDIT_MAX_ZOOM=10 absolute ceiling was tuned for a taller/sparser rack;
// once the rack geometry became denser - see ROW_SPACING/SHELF_GAP above -
// the correct fit zoom for the same rack exceeded 10 and got silently
// clamped, which was the OTHER half of the reported "even at max zoom,
// huge empty space" bug, alongside fitOrthoFrustum's own pad-in-the-fill-
// ratio mistake described there).
const AUDIT_ZOOM_IN_MULT = 6;

const LABEL_PILLAR_RANGE = 24; // walkway - world units along X either side of the camera that get a location decal
const AUDIT_LABEL_MIN_ZOOM = 1.4; // audit - decals only appear once zoomed in enough to actually read them (keeps decal count bounded when the whole rack is framed at once)

const UP = new THREE.Vector3(0, 1, 0);

let cameraMode = "walkway"; // "walkway" | "audit"
let auditSide = "left"; // "left" | "right" - audit mode only

// Walkway free-fly state (unchanged from the previous pass)
let yaw = 0;
let forwardVec = new THREE.Vector3(1, 0, 0);
let rightVec = new THREE.Vector3(0, 0, 1);
const BOUNDS_PAD = 4;
let boundsY = { min: -BOUNDS_PAD, max: BOUNDS_PAD };
let boundsZ = { min: -(LANE_GAP + BOUNDS_PAD), max: LANE_GAP + BOUNDS_PAD };
const boundsX = { min: -BOUNDS_PAD, max: SPAN_X + BOUNDS_PAD };

let renderer = null, scene = null, perspCamera = null, orthoCamera = null, activeCamera = null, container = null;
let raycaster = null, mouse = null;
let cubeMesh = null; // storage locations InstancedMesh
let instanceSlots = []; // instanceId -> {aisle, level, pillar, side, depthCode, depth, x, y, z, locationLabel}
let tooltipEl = null;
let getTooltipHtml = null;
let animationHandle = null;
let resizeObserver = null;
let dividerGeometry = null, dividerMaterial = null;
let dividers = [];
let uprightGeometry = null, uprightMaterial = null, uprightMesh = null;
let beamGeometry = null, beamMaterial = null, beamMesh = null;
let floorMesh = null, floorGeometry = null, floorMaterial = null;
let labelPlaneGeometry = null;
let labelObjects = new Map(); // instanceId -> THREE.Mesh
let lastLabelUpdateAt = 0;
let hoverHighlight = null, selectHighlight = null, highlightGeometry = null, hoverHighlightMaterial = null, selectHighlightMaterial = null;
let hoveredInstanceId = null;
let selectedInstanceId = null;

let _currentTopY = 0; // this Level's own vertical span - cached so setCameraMode/setAuditSide can reframe without a full render() call

function rowY(li, back) {
  return li * (2 * ROW_SPACING + SHELF_GAP) + (back ? ROW_SPACING : 0);
}

let dragging = false;
let dragButton = 0;
let lastPointerX = 0, lastPointerY = 0;
let pointerDownX = 0, pointerDownY = 0;
const CLICK_MOVE_THRESHOLD = 4; // pixels - a pointerdown/up pair moving less than this is a click (select), not a drag

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function clampWalkwayPosition() {
  perspCamera.position.x = clamp(perspCamera.position.x, boundsX.min, boundsX.max);
  perspCamera.position.y = clamp(perspCamera.position.y, boundsY.min, boundsY.max);
  perspCamera.position.z = clamp(perspCamera.position.z, boundsZ.min, boundsZ.max);
}

function updateOrientation() {
  forwardVec.set(Math.cos(yaw), 0, Math.sin(yaw));
  rightVec.set(-Math.sin(yaw), 0, Math.cos(yaw));
  perspCamera.lookAt(perspCamera.position.clone().add(forwardVec));
}

// ── Audit camera framing ─────────────────────────────────────────────────

// Sets orthoCamera's frustum to exactly match the container's aspect at a
// fixed logical vertical extent, then sets zoom so the rack fills
// AUDIT_FILL_FRACTION of the viewport - "the rack wall should occupy most
// of the usable viewport", per the operator's own requirement. Called on
// every full render() and on resize; NOT called on a plain side switch (see
// positionAuditCamera) so panning/zooming the operator already did is not
// reset just by toggling sides back and forth unless `resetZoom` is
// explicitly passed.
//
// FIT-BY-MAX, not fit-by-min (2026-09-10, operator-reported: the rack is
// ~113 units long but only ~5 units tall for a 5-shelf Level - a ~22:1
// strip, far more elongated than any normal viewport. Fitting by whichever
// axis needs the SMALLER zoom (the original approach) always let the WIDTH
// constraint win for a rack this shape, since the full 113-unit length no
// longer fits at a zoom that also fills the ~5-unit height - the result was
// the reported "tiny horizontal strip with huge empty space above/below".
// Fitting by whichever axis needs the LARGER zoom instead guarantees the
// TIGHTER (limiting) axis always reaches the target fill fraction; the
// other axis (here, width) overflows past the viewport and is reached by
// panning - exactly "audit one wall, pan for the rest", not "cram the
// entire aisle length into one frame". This is still fully dynamic (driven
// by SPAN_X/_currentTopY/container aspect, no hardcoded distance) so it
// self-corrects for a different Level's shelf count, a different aisle's
// dimensions, and a browser resize (the existing ResizeObserver already
// re-runs this).
function fitOrthoFrustum(resetZoom) {
  if (!orthoCamera || !container) return;
  const w = container.clientWidth || 800;
  const h = container.clientHeight || 500;
  const aspect = w / h;
  // Fixed logical half-height of 40 world units at zoom=1 - arbitrary but
  // stable; only `zoom` (computed below) determines what's actually framed.
  const baseHalfH = 40;
  const baseHalfW = baseHalfH * aspect;
  orthoCamera.left = -baseHalfW;
  orthoCamera.right = baseHalfW;
  orthoCamera.top = baseHalfH;
  orthoCamera.bottom = -baseHalfH;
  orthoCamera.near = 0.1;
  orthoCamera.far = 400;

  // Fit purely to the rack's OWN visible extents (SPAN_X, _currentTopY) -
  // no pad, no floor, no aisle-length-beyond-the-rack, no other scene
  // geometry. AUDIT_PAD_X/Y are pan-bound margins only (positionAuditCamera/
  // onPointerMove's clamp calls below), never part of what "fill the
  // viewport" is measured against - baking a fixed-world-unit pad into this
  // ratio was the root cause of the reported "even at max zoom, huge empty
  // space above/below": for a rack only a few units tall, a 2-unit pad on
  // each side was comparable in size to the rack itself, so the requested
  // 82% "fill" was actually roughly half rack, half padding.
  const rackHalfW = SPAN_X / 2;
  const rackHalfH = _currentTopY / 2;
  const zoomForWidth = (baseHalfW * AUDIT_FILL_FRACTION) / rackHalfW;
  const zoomForHeight = (baseHalfH * AUDIT_FILL_FRACTION) / rackHalfH;
  const fitZoom = Math.max(zoomForWidth, zoomForHeight);
  const minZoom = fitZoom; // never allow zooming back OUT past the best fit - keeps the reported bug from recurring via scroll
  const maxZoom = fitZoom * AUDIT_ZOOM_IN_MULT;
  if (resetZoom || !orthoCamera.zoom || orthoCamera.zoom < minZoom || orthoCamera.zoom > maxZoom) {
    orthoCamera.zoom = fitZoom;
  }
  orthoCamera._minZoom = minZoom;
  orthoCamera._maxZoom = maxZoom;
  orthoCamera.updateProjectionMatrix();
}

// The audit camera's own screen-right and look-forward directions, purely a
// function of which wall is being audited - shared by positionAuditCamera,
// the drag-pan handler, and panAuditStep (arrow buttons) so the three never
// drift out of sync on which way is "right" for a given side. Standing on
// the centerline looking -Z (left wall) puts world +X on screen-right;
// looking +Z (right wall) mirrors that to world -X - see this file's own
// header comment for the Z convention.
function auditForward(side) {
  return side === "left" ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 0, 1);
}
function auditLocalRight(side) {
  return side === "left" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(-1, 0, 0);
}
function clampAuditPosition() {
  orthoCamera.position.x = clamp(orthoCamera.position.x, -AUDIT_PAD_X, SPAN_X + AUDIT_PAD_X);
  orthoCamera.position.y = clamp(orthoCamera.position.y, -AUDIT_PAD_Y, _currentTopY + AUDIT_PAD_Y);
}

// Points the audit camera at the given side, standing on the walkway
// centerline (Z=0) so the OTHER rack sits directly behind the camera -
// never between the camera and the wall being audited, so switching sides
// never needs to hide or rebuild anything. Pure camera move - no geometry
// touched.
function positionAuditCamera(side, resetZoom) {
  if (!orthoCamera) return;
  const x = clamp(orthoCamera.position.x || SPAN_X / 2, -AUDIT_PAD_X, SPAN_X + AUDIT_PAD_X);
  const y = clamp(orthoCamera.position.y || _currentTopY / 2, -AUDIT_PAD_Y, _currentTopY + AUDIT_PAD_Y);
  orthoCamera.position.set(x, y, 0);
  orthoCamera.up.set(0, 1, 0);
  orthoCamera.lookAt(orthoCamera.position.clone().add(auditForward(side)));
  fitOrthoFrustum(resetZoom);
}

// Arrow-button navigation (2026-09-10 addition, operator-requested: dragging
// across the full ~113-unit rack length at Audit's now much tighter fit
// zoom took an impractical amount of mouse travel). Steps by a FRACTION of
// whatever is currently visible - not a fixed world-unit distance - so it
// self-scales with zoom exactly like the fit calculation itself: zoomed
// out, a step covers a lot of rack; zoomed in to read individual locations,
// a step covers correspondingly less, never overshooting past what the
// operator can still recognize as "the next bit over". AUDIT_STEP_OVERLAP
// keeps a slice of the previous view in frame so consecutive presses read
// as paging, not teleporting.
const AUDIT_STEP_OVERLAP = 0.85; // fraction of the current visible width moved per press
function panAuditStep(direction) {
  if (!orthoCamera || cameraMode !== "audit") return;
  const visibleWidth = (orthoCamera.right - orthoCamera.left) / orthoCamera.zoom;
  const step = visibleWidth * AUDIT_STEP_OVERLAP * (direction === "right" ? 1 : -1);
  orthoCamera.position.addScaledVector(auditLocalRight(auditSide), step);
  clampAuditPosition();
  orthoCamera.lookAt(orthoCamera.position.clone().add(auditForward(auditSide)));
}

// Switches which camera is active without touching the rack/location scene
// graph at all - a genuine new aisle/Level (render()) is the only thing
// that rebuilds geometry.
function applyCameraMode(opts = {}) {
  if (cameraMode === "audit") {
    activeCamera = orthoCamera;
    positionAuditCamera(auditSide, opts.resetFraming);
  } else {
    activeCamera = perspCamera;
  }
}

function onPointerDown(e) {
  dragging = true;
  dragButton = e.button;
  lastPointerX = pointerDownX = e.clientX;
  lastPointerY = pointerDownY = e.clientY;
}
function onPointerUp(e) {
  dragging = false;
  const moved = Math.abs(e.clientX - pointerDownX) + Math.abs(e.clientY - pointerDownY);
  if (moved < CLICK_MOVE_THRESHOLD && e.button === 0) selectAtPointer(e);
}
function onContextMenu(e) {
  e.preventDefault();
}
function onPointerMove(e) {
  if (!dragging) {
    updateHoverAndTooltip(e);
    return;
  }
  const dx = e.clientX - lastPointerX;
  const dy = e.clientY - lastPointerY;
  lastPointerX = e.clientX;
  lastPointerY = e.clientY;

  if (cameraMode === "audit") {
    // Pan only - no turning in a fixed elevation view. 2026-09-10 fix: pan
    // now moves the world EXACTLY with the cursor (1 dragged pixel = 1
    // pixel's worth of world content at the current zoom), replacing the
    // old fixed AUDIT_PAN_SPEED constant - that constant was tuned back
    // when Audit's fit zoom sat around ~7; once the rack-density fix (see
    // ROW_SPACING/SHELF_GAP) and the audit fit-zoom fix (see
    // fitOrthoFrustum) pushed a typical fit zoom to the 20s, the same
    // constant-divided-by-zoom math made a full drag across the screen move
    // only a sliver of the rack - "going left/right is very slow". Deriving
    // the per-pixel distance straight from the frustum's own visible width/
    // height is self-scaling and needs no re-tuning if the rack's own
    // proportions or the container size change again.
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 500;
    const worldPerPxX = (orthoCamera.right - orthoCamera.left) / orthoCamera.zoom / w;
    const worldPerPxY = (orthoCamera.top - orthoCamera.bottom) / orthoCamera.zoom / h;
    orthoCamera.position.addScaledVector(auditLocalRight(auditSide), -dx * worldPerPxX);
    orthoCamera.position.addScaledVector(UP, dy * worldPerPxY);
    clampAuditPosition();
    orthoCamera.lookAt(orthoCamera.position.clone().add(auditForward(auditSide)));
  } else if (dragButton === 2) {
    yaw += dx * TURN_SPEED;
    updateOrientation();
  } else {
    perspCamera.position.addScaledVector(rightVec, dx * PAN_SPEED);
    perspCamera.position.addScaledVector(UP, -dy * PAN_SPEED);
    clampWalkwayPosition();
    updateOrientation();
  }
  hideTooltip();
}

function onWheel(e) {
  e.preventDefault();
  if (cameraMode === "audit") {
    const factor = Math.exp(-e.deltaY * 0.001);
    const minZoom = orthoCamera._minZoom || 0.05;
    const maxZoom = orthoCamera._maxZoom || minZoom * AUDIT_ZOOM_IN_MULT;
    orthoCamera.zoom = clamp(orthoCamera.zoom * factor, minZoom, maxZoom);
    orthoCamera.updateProjectionMatrix();
  } else {
    perspCamera.position.addScaledVector(forwardVec, -e.deltaY * DOLLY_SPEED);
    clampWalkwayPosition();
    updateOrientation();
  }
}

function applyResize() {
  if (!container || !renderer) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (!w || !h) return;
  if (perspCamera) {
    perspCamera.aspect = w / h;
    perspCamera.updateProjectionMatrix();
  }
  if (orthoCamera) fitOrthoFrustum(false);
  renderer.setSize(w, h);
}

function ensureScene(containerEl) {
  if (renderer && container === containerEl) return;
  dispose();

  container = containerEl;
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 500;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a111c);
  scene.fog = new THREE.Fog(0x0a111c, 30, 140); // far racks fade into the dark instead of becoming a noisy wall

  perspCamera = new THREE.PerspectiveCamera(CAMERA_FOV_WALKWAY, width / height, 0.1, 400);
  orthoCamera = new THREE.OrthographicCamera(-40, 40, 40, -40, 0.1, 400);
  activeCamera = perspCamera;

  renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x0b1017, 0.75)); // cool sky, dark floor bounce
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.55);
  dirLight.position.set(30, 60, 30);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(1024, 1024);
  dirLight.shadow.camera.near = 1;
  dirLight.shadow.camera.far = 200;
  dirLight.shadow.camera.left = -80;
  dirLight.shadow.camera.right = 80;
  dirLight.shadow.camera.top = 80;
  dirLight.shadow.camera.bottom = -80;
  scene.add(dirLight);
  // Mirrored second light (no shadow - one shadow-casting light is plenty
  // for this scene and a second shadow map would double the cost for
  // negligible visual gain) so BOTH rack faces get their own inward light,
  // not just whichever one the single light happens to point at.
  const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.35);
  dirLight2.position.set(30, 60, -30);
  scene.add(dirLight2);

  // Floor - built once here (not per-render()), sized generously to cover
  // any Level's footprint. Purely for depth perception, never interactive.
  floorGeometry = new THREE.PlaneGeometry(SPAN_X + 20, (LANE_GAP + 6) * 2);
  floorGeometry.rotateX(-Math.PI / 2);
  floorMaterial = new THREE.MeshStandardMaterial({ color: FLOOR_COLOR, roughness: 0.95, metalness: 0.05 });
  floorMesh = new THREE.Mesh(floorGeometry, floorMaterial);
  floorMesh.position.set(SPAN_X / 2, -LOCATION_HEIGHT / 2, 0);
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);

  // A faint guide down the middle of the walkway: gives the eye a line to follow and a sense of speed.
  guideGeometry = new THREE.PlaneGeometry(SPAN_X + 20, 0.14);
  guideGeometry.rotateX(-Math.PI / 2);
  guideMaterial = new THREE.MeshBasicMaterial({ color: 0x36d6cf, transparent: true, opacity: 0.45, fog: true });
  guideMesh = new THREE.Mesh(guideGeometry, guideMaterial);
  guideMesh.position.set(SPAN_X / 2, -LOCATION_HEIGHT / 2 + 0.005, 0);
  scene.add(guideMesh);

  // 2026-09-23 urgent fix (operator on-site: "white part still oozing out
  // hiding the 02 locations"). ROOT CAUSE: this plane's own comment always
  // called it "a thin marker line", but its actual geometry was 1 full
  // world unit deep (PlaneGeometry's 2nd arg, which becomes Z-depth after
  // the rotateX below) - roughly DOUBLE the location's own depth (0.5) and
  // completely disconnected from RACK_BAY_DEPTH/SHELF_GAP - this was never
  // actually thin, it was a light-grey (0x8892a0, distinctly whiter than
  // the darker steel 0x4a5260 rack color) slab bigger than the rack itself,
  // centered on the location's own face and so protruding ~0.5 units both
  // toward the camera and back into the rack at every single shelf
  // boundary - the real "oozing white" bug, entirely separate from (and
  // unaffected by) the RACK_BAY_DEPTH/RACK_BEAM_HEIGHT fix made earlier
  // today for the (correctly-sized, darker) structural beam mesh. FIX:
  // actually make it thin (0.02 - a hairline boundary marker, not a slab).
  dividerGeometry = new THREE.PlaneGeometry(SPAN_X + 1, 0.02);
  dividerGeometry.rotateX(-Math.PI / 2);
  dividerMaterial = new THREE.MeshBasicMaterial({ color: 0x8892a0 });

  labelPlaneGeometry = new THREE.PlaneGeometry(LOCATION_WIDTH * 0.92, LOCATION_HEIGHT * 0.92);

  // Structural rack (uprights + beams) share ONE material (2026-09-10 -
  // operator-requested "one coherent steel structure", not two competing
  // greys) - restrained/matte rather than a bright, high-contrast metal, so
  // the location status colours stay the primary visual signal.
  uprightGeometry = new THREE.BoxGeometry(RACK_UPRIGHT_WIDTH, 1, RACK_BAY_DEPTH);
  beamGeometry = new THREE.BoxGeometry(SPAN_X + RACK_UPRIGHT_WIDTH, RACK_BEAM_HEIGHT, RACK_BAY_DEPTH);
  uprightMaterial = new THREE.MeshStandardMaterial({ color: STEEL_COLOR, roughness: 0.65, metalness: 0.45 });
  beamMaterial = uprightMaterial;

  // Hover/selection highlight - a single shared wireframe-ish box each,
  // reused/repositioned per hit rather than one per instance (cheap, and
  // there is only ever at most one hovered + one selected cube at a time).
  highlightGeometry = new THREE.BoxGeometry(LOCATION_WIDTH * 1.12, LOCATION_HEIGHT * 1.25, LOCATION_DEPTH * 1.12);
  hoverHighlightMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.6 });
  selectHighlightMaterial = new THREE.MeshBasicMaterial({ color: 0x36d6cf, wireframe: true, transparent: true, opacity: 0.95 });
  hoverHighlight = new THREE.Mesh(highlightGeometry, hoverHighlightMaterial);
  selectHighlight = new THREE.Mesh(highlightGeometry, selectHighlightMaterial);
  hoverHighlight.visible = false;
  selectHighlight.visible = false;
  scene.add(hoverHighlight);
  scene.add(selectHighlight);

  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();
  renderer.domElement.addEventListener("mousedown", onPointerDown);
  window.addEventListener("mouseup", onPointerUp);
  renderer.domElement.addEventListener("mousemove", onPointerMove);
  renderer.domElement.addEventListener("mouseleave", hideTooltip);
  renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
  renderer.domElement.addEventListener("contextmenu", onContextMenu);

  resizeObserver = new ResizeObserver(applyResize);
  resizeObserver.observe(container);

  animate();
}

function animate() {
  animationHandle = requestAnimationFrame(animate);
  if (renderer && scene && activeCamera) {
    updateLabels();
    renderer.render(scene, activeCamera);
  }
}

let guideGeometry = null;
let guideMaterial = null;
let guideMesh = null;
let hudEl = null;
const LABEL_CANVAS_W = 1024; // same 3.4 : 1 shape as the plane it is drawn on - a 2 : 1 canvas stretched the text sideways
const LABEL_CANVAS_H = 300;
function createLabelTexture(text) {
  const canvas = document.createElement("canvas");
  canvas.width = LABEL_CANVAS_W;
  canvas.height = LABEL_CANVAS_H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(7, 12, 20, 0.82)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#eef6fb";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const maxTextWidth = canvas.width * 0.92;
  let fontSize = 190;
  ctx.font = `700 ${fontSize}px Inter, "Segoe UI", sans-serif`;
  while (fontSize > 40 && ctx.measureText(text).width > maxTextWidth) {
    fontSize -= 6;
    ctx.font = `700 ${fontSize}px Inter, "Segoe UI", sans-serif`;
  }
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 6);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 4; // keeps the text sharp at the grazing angles of a walkway view
  texture.needsUpdate = true;
  return texture;
}

function disposeLabel(label) {
  scene.remove(label);
  label.material.map.dispose();
  label.material.dispose();
}

// Effective horizontal (X) range, in world units, that should carry a
// location decal right now - walkway uses a fixed constant (unchanged from
// the previous pass); audit derives it from the ortho frustum's own actual
// visible width so decals only exist where they could plausibly be read,
// and are gated further by AUDIT_LABEL_MIN_ZOOM so zooming out to see the
// whole rack doesn't spawn 1,000+ canvas-texture decals at once.
function activeLabelRangeX() {
  if (cameraMode === "audit") {
    if (orthoCamera.zoom < AUDIT_LABEL_MIN_ZOOM) return 0;
    return (orthoCamera.right - orthoCamera.left) / (2 * orthoCamera.zoom) + 2;
  }
  return LABEL_PILLAR_RANGE;
}

const LABEL_UPDATE_INTERVAL_MS = 150;
function updateLabels() {
  if (!cubeMesh || !activeCamera || !labelPlaneGeometry) return;
  const now = performance.now();
  if (now - lastLabelUpdateAt < LABEL_UPDATE_INTERVAL_MS) return;
  lastLabelUpdateAt = now;

  const camX = activeCamera.position.x;
  const range = activeLabelRangeX();
  const faceOffset = LOCATION_DEPTH / 2 + 0.01;
  let nearest = null;
  let nearestDx = Infinity;

  for (let idx = 0; idx < instanceSlots.length; idx++) {
    const slot = instanceSlots[idx];
    if (!slot) continue;
    const dx = slot.x - camX;
    if (slot.depthCode === "01" && Math.abs(dx) < nearestDx) { nearestDx = Math.abs(dx); nearest = slot; }
    const withinRange = Math.abs(dx) <= range;
    const existing = labelObjects.get(idx);

    if (withinRange && !existing) {
      const material = new THREE.MeshBasicMaterial({
        map: createLabelTexture(slot.locationLabel),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const label = new THREE.Mesh(labelPlaneGeometry, material);
      if (slot.side === "left") {
        label.position.set(slot.x, slot.y, slot.z + faceOffset);
      } else {
        label.position.set(slot.x, slot.y, slot.z - faceOffset);
        label.rotation.y = Math.PI;
      }
      scene.add(label);
      labelObjects.set(idx, label);
    } else if (!withinRange && existing) {
      disposeLabel(existing);
      labelObjects.delete(idx);
    }
  }
  // Where the viewer is, in the same location vocabulary as the labels (never a number invented here).
  if (hudEl) hudEl.textContent = nearest && nearest.locationLabel ? "Near " + nearest.locationLabel : "";
}

function slotKeyFor(aisle, level, pillar, side, depthCode) {
  return `${aisle}-${level}-${pillar}-${side === "left" ? "L" : "R"}-${depthCode}`;
}

function placeInstance(dummy, idx, x, y, z, aisle, level, pillar, side, depthCode, isOccupied, isDuplicate, colorOccupied, colorEmpty, colorDup, locationLabel) {
  dummy.position.set(x, y, z);
  dummy.updateMatrix();
  cubeMesh.setMatrixAt(idx, dummy.matrix);

  const slotKey = slotKeyFor(aisle, level, pillar, side, depthCode);
  const color = isDuplicate(slotKey) ? colorDup : isOccupied(slotKey) ? colorOccupied : colorEmpty;
  cubeMesh.setColorAt(idx, color);

  const slot = { aisle, level, pillar, side, depthCode, depth: depthCode === "01" ? "front" : "back", x, y, z, slotKey };
  slot.locationLabel = locationLabel ? locationLabel(slot) : "";
  instanceSlots[idx] = slot;
}

// One vertical upright per PILLAR_X_POSITIONS entry, per side - AT the same
// Z centerline as the locations on that side (LANE_GAP), confined to
// RACK_BAY_DEPTH (only barely larger than a location's own depth - the
// tote sits INSIDE the bay the upright frames, not behind a separate
// structure). NEVER spans toward the walkway or the other side. No X-
// collision risk with any location: uprights only ever exist at a
// PILLAR_X_POSITIONS half-integer boundary, at least 0.5 world units from
// the nearest integer-X location - see this file's dimension-constants
// comment for the exact margin.
function renderUprights(levelCount) {
  if (uprightMesh) {
    scene.remove(uprightMesh);
    uprightMesh = null;
  }
  const topY = rowY(levelCount - 1, true) + ROW_SPACING;
  const height = topY + LOCATION_HEIGHT;
  const count = PILLAR_X_POSITIONS.length * 2; // both sides
  uprightMesh = new THREE.InstancedMesh(uprightGeometry, uprightMaterial, count);
  uprightMesh.castShadow = true;
  uprightMesh.receiveShadow = true;
  const dummy = new THREE.Object3D();
  let i = 0;
  for (const z of [-LANE_GAP, LANE_GAP]) {
    for (const x of PILLAR_X_POSITIONS) {
      dummy.position.set(x, height / 2 - LOCATION_HEIGHT / 2, z);
      dummy.scale.set(1, height, 1); // BoxGeometry's own unit height (1) scaled to this Level's actual height
      dummy.updateMatrix();
      uprightMesh.setMatrixAt(i++, dummy.matrix);
    }
  }
  uprightMesh.instanceMatrix.needsUpdate = true;
  scene.add(uprightMesh);
}

// One horizontal beam per shelf boundary (levelCount+1 of them - floor,
// every real-shelf boundary, and the top), per side - spans the FULL rack
// length (X), sits at the SAME RACK_BAY_DEPTH/Z-centerline as the uprights
// (their junctions are flush - one structural plane, not two mismatched
// boxes crossing through each other) and at the SAME Y as the location
// row it supports, exactly like a real shelf rail the totes rest on.
function renderBeams(levelCount) {
  if (beamMesh) {
    scene.remove(beamMesh);
    beamMesh = null;
  }
  const boundaries = [0];
  for (let li = 0; li < levelCount - 1; li++) boundaries.push((rowY(li, true) + rowY(li + 1, false)) / 2);
  boundaries.push(rowY(levelCount - 1, true) + ROW_SPACING);

  const count = boundaries.length * 2;
  beamMesh = new THREE.InstancedMesh(beamGeometry, beamMaterial, count);
  beamMesh.castShadow = true;
  beamMesh.receiveShadow = true;
  const dummy = new THREE.Object3D();
  let i = 0;
  for (const z of [-LANE_GAP, LANE_GAP]) {
    for (const y of boundaries) {
      dummy.position.set(SPAN_X / 2 - 0.5, y - LOCATION_HEIGHT / 2, z);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      beamMesh.setMatrixAt(i++, dummy.matrix);
    }
  }
  beamMesh.instanceMatrix.needsUpdate = true;
  scene.add(beamMesh);
}

// A thin marker line per real-shelf boundary, drawn on the location's own
// WALKWAY-facing front face (same convention as the label decals just
// below) rather than buried at the rack centerline - 2026-09-10 fix: a
// zero-thickness plane sitting exactly inside a solid tote's own volume is
// a latent z-fighting artifact, the same "shared coordinate" mistake the
// structural frame itself just moved away from.
const DIVIDER_FACE_OFFSET = LOCATION_DEPTH / 2 + 0.01;
function renderShelfDividers(levelCount) {
  for (const d of dividers) scene.remove(d);
  dividers = [];
  for (let li = 0; li < levelCount - 1; li++) {
    const y = (rowY(li, true) + rowY(li + 1, false)) / 2;
    for (const faceZ of [-LANE_GAP + DIVIDER_FACE_OFFSET, LANE_GAP - DIVIDER_FACE_OFFSET]) {
      const line = new THREE.Mesh(dividerGeometry, dividerMaterial);
      line.position.set(SPAN_X / 2 - 0.5, y, faceZ);
      scene.add(line);
      dividers.push(line);
    }
  }
}

// { containerEl, aisle, lo, hi, cameraMode ("walkway"|"audit"),
//   auditSide ("left"|"right"), isOccupied(slotKey)->bool,
//   isDuplicate(slotKey)->bool, tooltipHtml(slot)->html, tooltipEl,
//   locationLabel(slot)->string }
function render(opts) {
  ensureScene(opts.containerEl);
  tooltipEl = opts.tooltipEl;
  hudEl = opts.hudEl || null;
  getTooltipHtml = opts.tooltipHtml;
  cameraMode = opts.cameraMode === "audit" ? "audit" : "walkway";
  auditSide = opts.auditSide === "right" ? "right" : "left";

  if (cubeMesh) {
    scene.remove(cubeMesh);
    cubeMesh.geometry.dispose();
    cubeMesh.material.dispose();
    cubeMesh = null;
  }
  for (const label of labelObjects.values()) disposeLabel(label);
  labelObjects.clear();
  instanceSlots = [];
  hoveredInstanceId = null;
  selectedInstanceId = null;
  hoverHighlight.visible = false;
  selectHighlight.visible = false;

  const { aisle, lo, hi, isOccupied, isDuplicate, locationLabel } = opts;
  const levelCount = hi - lo + 1;
  const count = levelCount * (LEFT_PILLARS + RIGHT_PILLARS) * 2;

  const geometry = new THREE.BoxGeometry(LOCATION_WIDTH, LOCATION_HEIGHT, LOCATION_DEPTH);
  const material = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.15 });
  cubeMesh = new THREE.InstancedMesh(geometry, material, count);
  // Storage cubes never cast/receive shadows (2026-09-09, performance -
  // there can be ~2,260 of them; the few dozen structural members and the
  // floor plane are what actually sell the "real rack" depth cue).
  cubeMesh.castShadow = false;
  cubeMesh.receiveShadow = false;

  const colorOccupied = new THREE.Color(0x2c8f6a); // calm: most of the rack is fine
  const colorEmpty = new THREE.Color(0xff5a66); // loud: this is what an audit is looking for
  const colorDup = new THREE.Color(0xffc247);
  const dummy = new THREE.Object3D();

  let i = 0;
  for (let level = lo; level <= hi; level++) {
    const li = level - lo;
    const yFront = rowY(li, false);
    const yBack = rowY(li, true);

    // Visual X is DELIBERATELY the reverse of the pillar index (2026-09-10,
    // operator-reported: entering the aisle should meet position ~226
    // first, with position 001 at the far end - the opposite of what
    // `x = pillar * PILLAR_SPACING` gave). This is a pure VISUAL placement
    // flip only - `pillar`/`side`/`depthCode` (and therefore slotKey and
    // every location string via locationLabel()) are passed through
    // completely unchanged, so occupancy/duplicate lookups and the label
    // text are exactly what they were before. The walkway camera still
    // starts at x=-GATE_SETBACK looking toward +X (untouched), so it now
    // meets the flipped (high-pillar/high-position) end first, as intended.
    // This same flip is also what correctly re-aligns the structural
    // pillar grouping fix below - see PILLAR_GROUP_SIZES's own comment.
    for (let pillar = 0; pillar < LEFT_PILLARS; pillar++) {
      const x = (LEFT_PILLARS - 1 - pillar) * PILLAR_SPACING;
      placeInstance(dummy, i++, x, yFront, -LANE_GAP, aisle, level, pillar, "left", "01", isOccupied, isDuplicate, colorOccupied, colorEmpty, colorDup, locationLabel);
      placeInstance(dummy, i++, x, yBack, -LANE_GAP, aisle, level, pillar, "left", "02", isOccupied, isDuplicate, colorOccupied, colorEmpty, colorDup, locationLabel);
    }
    for (let p = 0; p < RIGHT_PILLARS; p++) {
      const pillar = p + 1;
      const x = (RIGHT_PILLARS - 1 - p) * PILLAR_SPACING;
      placeInstance(dummy, i++, x, yFront, LANE_GAP, aisle, level, pillar, "right", "01", isOccupied, isDuplicate, colorOccupied, colorEmpty, colorDup, locationLabel);
      placeInstance(dummy, i++, x, yBack, LANE_GAP, aisle, level, pillar, "right", "02", isOccupied, isDuplicate, colorOccupied, colorEmpty, colorDup, locationLabel);
    }
  }

  cubeMesh.instanceMatrix.needsUpdate = true;
  if (cubeMesh.instanceColor) cubeMesh.instanceColor.needsUpdate = true;
  scene.add(cubeMesh);

  renderShelfDividers(levelCount);
  renderUprights(levelCount);
  renderBeams(levelCount);

  const topY = rowY(levelCount - 1, true);
  _currentTopY = topY;
  boundsY = { min: -BOUNDS_PAD, max: topY + BOUNDS_PAD };
  boundsZ = { min: -(LANE_GAP + BOUNDS_PAD), max: LANE_GAP + BOUNDS_PAD };

  // Walkway's own free-fly camera always resets to the "open the gate"
  // starting position/orientation on a genuine new render() (new aisle/
  // Level/data) - unchanged from the previous pass. It is NEVER reset by a
  // mode/side toggle alone (see setCameraMode/setAuditSide below).
  perspCamera.position.set(-GATE_SETBACK, topY / 2, 0);
  yaw = 0;
  updateOrientation();

  applyCameraMode({ resetFraming: true });
}

// Lightweight mode switch - camera only, per the operator's explicit "do
// not destroy and rebuild the entire scene" requirement. Safe to call any
// time after at least one render() has run.
function setCameraMode(mode) {
  cameraMode = mode === "audit" ? "audit" : "walkway";
  applyCameraMode({ resetFraming: true });
}

// Lightweight side switch (audit mode only) - camera only.
function setAuditSide(side) {
  auditSide = side === "right" ? "right" : "left";
  if (cameraMode === "audit") applyCameraMode({ resetFraming: true });
}

function pickInstance(event) {
  if (!cubeMesh || !raycaster || !activeCamera) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, activeCamera);
  const hits = raycaster.intersectObject(cubeMesh);
  return hits.length ? hits[0] : null;
}

function positionHighlight(mesh, slot) {
  mesh.position.set(slot.x, slot.y, slot.z);
  mesh.visible = true;
}

function updateHoverAndTooltip(event) {
  const hit = pickInstance(event);
  if (!hit) {
    hoveredInstanceId = null;
    hoverHighlight.visible = false;
    hideTooltip();
    return;
  }
  const slot = instanceSlots[hit.instanceId];
  if (!slot) return;
  hoveredInstanceId = hit.instanceId;
  positionHighlight(hoverHighlight, slot);
  if (tooltipEl && getTooltipHtml) {
    tooltipEl.innerHTML = getTooltipHtml(slot);
    tooltipEl.style.left = event.clientX + 14 + "px";
    tooltipEl.style.top = event.clientY + 14 + "px";
    tooltipEl.classList.remove("hidden");
  }
}

function selectAtPointer(event) {
  const hit = pickInstance(event);
  if (!hit) {
    selectedInstanceId = null;
    selectHighlight.visible = false;
    return;
  }
  const slot = instanceSlots[hit.instanceId];
  if (!slot) return;
  selectedInstanceId = hit.instanceId;
  positionHighlight(selectHighlight, slot);
  if (tooltipEl && getTooltipHtml) {
    tooltipEl.innerHTML = getTooltipHtml(slot);
    tooltipEl.style.left = event.clientX + 14 + "px";
    tooltipEl.style.top = event.clientY + 14 + "px";
    tooltipEl.classList.remove("hidden");
  }
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.classList.add("hidden");
}

function dispose() {
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
  if (animationHandle) { cancelAnimationFrame(animationHandle); animationHandle = null; }
  if (renderer) {
    renderer.domElement.removeEventListener("mousedown", onPointerDown);
    window.removeEventListener("mouseup", onPointerUp);
    renderer.domElement.removeEventListener("mousemove", onPointerMove);
    renderer.domElement.removeEventListener("mouseleave", hideTooltip);
    renderer.domElement.removeEventListener("wheel", onWheel);
    renderer.domElement.removeEventListener("contextmenu", onContextMenu);
    renderer.dispose();
  }
  if (cubeMesh) { cubeMesh.geometry.dispose(); cubeMesh.material.dispose(); cubeMesh = null; }
  if (dividerGeometry) { dividerGeometry.dispose(); dividerGeometry = null; }
  if (dividerMaterial) { dividerMaterial.dispose(); dividerMaterial = null; }
  dividers = [];
  if (uprightGeometry) { uprightGeometry.dispose(); uprightGeometry = null; }
  // uprightMaterial and beamMaterial are the SAME shared object (one
  // coherent steel structure, see ensureScene()) - dispose it once only.
  if (uprightMaterial) { uprightMaterial.dispose(); uprightMaterial = null; }
  beamMaterial = null;
  uprightMesh = null;
  if (beamGeometry) { beamGeometry.dispose(); beamGeometry = null; }
  beamMesh = null;
  if (guideGeometry) { guideGeometry.dispose(); guideGeometry = null; }
  if (guideMaterial) { guideMaterial.dispose(); guideMaterial = null; }
  guideMesh = null;
  hudEl = null;
  if (floorGeometry) { floorGeometry.dispose(); floorGeometry = null; }
  if (floorMaterial) { floorMaterial.dispose(); floorMaterial = null; }
  floorMesh = null;
  if (highlightGeometry) { highlightGeometry.dispose(); highlightGeometry = null; }
  if (hoverHighlightMaterial) { hoverHighlightMaterial.dispose(); hoverHighlightMaterial = null; }
  if (selectHighlightMaterial) { selectHighlightMaterial.dispose(); selectHighlightMaterial = null; }
  hoverHighlight = null; selectHighlight = null;
  for (const label of labelObjects.values()) { label.material.map.dispose(); label.material.dispose(); }
  labelObjects.clear();
  if (labelPlaneGeometry) { labelPlaneGeometry.dispose(); labelPlaneGeometry = null; }
  if (container) container.innerHTML = "";
  hideTooltip();
  renderer = null; scene = null; perspCamera = null; orthoCamera = null; activeCamera = null; container = null;
  dragging = false;
  instanceSlots = [];
  hoveredInstanceId = null;
  selectedInstanceId = null;
}

window.AsrsLocations3D = { render, dispose, resize: applyResize, setCameraMode, setAuditSide, panAuditStep };
