// ui/components/utilisation.js
// Tote Utilisation tab — client-side port of the GAS generateToteUtilisation().
// Reads the ASRS dump (via the Apps Script bridge in the background SW), derives
// tote type + product type, flags mixed totes, and renders a configurable-capacity
// utilisation dashboard. All compute runs in the background (TOTE_UTILISATION).

const UtilisationPanel = (() => {
  const $ = id => document.getElementById(id);

  // Capacities persist locally so operators don't re-enter them each run.
  const CAP_KEY = "asrs_util_caps";
  const SRC_KEY = "asrs_util_source";   // "sheet_dump" | "quadron_api"
  const DEFAULT_CAPS = { largeLens: 300, largeFrame: 240, smallLens: 200, smallFrame: 200 };
  const DEFAULT_SOURCE = "sheet_dump";

  function loadSource() {
    const s = localStorage.getItem(SRC_KEY);
    return (s === "quadron_api" || s === "sheet_dump") ? s : DEFAULT_SOURCE;
  }
  function saveSource(s) { try { localStorage.setItem(SRC_KEY, s); } catch (e) {} }
  function readSourceFromUI() {
    return $("utilSrcQuadron")?.checked ? "quadron_api" : "sheet_dump";
  }

  const CATS = [
    { key: "largeLens",  label: "Large Tote · Lens",   capId: "capLargeLens"  },
    { key: "largeFrame", label: "Large Tote · Frames", capId: "capLargeFrame" },
    { key: "smallLens",  label: "Small Tote · Lens",   capId: "capSmallLens"  },
    { key: "smallFrame", label: "Small Tote · Frames", capId: "capSmallFrame" }
  ];

  let _result = null;
  let _running = false;

  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const nf  = n => Number(n || 0).toLocaleString();
  const pct = u => (u == null ? "—" : (u * 100).toFixed(2) + "%");

  // Utilisation → colour band. Under-filled is the operational problem worth
  // flagging (wasted slots), so low fill reads red, healthy mid-range reads green.
  function utilColour(u) {
    if (u == null) return "var(--muted)";
    if (u >= 0.85) return "var(--yellow)";   // near-full — watch capacity
    if (u >= 0.50) return "var(--green)";    // healthy
    if (u >= 0.25) return "var(--accent)";   // low
    return "var(--red)";                      // very low — wasted space
  }

  function loadCaps() {
    try { return { ...DEFAULT_CAPS, ...(JSON.parse(localStorage.getItem(CAP_KEY)) || {}) }; }
    catch (e) { return { ...DEFAULT_CAPS }; }
  }
  function readCapsFromUI() {
    const c = {};
    CATS.forEach(cat => { c[cat.key] = Math.max(1, parseInt($(cat.capId).value, 10) || DEFAULT_CAPS[cat.key]); });
    return c;
  }
  function saveCaps(c) { try { localStorage.setItem(CAP_KEY, JSON.stringify(c)); } catch (e) {} }

  function render(container) {
    const caps = loadCaps();
    const src = loadSource();
    container.innerHTML = `
      <style>
        #tab-utilisation .util-cap-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
        #tab-utilisation .util-runrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
        #tab-utilisation .util-status{color:var(--muted);font-size:12px;font-family:var(--mono)}
        #tab-utilisation .util-empty{color:var(--muted);font-family:var(--mono);font-size:12px;text-align:center;padding:34px 16px}

        /* ── Source toggle (mirrors Auto tab) ── */
        #tab-utilisation .util-src-row{display:flex;align-items:flex-start;gap:14px;padding:0 0 14px;margin-bottom:14px;border-bottom:1px solid var(--border-soft)}
        #tab-utilisation .util-src-label{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;white-space:nowrap;padding-top:3px;min-width:96px}
        #tab-utilisation .util-src-opts{display:flex;gap:10px;flex-wrap:wrap;flex:1}
        #tab-utilisation .util-opt{display:flex;flex-direction:column;gap:1px;padding:9px 13px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--bg-2);cursor:pointer;flex:1;min-width:180px;transition:border-color .15s,background .15s}
        #tab-utilisation .util-opt:hover{border-color:var(--muted-dim)}
        #tab-utilisation .util-opt input{position:absolute;opacity:0;pointer-events:none}
        #tab-utilisation .util-opt:has(input:checked){border-color:var(--signal);background:rgba(54,214,207,.06)}
        #tab-utilisation .util-opt-name{font-size:12.5px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:7px}
        #tab-utilisation .util-opt:has(input:checked) .util-opt-name::before{content:"●";color:var(--signal);font-size:9px}
        #tab-utilisation .util-opt:not(:has(input:checked)) .util-opt-name::before{content:"○";color:var(--muted-dim);font-size:9px}
        #tab-utilisation .util-opt-hint{font-size:10px;color:var(--muted);font-family:var(--mono);padding-left:16px}

        /* ── Hero ── */
        #tab-utilisation .util-hero-card{position:relative;overflow:hidden}
        #tab-utilisation .util-hero-card::before{content:"";position:absolute;inset:0;
          background:radial-gradient(420px 220px at 14% -20%, rgba(54,214,207,.10), transparent 60%);pointer-events:none}
        #tab-utilisation .util-hero{display:flex;gap:26px;align-items:center;flex-wrap:wrap;position:relative}
        #tab-utilisation .util-gauge{position:relative;width:160px;height:160px;flex-shrink:0}
        #tab-utilisation .util-gauge svg{transform:rotate(-90deg);display:block;filter:drop-shadow(0 0 10px var(--util-glow,rgba(54,214,207,.0)))}
        #tab-utilisation .util-gauge .g-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px}
        #tab-utilisation .util-gauge .g-pct{font-family:var(--mono);font-size:30px;font-weight:700;color:var(--text);line-height:1;letter-spacing:-.02em}
        #tab-utilisation .util-gauge .g-lbl{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
        #tab-utilisation .util-hero-stats{display:grid;grid-template-columns:repeat(2,auto);gap:18px 34px;flex:1}
        #tab-utilisation .hs{display:flex;flex-direction:column;gap:4px;border-left:2px solid var(--border);padding-left:13px}
        #tab-utilisation .hs-v{font-family:var(--mono);font-size:23px;font-weight:700;color:var(--text);line-height:1}
        #tab-utilisation .hs-v.teal{color:var(--signal)}
        #tab-utilisation .hs-l{font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}

        /* ── Pipeline strip ── */
        #tab-utilisation .util-pipe{display:flex;align-items:stretch;gap:0;flex-wrap:wrap;margin-top:4px}
        #tab-utilisation .pipe-step{display:flex;flex-direction:column;gap:3px;padding:0 18px;position:relative;justify-content:center}
        #tab-utilisation .pipe-step:not(:last-child)::after{content:"→";position:absolute;right:-7px;top:50%;transform:translateY(-50%);color:var(--muted-dim);font-size:13px}
        #tab-utilisation .pipe-step:first-child{padding-left:0}
        #tab-utilisation .pipe-v{font-family:var(--mono);font-size:18px;font-weight:700;color:var(--text);line-height:1}
        #tab-utilisation .pipe-v.drop{color:var(--net-err)}
        #tab-utilisation .pipe-v.good{color:var(--signal)}
        #tab-utilisation .pipe-l{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}

        /* ── Category cards ── */
        #tab-utilisation .util-cats{display:flex;flex-direction:column;gap:14px}
        #tab-utilisation .uc{display:grid;grid-template-columns:178px 1fr 84px;gap:14px;align-items:center}
        #tab-utilisation .uc-head{display:flex;flex-direction:column;gap:4px}
        #tab-utilisation .uc-name{font-size:12.5px;color:var(--text);font-weight:600;display:flex;align-items:center;gap:7px}
        #tab-utilisation .uc-chip{font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:var(--r-pill);background:var(--surface-3);color:var(--muted)}
        #tab-utilisation .uc-sub{font-size:10px;color:var(--muted);font-family:var(--mono)}
        #tab-utilisation .uc-track{height:26px;background:var(--bg-2);border-radius:7px;overflow:hidden;position:relative;box-shadow:inset 0 1px 3px rgba(0,0,0,.55)}
        #tab-utilisation .uc-fill{height:100%;border-radius:7px 0 0 7px;transition:width .6s cubic-bezier(.34,1.2,.64,1);min-width:3px}
        #tab-utilisation .uc-qty{position:absolute;top:0;right:9px;height:100%;display:flex;align-items:center;font-family:var(--mono);font-size:11px;color:var(--muted)}
        #tab-utilisation .uc-pct{font-family:var(--mono);font-size:17px;font-weight:700;text-align:right;letter-spacing:-.02em}

        /* ── Distribution ── */
        #tab-utilisation .util-dist{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;align-items:end;height:140px;padding-top:4px}
        #tab-utilisation .db{display:flex;flex-direction:column;align-items:center;gap:7px;height:100%;justify-content:flex-end}
        #tab-utilisation .db-bar{width:100%;max-width:52px;background:linear-gradient(180deg,var(--signal),var(--signal-dim));border-radius:6px 6px 0 0;transition:height .6s cubic-bezier(.34,1.2,.64,1);min-height:4px;box-shadow:0 0 14px -4px var(--signal)}
        #tab-utilisation .db-v{font-family:var(--mono);font-size:13px;font-weight:700;color:var(--text)}
        #tab-utilisation .db-l{font-size:10px;color:var(--muted);text-align:center;line-height:1.3}

        /* ── Mixed alert ── */
        #tab-utilisation .util-mixed{display:flex;align-items:flex-start;gap:11px;padding:12px 15px;border-radius:var(--r-sm);font-size:12.5px;line-height:1.5}
        #tab-utilisation .util-mixed .mx-icon{font-size:15px;line-height:1.2}
        #tab-utilisation .util-mixed.warn{background:rgba(243,195,77,.09);border:1px solid rgba(243,195,77,.32);color:var(--yellow)}
        #tab-utilisation .util-mixed.ok{background:rgba(70,217,138,.07);border:1px solid rgba(70,217,138,.28);color:var(--green)}
        #tab-utilisation .util-mixed .mx-ids{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:4px}

        /* ── Shared ── */
        #tab-utilisation .util-section-h{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;font-weight:600;margin:0 0 14px;display:flex;align-items:center;gap:8px}
        #tab-utilisation .util-section-h .sh-tag{font-family:var(--mono);font-size:10px;color:var(--muted-dim);text-transform:none;letter-spacing:0}
        #tab-utilisation .util-detail-wrap{overflow:auto;max-height:50vh;border:1px solid var(--border);border-radius:10px}
        #tab-utilisation table.util-table{border-collapse:collapse;width:100%;font-size:12px;white-space:nowrap}
        #tab-utilisation table.util-table th,#tab-utilisation table.util-table td{padding:8px 12px;border-bottom:1px solid var(--border-soft);text-align:left}
        #tab-utilisation table.util-table thead th{position:sticky;top:0;background:var(--surface-2);color:var(--muted);font-weight:600;z-index:1;letter-spacing:.04em;text-transform:uppercase;font-size:10px}
        #tab-utilisation table.util-table tbody tr:hover{background:rgba(255,255,255,.025)}
        #tab-utilisation table.util-table td.num{font-family:var(--mono);text-align:right}
        #tab-utilisation .ptype-tag{font-size:10px;font-weight:600;padding:1px 7px;border-radius:var(--r-pill)}
        #tab-utilisation .ptype-tag.large{background:rgba(90,169,255,.14);color:var(--blue)}
        #tab-utilisation .ptype-tag.small{background:rgba(147,162,183,.14);color:var(--muted)}
        #tab-utilisation .util-fresh{font-size:10.5px;color:var(--muted-dim);font-family:var(--mono)}
      </style>

      <!-- Config: capacities + run -->
      <div class="card">
        <div class="card-title">📦 Tote Utilisation</div>
        <p class="purge-sub" style="margin-bottom:14px">Counts <strong>only real TL / TS storage totes</strong> — decant, buffer and other locations are excluded. Each tote is classified by size and contents (Frame / Lens), mixed totes are flagged, and fill is measured against the capacities below. Read-only.</p>

        <div class="util-src-row">
          <span class="util-src-label">Data Source</span>
          <div class="util-src-opts">
            <label class="util-opt">
              <input type="radio" name="utilSource" id="utilSrcSheet" value="sheet_dump" ${src === "sheet_dump" ? "checked" : ""} />
              <span class="util-opt-name">Sheet Dump</span>
              <span class="util-opt-hint">ASRS export pasted in Google Sheets</span>
            </label>
            <label class="util-opt">
              <input type="radio" name="utilSource" id="utilSrcQuadron" value="quadron_api" ${src === "quadron_api" ? "checked" : ""} />
              <span class="util-opt-name">Quadron API</span>
              <span class="util-opt-hint">live inventory — no sheet paste needed</span>
            </label>
          </div>
        </div>

        <div class="util-cap-grid">
          <label class="field"><span class="label">Large · Lens cap</span><input id="capLargeLens" type="number" min="1" value="${caps.largeLens}" /></label>
          <label class="field"><span class="label">Large · Frame cap</span><input id="capLargeFrame" type="number" min="1" value="${caps.largeFrame}" /></label>
          <label class="field"><span class="label">Small · Lens cap</span><input id="capSmallLens" type="number" min="1" value="${caps.smallLens}" /></label>
          <label class="field"><span class="label">Small · Frame cap</span><input id="capSmallFrame" type="number" min="1" value="${caps.smallFrame}" /></label>
        </div>
        <div class="util-runrow">
          <button id="utilRunBtn" class="btn primary">▶ Run</button>
          <button id="utilCsvBtn" class="btn ghost subtle" disabled>⬇ Export CSV</button>
          <button id="utilResetBtn" class="btn ghost subtle">↺ Reset caps</button>
          <span class="util-status" id="utilStatus"></span>
        </div>
      </div>

      <!-- Dashboard mount -->
      <div id="utilDashboard"></div>
    `;
  }

  function gaugeSvg(u) {
    const R = 68, c = 2 * Math.PI * R, frac = Math.max(0, Math.min(1, u || 0));
    const dash = (frac * c).toFixed(1), gap = (c - frac * c).toFixed(1);
    const col = utilColour(u);
    const gid = "ug" + Math.random().toString(36).slice(2, 7);
    return `<svg width="160" height="160" viewBox="0 0 160 160">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${col}" stop-opacity="0.65"/>
          <stop offset="100%" stop-color="${col}"/>
        </linearGradient>
      </defs>
      <circle cx="80" cy="80" r="${R}" fill="none" stroke="var(--bg-2)" stroke-width="13"/>
      <circle cx="80" cy="80" r="${R}" fill="none" stroke="url(#${gid})" stroke-width="13"
        stroke-linecap="round" stroke-dasharray="${dash} ${gap}"/>
    </svg>`;
  }

  function renderDashboard() {
    const mount = $("utilDashboard");
    if (!mount) return;
    if (!_result) { mount.innerHTML = `<div class="card"><div class="util-empty">No data yet. Set capacities and hit Run.</div></div>`; return; }

    const r = _result, t = r.totals;
    const p = r.pipeline || { scanned: 0, excludedNonTote: 0, mixed: r.mixedCount, counted: t.totes };
    const heroGlow = utilColour(t.util).startsWith("var") ? "rgba(54,214,207,.25)" : utilColour(t.util);

    // Category cards
    const catRows = CATS.map(cat => {
      const s = r.stats[cat.key]; const u = s.util || 0; const col = utilColour(u);
      const sizeChip = cat.key.startsWith("large") ? "Large" : "Small";
      const chipCls = cat.key.startsWith("large") ? "large" : "small";
      return `<div class="uc">
        <div class="uc-head">
          <div class="uc-name"><span class="ptype-tag ${chipCls}">${sizeChip}</span>${esc(cat.label.split("·")[1].trim())}</div>
          <div class="uc-sub">${nf(s.totes)} totes · ${s.capPer} cap/tote</div>
        </div>
        <div class="uc-track">
          <div class="uc-fill" style="width:${(Math.min(1,u)*100).toFixed(1)}%;background:linear-gradient(90deg,${col},${col})"></div>
          <div class="uc-qty">${nf(s.qty)} / ${nf(s.cap)}</div>
        </div>
        <div class="uc-pct" style="color:${col}">${pct(u)}</div>
      </div>`;
    }).join("");

    // Distribution
    const distMax = Math.max(1, ...[1,2,3,4,5].map(k => r.distribution[k]));
    const distBars = [1,2,3,4,5].map(k => {
      const v = r.distribution[k]; const h = (v / distMax) * 100;
      return `<div class="db">
        <div class="db-v">${nf(v)}</div>
        <div class="db-bar" style="height:${h.toFixed(1)}%"></div>
        <div class="db-l">${k} ${k === 1 ? "item" : "items"}</div>
      </div>`;
    }).join("");

    // Mixed alert
    const mixedHtml = r.mixedCount > 0
      ? `<div class="util-mixed warn">
           <span class="mx-icon">⚠</span>
           <div><strong>${nf(r.mixedCount)} mixed tote${r.mixedCount === 1 ? "" : "s"}</strong> — holding Frame + Lens together. Excluded from utilisation as a data-integrity exception.
             <div class="mx-ids">${r.mixed.slice(0, 14).map(esc).join("  ·  ")}${r.mixed.length > 14 ? `  …  +${r.mixed.length - 14} more` : ""}</div>
           </div>
         </div>`
      : `<div class="util-mixed ok"><span class="mx-icon">✓</span><div>No mixed totes — every counted tote holds a single product type.</div></div>`;

    // Detail rows
    const detailRows = [...r.detail]
      .sort((a, b) => a.utilisation - b.utilisation)
      .map(d => {
        const col = utilColour(d.utilisation);
        const chipCls = d.toteType === "Large" ? "large" : "small";
        return `<tr>
          <td style="color:var(--text);font-weight:600">${esc(d.toteId)}</td>
          <td><span class="ptype-tag ${chipCls}">${esc(d.toteType)}</span></td>
          <td>${esc(d.productType)}</td>
          <td class="num">${nf(d.quantity)}</td>
          <td class="num">${nf(d.capacity)}</td>
          <td class="num" style="color:${col};font-weight:700">${pct(d.utilisation)}</td>
        </tr>`;
      }).join("");

    // Pipeline strip — what came in and what got excluded, end to end
    const pipeHtml = `
      <div class="util-pipe">
        <div class="pipe-step"><span class="pipe-v">${nf(p.scanned)}</span><span class="pipe-l">${r._source === "quadron_api" ? "Inventory Lines" : "Dump Rows"}</span></div>
        <div class="pipe-step"><span class="pipe-v drop">${nf(p.excludedNonTote)}</span><span class="pipe-l">Decant / Non-tote</span></div>
        <div class="pipe-step"><span class="pipe-v drop">${nf(p.mixed)}</span><span class="pipe-l">Mixed Excluded</span></div>
        <div class="pipe-step"><span class="pipe-v good">${nf(p.counted)}</span><span class="pipe-l">Totes Counted</span></div>
      </div>`;

    mount.innerHTML = `
      <div class="card util-hero-card" style="--util-glow:${heroGlow}">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px;position:relative">
          <div class="card-title" style="margin:0">Overall Fill</div>
          <span class="util-fresh">refreshed ${new Date(r.generatedAt).toLocaleString()}</span>
        </div>
        <div class="util-hero">
          <div class="util-gauge">
            ${gaugeSvg(t.util)}
            <div class="g-center"><span class="g-pct">${pct(t.util)}</span><span class="g-lbl">utilised</span></div>
          </div>
          <div class="util-hero-stats">
            <div class="hs"><span class="hs-v teal">${nf(t.totes)}</span><span class="hs-l">Totes Counted</span></div>
            <div class="hs"><span class="hs-v">${nf(t.qty)}</span><span class="hs-l">Items Stored</span></div>
            <div class="hs"><span class="hs-v">${nf(t.cap)}</span><span class="hs-l">Total Capacity</span></div>
            <div class="hs"><span class="hs-v">${nf(t.cap - t.qty)}</span><span class="hs-l">Free Space</span></div>
          </div>
        </div>
      </div>

      <div class="card">
        <p class="util-section-h">Data pipeline <span class="sh-tag">TL / TS only — decant &amp; other locations dropped</span></p>
        ${pipeHtml}
      </div>

      <div class="card">
        <p class="util-section-h">Utilisation by category</p>
        <div class="util-cats">${catRows}</div>
      </div>

      <div class="card">${mixedHtml}</div>

      <div class="card">
        <p class="util-section-h">Quantity distribution <span class="sh-tag">${nf(r.distTotal)} totes hold 1–5 items</span></p>
        <div class="util-dist">${distBars}</div>
      </div>

      <div class="card">
        <p class="util-section-h">Per-tote detail <span class="sh-tag">lowest fill first · ${nf(r.detail.length)} totes</span></p>
        <div class="util-detail-wrap">
          <table class="util-table">
            <thead><tr><th>Tote ID</th><th>Type</th><th>Product</th><th>Qty</th><th>Capacity</th><th>Utilisation</th></tr></thead>
            <tbody>${detailRows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  function status(msg) { const el = $("utilStatus"); if (el) el.textContent = msg || ""; }

  async function run() {
    if (_running) return;
    const caps = readCapsFromUI();
    saveCaps(caps);
    const source = readSourceFromUI();
    saveSource(source);

    _running = true;
    const btn = $("utilRunBtn"); if (btn) { btn.disabled = true; btn.textContent = "Running…"; }
    $("utilCsvBtn").disabled = true;
    status(source === "quadron_api" ? "Reading live Quadron inventory…" : "Reading ASRS sheet dump…");

    let resp;
    try { resp = await chrome.runtime.sendMessage({ type: "TOTE_UTILISATION", caps, source }); }
    catch (e) { resp = { ok: false, reason: e.message || String(e) }; }

    _running = false;
    if (btn) { btn.disabled = false; btn.textContent = "▶ Run"; }

    if (!resp || !resp.ok) { _result = null; renderDashboard(); status("Failed: " + ((resp && resp.reason) || "unknown error")); return; }

    _result = resp.result;
    _result._source = source;
    renderDashboard();
    $("utilCsvBtn").disabled = false;
    const unit = source === "quadron_api" ? "inventory lines" : "dump rows";
    status(`Done — ${nf(resp.rowCount)} ${unit} · ${nf(_result.totals.totes)} totes · ${pct(_result.totals.util)} utilised`);

    // Cache this exact result so the ASRS Daily Report tab can reuse it as-is
    // instead of running its own separate live fetch — keeps the two tabs from
    // ever showing different numbers for what should be the same figure.
    try {
      await chrome.storage.local.set({
        asrs_util_last_result: { stats: _result.stats, totals: _result.totals, caps: _result.caps, source, generatedAt: _result.generatedAt },
      });
    } catch (e) {}
  }

  function exportCsv() {
    if (!_result) return;
    const r = _result;
    const cell = v => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [];

    lines.push("DATA PIPELINE (TL/TS only)");
    const p = r.pipeline || {};
    lines.push(["Inventory lines scanned", p.scanned || 0].join(","));
    lines.push(["Excluded — decant / non-tote", p.excludedNonTote || 0].join(","));
    lines.push(["Excluded — mixed totes", r.mixedCount].join(","));
    lines.push(["Totes counted", r.totals.totes].join(","));
    lines.push("");
    lines.push("CATEGORY SUMMARY");
    lines.push(["Category", "Totes", "Capacity/Tote", "Total Capacity", "Quantity", "Utilisation %"].join(","));
    CATS.forEach(c => {
      const s = r.stats[c.key];
      lines.push([c.label, s.totes, s.capPer, s.cap, s.qty, (s.util * 100).toFixed(2)].map(cell).join(","));
    });
    lines.push(["Total", r.totals.totes, "-", r.totals.cap, r.totals.qty, (r.totals.util * 100).toFixed(2)].map(cell).join(","));
    lines.push("");
    lines.push(`Mixed Totes Found,${r.mixedCount}`);
    if (r.mixedCount) lines.push("Mixed IDs," + cell(r.mixed.join(" ")));
    lines.push("");
    lines.push("QUANTITY DISTRIBUTION");
    [1,2,3,4,5].forEach(k => lines.push([`Tote with ${k} barcode(s)`, r.distribution[k]].join(",")));
    lines.push(["Total (1-5)", r.distTotal].join(","));
    lines.push("");
    lines.push("PER-TOTE DETAIL");
    lines.push(["Tote ID", "Type", "Product", "Quantity", "Capacity", "Utilisation %"].join(","));
    r.detail.forEach(d => lines.push([d.toteId, d.toteType, d.productType, d.quantity, d.capacity, (d.utilisation * 100).toFixed(2)].map(cell).join(",")));

    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tote-utilisation-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  function resetCaps() {
    saveCaps({ ...DEFAULT_CAPS });
    CATS.forEach(c => { $(c.capId).value = DEFAULT_CAPS[c.key]; });
    status("Capacities reset to defaults.");
  }

  function init() {
    const container = $("tab-utilisation");
    if (!container) return;
    render(container);
    renderDashboard();
    $("utilRunBtn")?.addEventListener("click", run);
    $("utilCsvBtn")?.addEventListener("click", exportCsv);
    $("utilResetBtn")?.addEventListener("click", resetCaps);
    ["utilSrcSheet", "utilSrcQuadron"].forEach(id => {
      $(id)?.addEventListener("change", () => saveSource(readSourceFromUI()));
    });
  }

  return { init };
})();
