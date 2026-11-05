// ui/components/multizone.js — Multi-Zone Configuration (renders in both Manual + Auto tabs)

const MultiZone = (() => {
  // ── Shared state ────────────────────────────────────────────────────────────
  let _zones   = [];
  let _enabled = false;
  const STORAGE_KEY = "qtp_multizone";

  // ── All mounted panels (one per tab) ────────────────────────────────────────
  const _panels = [];

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function generateId() {
    return "z_" + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
  }
  function getTotal() {
    return _zones.filter(z => z.enabled !== false).reduce((s,z) => s + (Number(z.percentage)||0), 0);
  }

  // ── State operations ──────────────────────────────────────────────────────────
  function addZone(zone, instanceCode, percentage) {
    _zones.push({ id:generateId(), zone:String(zone||""), instanceCode:instanceCode||"LK-069", percentage:Math.max(0,percentage||0) });
    save(); renderAll();
  }
  function removeZone(id) {
    _zones = _zones.filter(z => z.id !== id);
    save(); renderAll();
  }
  function updateZoneField(id, field, value) {
    const z = _zones.find(z => z.id === id);
    if (!z) return;
    z[field] = field === "percentage" ? Math.max(0, Math.min(100, parseFloat(value)||0)) : value;
    save(); renderAll();
  }
  function setEnabled(val) {
    _enabled = val;
    save(); renderAll();
  }

  // ── Persistence ───────────────────────────────────────────────────────────────
  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled:_enabled, zones:_zones }));
  }
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORAGE_KEY)||"{}");
      _enabled = !!d.enabled;
      _zones   = Array.isArray(d.zones) ? d.zones : [];
    } catch(e) { _enabled = false; _zones = []; }
  }

  // ── Render a single panel into its container ──────────────────────────────────
  function renderPanel(panel) {
    const { container } = panel;
    const total = getTotal();

    // Total status
    let totalCls = "mz-warn", totalStatus = `${100-total}% unassigned`;
    if (total === 100) { totalCls = "mz-ok";  totalStatus = "✓ Ready"; }
    if (total > 100)   { totalCls = "mz-err"; totalStatus = "⚠ Exceeds 100%"; }

    // Zone rows
    let rowsHtml = "";
    if (!_zones.length) {
      rowsHtml = '<div class="mz-empty">No zones added yet. Click + Add Zone to start.</div>';
    } else {
      _zones.forEach((z, i) => {
        const pct = Math.min(100, z.percentage||0);
        rowsHtml += `<div class="mz-zone-row" data-id="${z.id}">
          <div class="mz-zone-num">
            <span class="mz-zone-label">Zone ${i+1}</span>
            <input class="mz-input mz-zone-field" type="text" inputmode="numeric" placeholder="e.g. 5"
              value="${esc(z.zone)}" data-field="zone" data-id="${z.id}" />
          </div>
          <div class="mz-zone-ic">
            <input class="mz-input" type="text" placeholder="LK-069"
              value="${esc(z.instanceCode)}" data-field="instanceCode" data-id="${z.id}" />
          </div>
          <div class="mz-zone-pct">
            <input class="mz-input mz-pct-input" type="number" min="0" max="100" step="1"
              value="${z.percentage}" data-field="percentage" data-id="${z.id}" />
            <span class="mz-pct-symbol">%</span>
          </div>
          <div class="mz-zone-bar"><div class="mz-bar-fill" style="width:${pct}%"></div></div>
          <button class="mz-delete-btn" data-id="${z.id}" title="Remove">✕</button>
        </div>`;
      });
    }

    container.innerHTML = `
      <div class="mz-section">
        <div class="mz-header">
          <label class="mz-toggle-label">
            <input type="checkbox" class="mz-checkbox mz-enabled-toggle" ${_enabled?"checked":""} />
            <span class="mz-toggle-text">Enable Multi-Zone Calling</span>
          </label>
          <span class="mz-hint">Distribute totes across zones by %</span>
        </div>
        <div class="mz-panel-body" style="display:${_enabled?"":"none"}">
          <div class="mz-zones-list">${rowsHtml}</div>
          <div class="mz-footer">
            <button class="btn ghost subtle small-btn mz-add-btn">+ Add Zone</button>
            <div class="mz-total-row">
              <span class="mz-total-label">Total:</span>
              <span class="mz-total-val ${totalCls}">${total}%</span>
              <span class="mz-total-status ${totalCls}">${totalStatus}</span>
            </div>
          </div>
        </div>
      </div>`;

    // Wire events
    container.querySelector(".mz-enabled-toggle").addEventListener("change", e => {
      setEnabled(e.target.checked);
    });
    container.querySelector(".mz-add-btn")?.addEventListener("click", () => {
      const rem = Math.max(0, 100 - getTotal());
      addZone("", "LK-069", rem);
    });
    container.querySelectorAll(".mz-input").forEach(inp => {
      inp.addEventListener("input", e => {
        updateZoneField(e.target.dataset.id, e.target.dataset.field, e.target.value);
      });
    });
    container.querySelectorAll(".mz-delete-btn").forEach(btn => {
      btn.addEventListener("click", e => removeZone(e.target.dataset.id));
    });
  }

  // ── Render all registered panels ─────────────────────────────────────────────
  function renderAll() {
    _panels.forEach(p => renderPanel(p));
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  function mount(containerEl) {
    if (!containerEl) return;
    const panel = { container: containerEl };
    _panels.push(panel);
    renderPanel(panel);
  }

  function validate() {
    if (!_enabled) return { ok: true };
    if (!_zones.length)        return { ok:false, reason:"Add at least one zone." };
    if (_zones.some(z=>!z.zone)) return { ok:false, reason:"All zones need a zone number." };
    const t = getTotal();
    if (t > 100) return { ok:false, reason:`Total is ${t}% — cannot exceed 100%.` };
    if (t < 100) return { ok:false, reason:`Total is ${t}% — must equal 100%.` };
    return { ok: true };
  }

  function getZoneConfig() {
    if (!_enabled || !_zones.length) return { multiZone:false, zone:"", instanceCode:"LK-069", zones:[] };
    const active = _zones.filter(z => z.zone && z.percentage > 0);
    return { multiZone:true, zone:active[0]?.zone||"", instanceCode:active[0]?.instanceCode||"LK-069", zones:active };
  }

  function init() { load(); } // called once on startup — mount() registers panels

  return { init, mount, validate, getZoneConfig, isEnabled:()=>_enabled, getTotal };
})();
