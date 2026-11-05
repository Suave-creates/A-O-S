// ASRS Locations - 100% READ-ONLY visual replica of the physical ASRS
// racking. Never calls PULL_QUADRON_TOTE, never touches Manual/Auto Tote
// Puller state.
//
// Fetches the full occupancy model ONCE per Run click (same "fetch full
// dataset, filter/render client-side" convention as nexsAsrsDump.js) - the
// backend (server/lib/asrsLocationModel.js) only ships the small occupied/
// anomaly lists, never the ~56,000 mostly-empty theoretical slots. This
// module recomputes that same small, deterministic structural math itself
// (levelsForAisle/levelBlocks/pillar+side) to lay out the grid and to
// enumerate empty slots for CSV export - kept in sync with
// server/lib/asrsLocationModel.js's own comment block; if the physical
// structure ever changes, both places need the same edit.
//
// Audit workflow (operator-confirmed): a physical audit walks ONE aisle and
// ONE "Level" at a time, where "Level" here is a FILTER-ONLY redefinition -
// every 5 consecutive physical shelf-heights between hard floors is one
// Level (Level 1 = shelf-heights 1-5, Level 2 = 6-10, ...; the last Level in
// an aisle may have only 4, matching levelBlocks()'s own top block). The
// underlying shelf-height numbers (1-24) are unchanged and still shown
// alongside the Level label - this redefinition only groups them for
// selection/rendering, it never changes what a location string means.
const AsrsLocations = (() => {
  const runBtn = document.getElementById("alRunBtn");
  const statusEl = document.getElementById("alStatus");
  const progressBar = document.getElementById("alProgressBar");
  const errBox = document.getElementById("alError");
  const resultsPanel = document.getElementById("alResultsPanel");
  const statusBar = document.getElementById("alStatusBar");
  const emptyEl = document.getElementById("alEmpty");
  const scopeNoteEl = document.getElementById("alScopeNote");
  const sumOccPctEl = document.getElementById("alSumOccPct");
  const sumEmptySubEl = document.getElementById("alSumEmptySub");

  const aisleButtonsEl = document.getElementById("alAisleButtons");
  const levelButtonsEl = document.getElementById("alLevelButtons");
  const csvScopeEl = document.getElementById("alCsvScope");
  const csvBtn = document.getElementById("alCsvBtn");

  const sumTotalEl = document.getElementById("alSumTotal");
  const sumOccupiedEl = document.getElementById("alSumOccupied");
  const sumEmptyEl = document.getElementById("alSumEmpty");
  const sumUnparsedEl = document.getElementById("alSumUnparsed");
  const sumDupEl = document.getElementById("alSumDup");

  const canvasWrapEl = document.getElementById("alCanvasWrap");
  const canvas = document.getElementById("alCanvas");
  const ctx = canvas.getContext("2d");
  const tooltip = document.getElementById("alTooltip");

  // 3D view - a separate ES module (asrsLocations3d.js, so it can `import`
  // Three.js via the page's importmap) exposing window.AsrsLocations3D.
  // This module owns the data (occupiedByKey/duplicateKeys/tooltipHtml);
  // the 3D module only ever receives small accessor callbacks, never raw
  // state, so there is exactly one place deciding what a slot's status is.
  const viewModeRadios = document.getElementsByName("alViewMode");
  const cameraModeRadios = document.getElementsByName("al3dCameraMode");
  const auditSideRadios = document.getElementsByName("al3dAuditSide");
  const auditSideWrapEl = document.getElementById("al3dAuditSideWrap");
  const auditPrevBtn = document.getElementById("al3dAuditPrevBtn");
  const auditNextBtn = document.getElementById("al3dAuditNextBtn");
  const wrap3dEl = document.getElementById("al3dWrap");
  const container3dEl = document.getElementById("al3dContainer");
  const fullscreen3dBtn = document.getElementById("al3dFullscreenBtn");
  const hint3dEl = document.getElementById("al3dHint");

  function viewMode() {
    for (const r of viewModeRadios) if (r.checked) return r.value;
    return "2d";
  }

  // 3D-only (redesigned 2026-09-09 - see asrsLocations3d.js's own header
  // comment for the full reasoning): "walkway" is the free-fly view
  // standing inside the aisle; "audit" faces one rack wall at a time via a
  // fixed orthographic camera - a VIEWPOINT choice only, never a different
  // rack layout.
  function cameraMode() {
    for (const r of cameraModeRadios) if (r.checked) return r.value;
    return "walkway";
  }
  function auditSide() {
    for (const r of auditSideRadios) if (r.checked) return r.value;
    return "left";
  }

  let _model = null; // last-fetched { generatedAt, occupiedSlots, aisles, unparsedLocations, duplicateSlots }
  let _occupiedByKey = new Map();
  let _duplicateKeys = new Set();
  let _selectedAisle = 1;
  let _selectedBlockIdx = 0; // index into levelBlocks(levelsForAisle(_selectedAisle))
  let _blockLayout = []; // [{level, top, leftLaneY, rightLaneY}] for the CURRENTLY drawn shelves, used by hit-testing

  // Bigger cells than a whole-aisle view could afford - a single Level block
  // is at most 5 shelf-heights (2,260 cells), not up to 24 (10,848), so
  // there's "proper space" to make each cell easy to see/click.
  const CELL = 18;
  const LEFT_PILLARS = 113; // pillar 0..112
  const RIGHT_PILLARS = 113; // pillar 1..113 - same count as left, so both lanes are the same pixel width

  // Each shelf is its own bordered block, laid out top-to-bottom exactly
  // like the operator's own sketch: Left Lane row, then Right Lane row -
  // not left/walkway/right side by side. One block per shelf, stacked
  // vertically, one block per Level block's worth of shelves (<=5).
  const BLOCK_PADDING = 10;
  const FB_LABEL_W = 26; // column for the "F"/"B" sub-row labels, before the pillar cells
  const SHELF_TITLE_H = 18;
  const LANE_LABEL_H = 14;
  const LANE_GAP = CELL; // plain, unlabeled gap between Left Lane and Right Lane - one cell's own size, no walkway band
  const BLOCK_GAP = 16; // vertical gap between one shelf's block and the next
  const LANE_ROWS_H = 2 * CELL; // front + back sub-rows

  const NUMBER_TO_AISLE_CODE = { 1: "004", 2: "005", 3: "006", 4: "007", 5: "008", 6: "009" };

  // ── The same pure structural math as server/lib/asrsLocationModel.js ──

  function levelsForAisle(aisle) {
    return aisle <= 4 ? 19 : 24;
  }
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
    return { side: position % 2 === 1 ? "left" : "right", pillar: Math.floor(position / 2) };
  }
  function slotKeyFor(aisle, level, pillar, side, depthCode) {
    return `${aisle}-${level}-${pillar}-${side === "left" ? "L" : "R"}-${depthCode}`;
  }
  // Inverse of sideAndPillar() - reconstructs the original position number
  // from pillar+side (odd position -> left, position = 2*pillar+1; even
  // position -> right, position = 2*pillar).
  function positionFor(pillar, side) {
    return side === "left" ? pillar * 2 + 1 : pillar * 2;
  }
  // Rebuilds the exact AAA-LL-1-PPP-1-DD location string for a slot, so the
  // tooltip shows the same code the source data (and the operator) uses,
  // not just the derived aisle/shelf/pillar breakdown.
  function locationStringFor(aisle, level, pillar, side, depthCode) {
    const position = positionFor(pillar, side);
    return `${NUMBER_TO_AISLE_CODE[aisle]}-${String(level).padStart(2, "0")}-1-${String(position).padStart(3, "0")}-1-${depthCode}`;
  }

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── Run ─────────────────────────────────────────────────────────────

  // The audit is one shared Grafana read on the server (topic
  // "asrs-locations.current", every 5 min while someone watches) - not one per
  // viewer. "Run" subscribes (an earlier viewer's result appears instantly)
  // and asks the server for a fresh read; the tab keeps following updates
  // while open. Nothing is fetched until the operator clicks Run once.
  let _off = null;
  let _ran = false;

  function applyResult(result) {
    _model = result;
    _occupiedByKey = new Map(result.occupiedSlots.map((s) => [s.slotKey, s]));
    _duplicateKeys = new Set(result.duplicateSlots.map((d) => d.slotKey));
    resultsPanel.classList.remove("hidden");
    emptyEl.hidden = true;
    statusBar.hidden = false;
    selectAisle(_selectedAisle);
    statusEl.textContent = `Live · updated ${Fmt.when(result.generatedAt)}`;
  }

  // A mark only re-draws the 2D grid (cheap); the 3D model is not rebuilt for it, only the tiles update.
  function onMarksChanged() {
    if (!_model) return;
    if (viewMode() === "2d") renderCurrent();
    else renderSummary(_selectedAisle, ...levelBlocks(levelsForAisle(_selectedAisle))[_selectedBlockIdx]);
  }

  function ensureSubscribed() {
    AsrsAuditMarks.start(onMarksChanged);
    if (_off) return;
    _off = Live.subscribe("asrs-locations.current", (evt) => {
      if (evt.type === "data") {
        errBox.classList.add("hidden");
        applyResult(evt.data);
        runBtn.disabled = false;
        progressBar.classList.add("hidden");
      } else if (evt.type === "feed-error") {
        errBox.textContent = evt.message;
        errBox.classList.remove("hidden");
        if (!_model) { statusEl.textContent = ""; statusBar.hidden = true; }
        runBtn.disabled = false;
        progressBar.classList.add("hidden");
      }
    });
  }

  function run() {
    errBox.classList.add("hidden");
    runBtn.disabled = true;
    statusBar.hidden = false;
    progressBar.classList.remove("hidden");
    statusEl.textContent = "Fetching every tote's location…";
    _ran = true;
    ensureSubscribed();
    Live.refresh("asrs-locations.current");
  }

  function start() {
    if (_ran) ensureSubscribed();
  }
  function stop() {
    if (_off) { _off(); _off = null; }
    AsrsAuditMarks.stop();
  }

  // ── Aisle / Level selectors ─────────────────────────────────────────

  function selectAisle(aisle) {
    _selectedAisle = aisle;
    _selectedBlockIdx = 0;
    renderAisleButtons();
    renderLevelButtons();
    renderCurrent();
  }

  function selectBlock(idx) {
    _selectedBlockIdx = idx;
    renderLevelButtons();
    renderCurrent();
  }

  function renderAisleButtons() {
    aisleButtonsEl.innerHTML = "";
    for (let aisle = 1; aisle <= 6; aisle++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = `Aisle ${aisle}`;
      btn.className = aisle === _selectedAisle ? "active" : "";
      btn.addEventListener("click", () => selectAisle(aisle));
      aisleButtonsEl.appendChild(btn);
    }
  }

  function renderLevelButtons() {
    const blocks = levelBlocks(levelsForAisle(_selectedAisle));
    levelButtonsEl.innerHTML = "";
    blocks.forEach(([lo, hi], idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = `Level ${idx + 1} · shelves ${lo}-${hi}`;
      btn.className = idx === _selectedBlockIdx ? "active" : "";
      btn.addEventListener("click", () => selectBlock(idx));
      levelButtonsEl.appendChild(btn);
    });
  }

  // ── Summary (scoped to the selected aisle + Level block) ────────────

  function renderSummary(aisle, lo, hi) {
    const total = (hi - lo + 1) * 226 * 2;
    let occupied = 0;
    for (const s of _model.occupiedSlots) {
      if (s.aisle === aisle && s.level >= lo && s.level <= hi) occupied++;
    }
    // Total / Occupied / Empty describe the selected aisle + level; the two anomaly counts are site-wide
    scopeNoteEl.innerHTML = `Aisle <b>${aisle}</b> · Level <b>${_selectedBlockIdx + 1}</b> · shelves ${lo}–${hi}`;
    sumOccPctEl.textContent = total ? `${((occupied / total) * 100).toFixed(1)}% of slots` : "";
    const empties = emptySlotKeys(aisle, lo, hi);
    const marked = empties.map((k) => AsrsAuditMarks.get(k)).filter(Boolean);
    const found = marked.filter((m) => m.outcome === "TOTE_FOUND").length;
    const left = empties.length - marked.length;
    sumEmptySubEl.textContent = marked.length ? `${Fmt.num(left)} left to audit · ${Fmt.num(marked.length - found)} confirmed · ${Fmt.num(found)} tote found` : "to audit physically";
    sumTotalEl.textContent = Fmt.num(total);
    sumOccupiedEl.textContent = Fmt.num(occupied);
    sumEmptyEl.textContent = Fmt.num(total - occupied);
    sumUnparsedEl.textContent = _model.unparsedLocations.length;
    sumDupEl.textContent = _model.duplicateSlots.length;
  }

  // ── Canvas drawing - ONE Level block (<=5 shelf-heights) at a time, one
  //    bordered box per shelf, Left Lane then Right Lane stacked top-to-
  //    bottom inside it, one plain cell-sized gap between them (the
  //    operator's own sketch) ─────────────────────────────────────────

  const gridW = LEFT_PILLARS * CELL; // == RIGHT_PILLARS * CELL, both lanes are the same width
  const blockContentW = FB_LABEL_W + gridW;
  const blockWidth = blockContentW + 2 * BLOCK_PADDING;
  const blockContentH = SHELF_TITLE_H + LANE_LABEL_H + LANE_ROWS_H + LANE_GAP + LANE_LABEL_H + LANE_ROWS_H;
  const blockHeight = blockContentH + 2 * BLOCK_PADDING;

  function drawLevelBlock(aisle, lo, hi) {
    const levels = [];
    for (let level = hi; level >= lo; level--) levels.push(level); // highest shelf at the top, matching the operator's own elevation diagram

    canvas.width = blockWidth;
    canvas.height = levels.length * blockHeight + (levels.length - 1) * BLOCK_GAP;

    const styles = getComputedStyle(document.documentElement);
    const palette = {
      empty: styles.getPropertyValue("--danger").trim() || "#ef5b5b",
      occupied: styles.getPropertyValue("--ok").trim() || "#46d98a",
      // Duplicates use --warn, not --danger - red is now reserved for the
      // empty-space marker, so a duplicate-slot anomaly must stay visually
      // distinct from "needs auditing".
      dup: styles.getPropertyValue("--warn").trim() || "#f3c34d",
      // today's audit of an empty slot: checked and empty (muted), or a tote was physically there (blue)
      audited: styles.getPropertyValue("--muted").trim() || "#8892a0",
      found: styles.getPropertyValue("--blue").trim() || "#2563eb",
      bg: styles.getPropertyValue("--panel").trim() || "#12181f",
      border: styles.getPropertyValue("--border").trim() || "#232b35",
      text: styles.getPropertyValue("--muted").trim() || "#8892a0",
    };

    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    _blockLayout = [];
    let top = 0;
    for (const level of levels) {
      const layout = drawShelfBlock(aisle, level, top, palette);
      _blockLayout.push(layout);
      top += blockHeight + BLOCK_GAP;
    }
  }

  // Draws one shelf's full block (border, title, Left Lane, a plain gap,
  // Right Lane) and returns its hit-testing geometry.
  function drawShelfBlock(aisle, level, top, palette) {
    ctx.strokeStyle = palette.border;
    ctx.strokeRect(0.5, top + 0.5, blockWidth - 1, blockHeight - 1);

    let y = top + BLOCK_PADDING;
    ctx.fillStyle = palette.text;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText(`Shelf ${level}`, BLOCK_PADDING, y);
    y += SHELF_TITLE_H;

    ctx.font = "10px sans-serif";
    ctx.fillText("Left Lane", BLOCK_PADDING, y);
    y += LANE_LABEL_H;
    const leftLaneY = y;
    drawLaneRows(aisle, level, "left", y, palette);
    y += LANE_ROWS_H + LANE_GAP; // plain gap, one cell's size, no walkway band

    ctx.font = "10px sans-serif";
    ctx.fillStyle = palette.text;
    ctx.fillText("Right Lane", BLOCK_PADDING, y);
    y += LANE_LABEL_H;
    const rightLaneY = y;
    drawLaneRows(aisle, level, "right", y, palette);

    return { level, top, leftLaneY, rightLaneY };
  }

  // One lane's two sub-rows (front/back), with "F"/"B" labels before the
  // pillar cells - the two independent physical slots at every pillar, made
  // explicit rather than left for hover alone to explain.
  function drawLaneRows(aisle, level, side, y, palette) {
    ctx.fillStyle = palette.text;
    ctx.font = "9px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("F", BLOCK_PADDING, y + CELL / 2);
    ctx.fillText("B", BLOCK_PADDING, y + CELL + CELL / 2);
    ctx.textBaseline = "alphabetic"; // restore canvas default for subsequent text draws elsewhere

    const gridX = BLOCK_PADDING + FB_LABEL_W;
    const pillarCount = side === "left" ? LEFT_PILLARS : RIGHT_PILLARS;
    for (let i = 0; i < pillarCount; i++) {
      const pillar = side === "left" ? i : i + 1;
      const x = gridX + i * CELL;
      drawCell(x, y, slotKeyFor(aisle, level, pillar, side, "01"), palette);
      drawCell(x, y + CELL, slotKeyFor(aisle, level, pillar, side, "02"), palette);
    }
  }

  // Empty slots are drawn as a solid red square, same weight as occupied's
  // green - that's the thing the audit team needs to go physically check,
  // so it should read at a glance, not just a faint background tint.
  function drawCell(x, y, slotKey, palette) {
    const size = CELL - 1;
    const mark = AsrsAuditMarks.get(slotKey);
    const color = _duplicateKeys.has(slotKey) ? palette.dup : _occupiedByKey.has(slotKey) ? palette.occupied
      : mark ? (mark.outcome === "TOTE_FOUND" ? palette.found : palette.audited) : palette.empty;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, size, size);
  }

  function renderCurrent() {
    const [lo, hi] = levelBlocks(levelsForAisle(_selectedAisle))[_selectedBlockIdx];
    renderSummary(_selectedAisle, lo, hi);

    if (viewMode() === "3d") {
      if (!window.AsrsLocations3D) {
        errBox.textContent = "3D view failed to load (asrsLocations3d.js) - falling back to the 2D grid.";
        errBox.classList.remove("hidden");
      } else {
        canvasWrapEl.classList.add("hidden");
        wrap3dEl.classList.remove("hidden");
        updateAuditSideVisibility();
        window.AsrsLocations3D.render({
          hudEl: document.getElementById("al3dHud"),
          containerEl: container3dEl,
          aisle: _selectedAisle, lo, hi,
          cameraMode: cameraMode(),
          auditSide: auditSide(),
          isOccupied: (slotKey) => _occupiedByKey.has(slotKey),
          isDuplicate: (slotKey) => _duplicateKeys.has(slotKey),
          tooltipHtml,
          tooltipEl: tooltip,
          locationLabel: (slot) => locationStringFor(slot.aisle, slot.level, slot.pillar, slot.side, slot.depthCode),
        });
        return;
      }
    }

    wrap3dEl.classList.add("hidden");
    canvasWrapEl.classList.remove("hidden");
    if (window.AsrsLocations3D) window.AsrsLocations3D.dispose(); // free the WebGL context when not in 3D view
    drawLevelBlock(_selectedAisle, lo, hi);
  }

  // ── Hover hit-testing (manual - canvas has no per-shape title) ─────

  function slotAtPoint(aisle, x, y) {
    const gridX = x - (BLOCK_PADDING + FB_LABEL_W);
    if (gridX < 0 || gridX >= gridW) return null; // border/padding/F-B-label margins

    const block = _blockLayout.find((b) => y >= b.top && y < b.top + blockHeight);
    if (!block) return null;

    let side, laneY;
    if (y >= block.leftLaneY && y < block.leftLaneY + LANE_ROWS_H) { side = "left"; laneY = block.leftLaneY; }
    else if (y >= block.rightLaneY && y < block.rightLaneY + LANE_ROWS_H) { side = "right"; laneY = block.rightLaneY; }
    else return null; // title / lane label / the plain gap between lanes

    const depthCode = y - laneY < CELL ? "01" : "02";
    const i = Math.floor(gridX / CELL);
    const pillarCount = side === "left" ? LEFT_PILLARS : RIGHT_PILLARS;
    if (i >= pillarCount) return null;
    const pillar = side === "left" ? i : i + 1;

    return { aisle, level: block.level, pillar, side, depthCode, depth: depthCode === "01" ? "front" : "back" };
  }

  function tooltipHtml(slot) {
    const slotKey = slotKeyFor(slot.aisle, slot.level, slot.pillar, slot.side, slot.depthCode);
    const occ = _occupiedByKey.get(slotKey);
    const location = locationStringFor(slot.aisle, slot.level, slot.pillar, slot.side, slot.depthCode);
    const header =
      `<div style="font-weight:700; font-family:var(--mono, monospace);">${escHtml(location)}</div>` +
      `<div class="note">Aisle ${slot.aisle} · Shelf ${slot.level} · Pillar ${slot.pillar} (${slot.side}) · ${slot.depth}</div>`;
    if (!occ) {
      const m = AsrsAuditMarks.get(slotKey);
      const audit = m ? `${m.outcome === "TOTE_FOUND" ? "Tote found" : "Confirmed empty"}${m.toteId ? " · " + escHtml(m.toteId) : ""} · by ${escHtml(m.markedBy || "-")} at ${Fmt.time(m.markedAt)}` : "Not audited yet - click to record what you found";
      return `${header}<div style="margin-top:0.3rem;">Empty</div><div class="note">${audit}</div>`;
    }
    const dup = _duplicateKeys.has(slotKey);
    return (
      header +
      `<div style="font-weight:600; margin-top:0.3rem;">${escHtml(occ.container)}</div>` +
      `<div class="note">Tracker ${escHtml(occ.tracker) || "—"} · ${escHtml(occ.zone) || "—"} · ${escHtml(occ.shuttle) || "—"}</div>` +
      (dup ? `<div style="color:var(--warn); margin-top:0.2rem;">Duplicate slot - see the anomaly count above</div>` : "")
    );
  }

  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const slot = slotAtPoint(_selectedAisle, x, y);
    if (!slot) {
      tooltip.classList.add("hidden");
      return;
    }
    tooltip.innerHTML = tooltipHtml(slot);
    tooltip.style.left = e.clientX + 14 + "px";
    tooltip.style.top = e.clientY + 14 + "px";
    tooltip.classList.remove("hidden");
  });
  canvas.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));
  // Clicking an empty slot records the physical audit (occupied slots carry no mark).
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const slot = slotAtPoint(_selectedAisle, (e.clientX - rect.left) * (canvas.width / rect.width), (e.clientY - rect.top) * (canvas.height / rect.height));
    if (!slot) return;
    const slotKey = slotKeyFor(slot.aisle, slot.level, slot.pillar, slot.side, slot.depthCode);
    if (_occupiedByKey.has(slotKey)) return;
    tooltip.classList.add("hidden");
    AsrsAuditMarks.openMenu({ slotKey, location: locationStringFor(slot.aisle, slot.level, slot.pillar, slot.side, slot.depthCode), x: e.clientX, y: e.clientY });
  });

  // The empty slots of one aisle's shelves lo..hi (the Empty tile's audit progress counts these).
  function emptySlotKeys(aisle, lo, hi) {
    const keys = [];
    for (let level = lo; level <= hi; level++) {
      for (let position = 1; position <= 226; position++) {
        const { side, pillar } = sideAndPillar(position);
        for (const depthCode of ["01", "02"]) {
          const k = slotKeyFor(aisle, level, pillar, side, depthCode);
          if (!_occupiedByKey.has(k)) keys.push(k);
        }
      }
    }
    return keys;
  }


  // ── Empty-locations CSV export (the audit checklist) ────────────────

  function enumerateEmptySlots(scope) {
    const aisles = scope === "all" ? [1, 2, 3, 4, 5, 6] : [_selectedAisle];
    const rows = [];
    for (const aisle of aisles) {
      let [lo, hi] = [1, levelsForAisle(aisle)];
      if (scope === "level" && aisle === _selectedAisle) {
        [lo, hi] = levelBlocks(levelsForAisle(_selectedAisle))[_selectedBlockIdx];
      }
      for (let level = lo; level <= hi; level++) {
        for (let position = 1; position <= 226; position++) {
          const { side, pillar } = sideAndPillar(position);
          for (const depthCode of ["01", "02"]) {
            const slotKey = slotKeyFor(aisle, level, pillar, side, depthCode);
            if (!_occupiedByKey.has(slotKey)) {
              // The real physical location code (e.g. "007-06-1-217-1-02") -
              // same locationStringFor() the tooltip already uses, so an
              // operator doing a physical audit sees the exact code they'd
              // scan/write down, not just its decomposed aisle/pillar/side/
              // depth pieces (those are still derivable FROM this string,
              // never a second, differently-formatted source of truth).
              rows.push({ aisle, level, location: locationStringFor(aisle, level, pillar, side, depthCode), mark: AsrsAuditMarks.get(slotKey) });
            }
          }
        }
      }
    }
    return rows;
  }

  function exportCsv() {
    if (!_model) return;
    const rows = enumerateEmptySlots(csvScopeEl.value);
    rows.sort((a, b) => a.aisle - b.aisle || a.level - b.level || a.location.localeCompare(b.location));

    const lines = [["Aisle", "Level", "Location", "Audit today", "Tote found", "Audited by"].join(",")];
    const audit = (m) => (!m ? "" : m.outcome === "TOTE_FOUND" ? "Tote found" : "Confirmed empty");
    const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    rows.forEach((r) => lines.push([r.aisle, r.level, r.location, audit(r.mark), (r.mark && r.mark.toteId) || "", (r.mark && r.mark.markedBy) || ""].map(cell).join(",")));

    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `asrs-empty-locations-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  // Audit mode's Left/Right selector only makes sense once Audit is
  // actually selected - hidden otherwise. Purely a display toggle, never
  // touches the 3D scene itself.
  function updateAuditSideVisibility() {
    auditSideWrapEl.classList.toggle("hidden", cameraMode() !== "audit");
  }
  function updateHint3d() {
    hint3dEl.textContent =
      cameraMode() === "audit"
        ? "Drag or use the arrows to pan along the wall · scroll to zoom · hover a slot for its location, click to pin it. Switch walls to audit the other rack."
        : "Drag to look around · scroll to move down the aisle · hover a slot for its location, click to pin it.";
  }

  runBtn.addEventListener("click", run);
  csvBtn.addEventListener("click", exportCsv);
  // Switching 2D/3D after data is already loaded re-renders locally from the
  // cached model - no need to force a re-fetch just to change view mode.
  for (const r of viewModeRadios) r.addEventListener("change", () => { if (_model) renderCurrent(); });
  // Camera mode / audit side changes are camera-only (see
  // asrsLocations3d.js's setCameraMode/setAuditSide) - they never rebuild
  // the rack/location scene, so a 3D model already on screen is updated in
  // place rather than re-running the full renderCurrent() pipeline.
  for (const r of cameraModeRadios) {
    r.addEventListener("change", () => {
      updateAuditSideVisibility();
      updateHint3d();
      if (!_model) return;
      if (viewMode() === "3d" && window.AsrsLocations3D) window.AsrsLocations3D.setCameraMode(cameraMode());
      else renderCurrent();
    });
  }
  for (const r of auditSideRadios) {
    r.addEventListener("change", () => {
      if (_model && viewMode() === "3d" && window.AsrsLocations3D) window.AsrsLocations3D.setAuditSide(auditSide());
    });
  }
  // Left/right arrow-button navigation (Audit mode only, operator-requested
  // 2026-09-10 - dragging across the full rack length at Audit's tighter fit
  // zoom was impractically slow). Pure camera pan, same as a drag - never
  // touches the rack/location scene.
  auditPrevBtn.addEventListener("click", () => {
    if (_model && viewMode() === "3d" && window.AsrsLocations3D) window.AsrsLocations3D.panAuditStep("left");
  });
  auditNextBtn.addEventListener("click", () => {
    if (_model && viewMode() === "3d" && window.AsrsLocations3D) window.AsrsLocations3D.panAuditStep("right");
  });
  updateAuditSideVisibility();
  updateHint3d();

  // Fullscreen the whole 3D panel (button + canvas + instructions), not just
  // the canvas - more pixels to make the near/mid pillars readable before
  // they converge toward the vanishing point, AND it keeps the Fullscreen/
  // Exit button reachable from inside fullscreen itself (fullscreening just
  // the canvas left the button - outside that subtree - with no way to exit
  // except Escape). The 3D module's own ResizeObserver already reacts to
  // the container's size changing, so entering/exiting fullscreen resizes
  // the renderer/camera automatically - nothing else to wire for that.
  //
  // The tooltip is reparented into al3dWrap for the duration of fullscreen
  // and back out again on exit: the Fullscreen API only paints the
  // fullscreen element and its own descendants, so left in its normal,
  // page-level position it would simply never render while fullscreen is
  // active - the raycast/hover logic would keep working, just invisibly.
  const tooltipHomeParent = tooltip.parentNode;
  const tooltipHomeNextSibling = tooltip.nextSibling;

  fullscreen3dBtn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      wrap3dEl.requestFullscreen().catch((e) => {
        errBox.textContent = "Fullscreen failed: " + e.message;
        errBox.classList.remove("hidden");
      });
    }
  });
  document.addEventListener("fullscreenchange", () => {
    const isFull = document.fullscreenElement === wrap3dEl;
    fullscreen3dBtn.innerHTML = '<i class="ico" data-i="maximize"></i>' + (isFull ? "Exit fullscreen" : "Fullscreen");
    if (isFull) {
      wrap3dEl.appendChild(tooltip);
    } else if (tooltip.parentNode !== tooltipHomeParent) {
      tooltipHomeParent.insertBefore(tooltip, tooltipHomeNextSibling);
    }
    // Force the 3D renderer/camera to match the new box size explicitly -
    // its own ResizeObserver did NOT reliably fire for this exact
    // transition in testing (the canvas stayed stuck at its pre-fullscreen
    // size), which is what showed up as "flickering, showing nothing".
    // Double rAF: wait a full layout/paint cycle so al3dContainer's
    // clientWidth/Height already reflect the settled fullscreen box before
    // reading them, not a mid-transition value.
    if (window.AsrsLocations3D) {
      requestAnimationFrame(() => requestAnimationFrame(() => window.AsrsLocations3D.resize()));
    }
  });

  return { tooltipHtml, start, stop };
})();
