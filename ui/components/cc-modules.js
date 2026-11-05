// ui/components/cc-modules.js
// Global render functions for each Cycle Count nav module, plus the shared stylesheet (CC_STYLES).
// Deliberately NOT wrapped in an IIFE — these need to be callable as window.renderXxx from
// cc-dashboard.js. Each function fully replaces `root.innerHTML` and wires its own listeners.

const CC_STYLES = `
  #tab-cc{--cc-r:14px;--cc-r-sm:9px}
  #tab-cc *{box-sizing:border-box}
  #tab-cc .hidden{display:none!important}
  #tab-cc .cc-app{display:flex;flex-direction:column;height:100%;min-height:80vh}

  /* ---- command header ---- */
  #tab-cc .cc-cmd-header{
    display:flex;align-items:center;gap:24px;flex-wrap:wrap;
    padding:16px 20px;border-radius:var(--cc-r);
    background:linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.01)), var(--surface);
    border:1px solid var(--border);backdrop-filter:blur(10px);
    margin-bottom:14px;position:sticky;top:0;z-index:20;
  }
  #tab-cc .cc-cmd-left{display:flex;align-items:center;gap:14px}
  #tab-cc .cc-health-ring{
    --cc-health-pct:0%;width:56px;height:56px;border-radius:50%;flex-shrink:0;
    display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-weight:800;font-size:16px;color:var(--text);
    background:conic-gradient(var(--muted-dim) var(--cc-health-pct), var(--surface-2) 0);
    position:relative;transition:background 1s ease;
  }
  #tab-cc .cc-health-ring::before{content:"";position:absolute;inset:5px;border-radius:50%;background:var(--surface)}
  #tab-cc .cc-health-ring span{position:relative;z-index:1}
  #tab-cc .cc-health-ring.cc-tone-good{background:conic-gradient(var(--green) var(--cc-health-pct), var(--surface-2) 0)}
  #tab-cc .cc-health-ring.cc-tone-warn{background:conic-gradient(var(--yellow) var(--cc-health-pct), var(--surface-2) 0)}
  #tab-cc .cc-health-ring.cc-tone-bad{background:conic-gradient(var(--red) var(--cc-health-pct), var(--surface-2) 0)}
  #tab-cc .cc-cmd-eyebrow{font-size:10px;letter-spacing:.12em;color:var(--muted);display:flex;align-items:center;gap:6px;font-weight:700}
  #tab-cc .cc-live-dot{width:7px;height:7px;border-radius:50%;background:var(--signal);animation:cc-pulse 2s infinite}
  #tab-cc .cc-cmd-title{font-size:17px;font-weight:800;color:var(--text);margin-top:2px}
  #tab-cc .cc-cmd-refresh{font-size:10.5px;color:var(--muted-dim);margin-top:2px;font-family:var(--mono)}
  #tab-cc .cc-cmd-stats{display:flex;gap:26px;margin-left:auto}
  #tab-cc .cc-cmd-stat{display:flex;flex-direction:column;align-items:center;gap:2px}
  #tab-cc .cc-cmd-stat-v{font-family:var(--mono);font-size:22px;font-weight:800;color:var(--text)}
  #tab-cc .cc-cmd-stat-l{font-size:9.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
  #tab-cc .cc-cmd-stat-crit{cursor:pointer;border-radius:var(--cc-r-sm);padding:2px 10px;transition:background .15s}
  #tab-cc .cc-cmd-stat-crit:hover{background:rgba(255,93,93,.10)}
  #tab-cc .cc-cmd-stat-crit .cc-cmd-stat-v{color:var(--red)}
  #tab-cc .cc-cmd-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

  /* ---- Grafana-style time range picker ---- */
  #tab-cc .cc-range-wrap{position:relative}
  #tab-cc .cc-range-trigger{display:flex;align-items:center;gap:8px;background:var(--surface-2);border:1px solid var(--border);color:var(--text);padding:6px 12px;border-radius:var(--cc-r-sm);cursor:pointer;font-size:12px;font-weight:600}
  #tab-cc .cc-range-trigger:hover{border-color:var(--signal)}
  #tab-cc .cc-range-icon{opacity:.75;font-size:12px}
  #tab-cc .cc-range-chevron{opacity:.6;font-size:9px;margin-left:2px}
  #tab-cc .cc-range-panel{position:absolute;top:calc(100% + 8px);right:0;z-index:50;display:flex;background:var(--surface);border:1px solid var(--border);border-radius:var(--cc-r-sm);box-shadow:0 12px 32px rgba(0,0,0,.45);overflow:hidden;min-width:500px}
  #tab-cc .cc-range-abs{width:230px;padding:14px 16px;border-right:1px solid var(--border);display:flex;flex-direction:column;gap:10px}
  #tab-cc .cc-range-abs-title{font-size:12.5px;font-weight:700;color:var(--text);margin-bottom:2px}
  #tab-cc .cc-range-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted)}
  #tab-cc .cc-range-input-wrap{position:relative}
  #tab-cc .cc-range-input{width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);padding:6px 28px 6px 8px;border-radius:var(--cc-r-sm);font-size:11.5px;font-family:var(--mono)}
  #tab-cc .cc-range-cal-icon{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:11px;opacity:.6;pointer-events:none}
  #tab-cc .cc-range-apply{background:#3b82f6;border:none;color:#fff;padding:8px 12px;border-radius:var(--cc-r-sm);cursor:pointer;font-size:12px;font-weight:700;margin-top:4px}
  #tab-cc .cc-range-apply:hover{filter:brightness(1.08)}
  #tab-cc .cc-range-hint{font-size:10.5px;color:var(--muted-dim);line-height:1.5;margin-top:4px}
  #tab-cc .cc-range-quick{width:230px;padding:10px 10px 12px;display:flex;flex-direction:column;max-height:340px}
  #tab-cc .cc-range-search-wrap{position:relative;margin-bottom:6px}
  #tab-cc .cc-range-search{width:100%;background:var(--surface-2);border:1px solid var(--border);color:var(--text);padding:6px 8px 6px 26px;border-radius:var(--cc-r-sm);font-size:11.5px}
  #tab-cc .cc-range-search-icon{position:absolute;left:8px;top:50%;transform:translateY(-50%);font-size:10px;opacity:.55;pointer-events:none}
  #tab-cc .cc-range-quick-list{overflow-y:auto;display:flex;flex-direction:column}
  #tab-cc .cc-range-quick-item{background:transparent;border:none;text-align:left;color:var(--text);padding:7px 8px;border-radius:6px;cursor:pointer;font-size:12px}
  #tab-cc .cc-range-quick-item:hover{background:var(--surface-2)}
  #tab-cc .cc-range-quick-item.active{background:var(--surface-2);color:var(--signal);font-weight:700}
  #tab-cc .cc-range-quick-empty{color:var(--muted-dim);font-size:11px;padding:8px}

  #tab-cc .cc-loading{color:var(--signal);font-size:11.5px}
  #tab-cc .cc-btn{background:var(--surface-2);border:1px solid var(--border);color:var(--text);padding:7px 14px;border-radius:var(--cc-r-sm);cursor:pointer;font-size:12px;font-weight:600;transition:transform .1s}
  #tab-cc .cc-btn:active{transform:scale(.97)}
  #tab-cc .cc-btn-primary{background:var(--accent);border-color:var(--accent);color:#1a1300}
  #tab-cc .cc-btn-ghost{background:transparent}

  #tab-cc .cc-auth-banner,#tab-cc .cc-error{background:rgba(255,93,93,.08);border:1px solid rgba(255,93,93,.35);color:#ffb3b3;padding:9px 14px;border-radius:var(--cc-r-sm);font-size:12.5px;margin-bottom:12px;white-space:pre-wrap}

  /* ---- body: nav + content ---- */
  #tab-cc .cc-body{display:flex;gap:14px;flex:1;min-height:0}
  #tab-cc .cc-nav{width:196px;flex-shrink:0;display:flex;flex-direction:column;gap:2px;background:var(--surface);border:1px solid var(--border);border-radius:var(--cc-r);padding:8px;height:fit-content;position:sticky;top:96px}
  #tab-cc .cc-nav-item{display:flex;align-items:center;gap:10px;background:transparent;border:none;border-left:3px solid transparent;color:var(--muted);padding:10px 10px;border-radius:8px;cursor:pointer;font-size:12.5px;text-align:left;transition:background .15s,color .15s}
  #tab-cc .cc-nav-item:hover{background:var(--surface-2);color:var(--text)}
  #tab-cc .cc-nav-item.active{background:var(--surface-2);color:var(--text);border-left-color:var(--signal);font-weight:700}
  #tab-cc .cc-nav-icon{width:16px;text-align:center;opacity:.8}
  #tab-cc .cc-content{flex:1;min-width:0}

  /* ---- generic section/card system reused by every module ---- */
  @keyframes cc-fade-up{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
  @keyframes cc-pulse{0%,100%{box-shadow:0 0 0 0 rgba(54,214,207,.5)}50%{box-shadow:0 0 0 5px rgba(54,214,207,0)}}
  #tab-cc .cc-section{background:var(--surface);border:1px solid var(--border);border-radius:var(--cc-r);padding:16px 18px;margin-bottom:14px;animation:cc-fade-up .28s ease both}
  #tab-cc .cc-section-title{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin:0 0 12px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
  #tab-cc .cc-section-title .cc-hint{font-size:10.5px;text-transform:none;letter-spacing:0;color:var(--muted-dim);font-weight:400}
  #tab-cc .cc-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  #tab-cc .cc-grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  #tab-cc .cc-grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
  @media (max-width:1050px){#tab-cc .cc-grid-2,#tab-cc .cc-grid-3,#tab-cc .cc-grid-4{grid-template-columns:1fr}}

  #tab-cc .cc-stat-card{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--cc-r-sm);padding:13px 15px;border-left:3px solid var(--muted-dim)}
  #tab-cc .cc-stat-card.cc-tone-good{border-left-color:var(--green)}
  #tab-cc .cc-stat-card.cc-tone-warn{border-left-color:var(--yellow)}
  #tab-cc .cc-stat-card.cc-tone-bad{border-left-color:var(--red)}
  #tab-cc .cc-stat-v{font-family:var(--mono);font-size:22px;font-weight:800;color:var(--text);display:block}
  #tab-cc .cc-stat-l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;display:block;margin-top:3px}
  #tab-cc .cc-stat-why{font-size:10.5px;color:var(--muted-dim);margin-top:6px;line-height:1.4}

  #tab-cc .cc-badge{display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700}
  #tab-cc .cc-tone-good{background:rgba(70,217,138,.13);color:var(--green)}
  #tab-cc .cc-tone-warn{background:rgba(243,195,77,.13);color:var(--yellow)}
  #tab-cc .cc-tone-bad{background:rgba(255,93,93,.13);color:var(--red)}
  #tab-cc .cc-tone-neutral{background:rgba(147,162,183,.15);color:var(--muted)}

  #tab-cc .cc-risk-pill{display:inline-block;padding:3px 9px;border-radius:999px;font-size:10.5px;font-weight:800;font-family:var(--mono)}
  #tab-cc .cc-risk-low{background:rgba(70,217,138,.13);color:var(--green)}
  #tab-cc .cc-risk-medium{background:rgba(243,195,77,.13);color:var(--yellow)}
  #tab-cc .cc-risk-high{background:rgba(255,138,61,.16);color:var(--net-err)}
  #tab-cc .cc-risk-critical{background:rgba(255,93,93,.18);color:var(--red);animation:cc-pulse-red 2s infinite}
  @keyframes cc-pulse-red{0%,100%{box-shadow:0 0 0 0 rgba(255,93,93,.35)}50%{box-shadow:0 0 0 4px rgba(255,93,93,0)}}

  #tab-cc .cc-table-wrap{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--cc-r-sm);overflow:auto;max-height:52vh}
  #tab-cc .cc-table-wrap.cc-small{max-height:280px}
  #tab-cc table{border-collapse:collapse;width:100%;font-size:12px}
  #tab-cc thead th{position:sticky;top:0;background:var(--surface-2);text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap;font-size:10.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)}
  #tab-cc tbody td{padding:7px 10px;border-bottom:1px solid var(--border-soft);white-space:nowrap}
  #tab-cc tbody tr:hover{background:rgba(255,255,255,.03)}
  #tab-cc tr.cc-row-click{cursor:pointer}
  #tab-cc .cc-empty{text-align:center;color:var(--muted);padding:30px 10px}

  #tab-cc .cc-insight,#tab-cc .cc-feed-row,#tab-cc .cc-alert-row{padding:9px 11px;border-radius:var(--cc-r-sm);font-size:12.5px;margin-bottom:6px;border-left:3px solid var(--muted-dim);background:var(--surface-2)}
  #tab-cc .cc-insight.cc-tone-good,#tab-cc .cc-feed-row.cc-tone-good,#tab-cc .cc-alert-row.cc-tone-good{border-left-color:var(--green)}
  #tab-cc .cc-insight.cc-tone-warn,#tab-cc .cc-feed-row.cc-tone-warn,#tab-cc .cc-alert-row.cc-tone-warn{border-left-color:var(--yellow)}
  #tab-cc .cc-insight.cc-tone-bad,#tab-cc .cc-feed-row.cc-tone-bad,#tab-cc .cc-alert-row.cc-tone-bad{border-left-color:var(--red)}
  #tab-cc .cc-insight.cc-tone-neutral,#tab-cc .cc-feed-row.cc-tone-neutral,#tab-cc .cc-alert-row.cc-tone-neutral{border-left-color:var(--muted-dim)}
  #tab-cc .cc-alert-row{display:flex;align-items:center;gap:10px;cursor:pointer;transition:transform .1s}
  #tab-cc .cc-alert-row:hover{transform:translateX(2px)}
  #tab-cc .cc-alert-main{flex:1;min-width:0}
  #tab-cc .cc-alert-tote{font-weight:700;color:var(--text);font-family:var(--mono);margin-right:8px}
  #tab-cc .cc-alert-meta{font-size:10.5px;color:var(--muted);margin-top:2px}
  #tab-cc .cc-feed-time{font-family:var(--mono);color:var(--muted);margin-right:8px;font-size:11px}

  #tab-cc .cc-heat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px}
  #tab-cc .cc-heat-cell{border-radius:var(--cc-r-sm);padding:11px;text-align:center;border:1px solid var(--border);cursor:pointer;transition:transform .12s}
  #tab-cc .cc-heat-cell:hover{transform:translateY(-2px)}
  #tab-cc .cc-heat-cell.cc-tone-good{background:rgba(70,217,138,.10)}
  #tab-cc .cc-heat-cell.cc-tone-warn{background:rgba(243,195,77,.12)}
  #tab-cc .cc-heat-cell.cc-tone-bad{background:rgba(255,93,93,.14)}
  #tab-cc .cc-heat-station{font-weight:700;font-size:12.5px;color:var(--text)}
  #tab-cc .cc-heat-rate{font-family:var(--mono);font-size:19px;font-weight:800;margin:4px 0}
  #tab-cc .cc-heat-sub{font-size:9.5px;color:var(--muted)}

  #tab-cc .cc-hourbar-list{display:flex;flex-direction:column;gap:5px;max-height:300px;overflow-y:auto}
  #tab-cc .cc-hourbar-row{display:grid;grid-template-columns:96px 1fr 34px;align-items:center;gap:8px;font-size:11.5px}
  #tab-cc .cc-hb-label{color:var(--muted);white-space:nowrap;font-family:var(--mono);font-size:10.5px}
  #tab-cc .cc-hb-track{background:var(--surface);border-radius:4px;height:9px;overflow:hidden}
  #tab-cc .cc-hb-fill{background:var(--signal);height:100%;transition:width .4s ease}
  #tab-cc .cc-hb-count{text-align:right;font-family:var(--mono)}

  #tab-cc .cc-filters{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:12px}
  #tab-cc .cc-filters label{font-size:10.5px;color:var(--muted);display:flex;flex-direction:column;gap:4px}
  #tab-cc .cc-filters select,#tab-cc .cc-filters input{background:var(--surface-2);border:1px solid var(--border);color:var(--text);padding:7px 9px;border-radius:var(--cc-r-sm);font-size:12px;min-width:140px}

  #tab-cc .cc-formula-note{font-size:10.5px;color:var(--muted-dim);font-family:var(--mono);margin:0;line-height:1.5}
  #tab-cc .cc-settings-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid var(--border-soft)}
  #tab-cc .cc-settings-row:last-child{border-bottom:none}
  #tab-cc .cc-settings-label{font-size:12.5px;color:var(--text)}
  #tab-cc .cc-settings-sub{font-size:10.5px;color:var(--muted);margin-top:2px}
  #tab-cc .cc-settings-input{width:90px;background:var(--surface-2);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:var(--cc-r-sm);font-family:var(--mono);text-align:right}

  /* ---- investigation drawer ---- */
  #tab-cc .cc-drawer-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:998}
  #tab-cc .cc-drawer{position:fixed;top:0;right:-460px;width:440px;max-width:92vw;height:100%;background:var(--surface);border-left:1px solid var(--border);z-index:999;transition:right .22s cubic-bezier(.4,0,.2,1);overflow-y:auto;padding:22px;box-shadow:-20px 0 40px rgba(0,0,0,.35)}
  #tab-cc .cc-drawer.open{right:0}
  #tab-cc .cc-drawer-close{position:absolute;top:16px;right:18px;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer}
  #tab-cc .cc-drawer-title{font-size:16px;font-weight:800;color:var(--text);margin:6px 0 16px;display:flex;align-items:center;gap:10px}
  #tab-cc .cc-drawer-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}
  #tab-cc .cc-dl{display:block;font-size:9.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  #tab-cc .cc-dv{display:block;font-size:13px;color:var(--text);font-weight:700;margin-top:2px}
  #tab-cc .cc-drawer-section-h{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:16px 0 8px;border-top:1px solid var(--border-soft);padding-top:14px;font-weight:700}
  #tab-cc .cc-timeline{font-size:12.5px}
  #tab-cc .cc-tl-step{display:flex;align-items:center;gap:8px;padding:4px 0}
  #tab-cc .cc-tl-dot{width:8px;height:8px;border-radius:50%;background:var(--signal);flex-shrink:0}
  #tab-cc .cc-tl-pending .cc-tl-dot{background:var(--muted-dim)}
  #tab-cc .cc-tl-time{margin-left:auto;color:var(--muted);font-family:var(--mono);font-size:11px}
  #tab-cc .cc-tl-arrow{padding-left:3px;color:var(--muted);font-size:11px}
  #tab-cc .cc-tl-note{color:var(--muted);font-size:11.5px;margin-top:4px}
  #tab-cc .cc-risk-reasons{font-size:12px;color:var(--muted);font-family:var(--mono)}
  #tab-cc .cc-drawer-hint{margin-top:16px;font-size:11px;color:var(--muted-dim);border-top:1px solid var(--border-soft);padding-top:12px}
`;

// ── shared render helpers (used by multiple modules) ──────────────────────────
function ccEsc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function ccHourBars(buckets) {
  const max = Math.max(1, ...buckets.map(b => b.count));
  return buckets.map(b => `<div class="cc-hourbar-row">
      <span class="cc-hb-label">${ccEsc(b.label)}</span>
      <span class="cc-hb-track"><span class="cc-hb-fill" style="width:${(b.count / max) * 100}%"></span></span>
      <span class="cc-hb-count">${b.count}</span>
    </div>`).join("");
}

function ccBreakdownRows(map) {
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return `<tr><td colspan="2" class="cc-empty">No data.</td></tr>`;
  return entries.map(([k, v]) => `<tr><td>${ccEsc(k)}</td><td>${v}</td></tr>`).join("");
}

function ccHeatCell(entry) {
  const band = entry.issueRate >= 40 ? "bad" : entry.issueRate >= 15 ? "warn" : "good";
  return `<div class="cc-heat-cell cc-tone-${band}" data-key="${ccEsc(entry.key)}">
    <div class="cc-heat-station">${ccEsc(entry.key)}</div>
    <div class="cc-heat-rate">${entry.issueRate.toFixed(0)}%</div>
    <div class="cc-heat-sub">${entry.issueCount}/${entry.total} issue rows</div>
  </div>`;
}

function ccRankingRows(statsMap, minSample) {
  const rows = [...statsMap.values()]
    .filter(s => s.correctlyFlagged + s.incorrectlyFlagged >= minSample)
    .sort((a, b) => (b.falseRate ?? -1) - (a.falseRate ?? -1));
  if (rows.length === 0) return `<tr><td colspan="4" class="cc-empty">Not enough flagged volume yet (min ${minSample}).</td></tr>`;
  return rows.map(s => `<tr class="cc-row-click" data-key="${ccEsc(s.key)}"><td>${ccEsc(s.key)}</td><td>${s.falseRate.toFixed(1)}%</td><td>${s.correctlyFlagged + s.incorrectlyFlagged}</td><td>${s.issueCount}</td></tr>`).join("");
}

function ccFmtTime(ctx, t) { return ctx.fmtTime(t); }
function $$(id, root) { return (root || document).querySelector(`#${id}`); }

// ── Mission Control ────────────────────────────────────────────────────────────
function renderMission(root, ctx) {
  if (!ctx.current) { root.innerHTML = `<div class="cc-empty">Click "Load" to populate Mission Control.</div>`; return; }
  const summary = ctx.current.summary;
  const health = CC_CLASSIFY.plantHealthScore(summary);
  const accDenom = summary.CORRECTLY_FLAGGED + summary.INCORRECTLY_FLAGGED + summary.CORRECTLY_RELEASED + summary.DATA_MISMATCH;
  const accNum = summary.CORRECTLY_FLAGGED + summary.CORRECTLY_RELEASED;
  const falseDenom = summary.CORRECTLY_FLAGGED + summary.INCORRECTLY_FLAGGED;
  const insights = CC_CLASSIFY.generateInsights(ctx.current, ctx.previous, ctx.periodLabel);
  const recs = CC_CLASSIFY.generateRecommendations(ctx.current, ctx.settings);
  const stationEntries = [...ctx.current.stationStats.values()].sort((a, b) => b.issueRate - a.issueRate).slice(0, 4);
  const feed = (window.__ccGetFeed ? window.__ccGetFeed() : []).slice(0, 10);

  root.innerHTML = `
    <div class="cc-section">
      <div class="cc-section-title">Plant Intelligence <span class="cc-hint">${health.score >= 80 ? "Healthy" : health.score >= 55 ? "Needs attention" : "Critical"} · formula in Settings</span></div>
      <div class="cc-grid-4">
        <div class="cc-stat-card"><span class="cc-stat-v">${ctx.pctStr(accNum, accDenom)}</span><span class="cc-stat-l">Inventory Accuracy</span><div class="cc-stat-why">Of totes reconciled either way, % where the tote-level flag matched the physical count.</div></div>
        <div class="cc-stat-card cc-tone-warn"><span class="cc-stat-v">${ctx.pctStr(summary.INCORRECTLY_FLAGGED, falseDenom)}</span><span class="cc-stat-l">False Reporting Rate</span><div class="cc-stat-why">Of SHORT-marked totes with a stock check, % that turned out fine.</div></div>
        <div class="cc-stat-card cc-tone-bad"><span class="cc-stat-v">${summary.DATA_MISMATCH + summary.GHOST}</span><span class="cc-stat-l">Critical Totes</span><div class="cc-stat-why">Data mismatches + ghost totes — unresolved and unexplained.</div></div>
        <div class="cc-stat-card"><span class="cc-stat-v">${ctx.current.offenders.length}</span><span class="cc-stat-l">Repeat Offenders</span><div class="cc-stat-why">Totes marked SHORT ≥${ctx.settings.offenderMinCount}× this period.</div></div>
        <div class="cc-stat-card cc-tone-bad"><span class="cc-stat-v">${summary.GHOST}</span><span class="cc-stat-l">Ghost Inventory</span><div class="cc-stat-why">Stock-checked but never marked discrepant — see Ghost Inventory module.</div></div>
        <div class="cc-stat-card cc-tone-neutral"><span class="cc-stat-v">${summary.UNMATCHED_NO_STOCK_CHECK}</span><span class="cc-stat-l">Pending Stock Checks</span><div class="cc-stat-why">Reported SHORT, no stock check found yet in this window.</div></div>
        <div class="cc-stat-card"><span class="cc-stat-v">${health.score}</span><span class="cc-stat-l">Plant Health /100</span><div class="cc-stat-why">100 − weighted(false-rate, ghost-rate, pending-rate). Weights editable in Settings.</div></div>
        <div class="cc-stat-card"><span class="cc-stat-v">${stationEntries[0] ? ccEsc(stationEntries[0].key) : "—"}</span><span class="cc-stat-l">Most Problematic Station</span><div class="cc-stat-why">Highest issue rate this period — see Stations module.</div></div>
      </div>
    </div>

    <div class="cc-grid-2">
      <div class="cc-section"><div class="cc-section-title">AI Decision Center <span class="cc-hint">generated from real aggregates, no LLM</span></div>
        <div>${insights.map(i => `<div class="cc-insight cc-tone-${i.tone}">${ccEsc(i.text)}</div>`).join("")}</div>
      </div>
      <div class="cc-section"><div class="cc-section-title">Recommended Actions</div>
        <div>${recs.map(r => `<div class="cc-insight cc-tone-${r.tone}">${ccEsc(r.text)}</div>`).join("")}</div>
      </div>
    </div>

    <div class="cc-grid-2">
      <div class="cc-section"><div class="cc-section-title">Station Health <span class="cc-hint">worst 4 · click for full map</span></div>
        <div class="cc-heat-grid" id="ccMissionHeat">${stationEntries.length ? stationEntries.map(ccHeatCell).join("") : `<div class="cc-empty">No station data.</div>`}</div>
      </div>
      <div class="cc-section"><div class="cc-section-title">Live Operations Feed <span class="cc-hint">polling every 30s, not a push feed</span></div>
        <div class="cc-hourbar-list" style="max-height:220px">
          ${feed.length ? feed.map(f => `<div class="cc-feed-row cc-tone-${f.tone}"><span class="cc-feed-time">${ccFmtTime(ctx, f.time)}</span>${ccEsc(f.text)}</div>`).join("") : `<div class="cc-empty">No recent events yet.</div>`}
        </div>
      </div>
    </div>
  `;
  root.querySelectorAll("#ccMissionHeat .cc-heat-cell").forEach(el => el.addEventListener("click", () => ctx.goToModule("stations")));
}

// ── Alerts ──────────────────────────────────────────────────────────────────────
function renderAlerts(root, ctx) {
  if (!ctx.current) { root.innerHTML = `<div class="cc-empty">Click "Load" to populate Alerts.</div>`; return; }
  const allAlerts = CC_CLASSIFY.alertQueue(ctx.current.classified, ctx.repeatOffenderSet, ctx.settings.riskWeights);
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  allAlerts.forEach(a => counts[a.risk.category]++);

  root.innerHTML = `
    <div class="cc-section">
      <div class="cc-section-title">Alert Queue <span class="cc-hint">${allAlerts.length} open items, sorted by risk</span></div>
      <div class="cc-grid-4" style="margin-bottom:14px">
        <div class="cc-stat-card cc-tone-bad" data-cat="Critical" style="cursor:pointer"><span class="cc-stat-v">${counts.Critical}</span><span class="cc-stat-l">Critical</span></div>
        <div class="cc-stat-card cc-tone-warn" data-cat="High" style="cursor:pointer"><span class="cc-stat-v">${counts.High}</span><span class="cc-stat-l">High</span></div>
        <div class="cc-stat-card" data-cat="Medium" style="cursor:pointer"><span class="cc-stat-v">${counts.Medium}</span><span class="cc-stat-l">Medium</span></div>
        <div class="cc-stat-card cc-tone-good" data-cat="Low" style="cursor:pointer"><span class="cc-stat-v">${counts.Low}</span><span class="cc-stat-l">Low</span></div>
      </div>
      <div class="cc-filters">
        <label>Risk Category<select id="ccAlertCatFilter"><option value="">All</option><option>Critical</option><option>High</option><option>Medium</option><option>Low</option></select></label>
        <label>Result<select id="ccAlertResultFilter">
          <option value="">All</option>
          <option value="INCORRECTLY_FLAGGED">Incorrectly Flagged</option>
          <option value="DATA_MISMATCH">Data Mismatch</option>
          <option value="GHOST">Ghost Tote</option>
          <option value="UNMATCHED_NO_STOCK_CHECK">Unmatched</option>
        </select></label>
        <label>Search<input type="text" id="ccAlertSearch" placeholder="Tote, station, user" /></label>
      </div>
      <div id="ccAlertList"></div>
    </div>
  `;
  const listEl = $$("ccAlertList", root);
  function draw() {
    const cat = $$("ccAlertCatFilter", root).value, result = $$("ccAlertResultFilter", root).value, search = $$("ccAlertSearch", root).value.trim().toLowerCase();
    const filtered = allAlerts.filter(a => {
      if (cat && a.risk.category !== cat) return false;
      if (result && a.row.resultKey !== result) return false;
      if (search && !`${a.row.container} ${a.row.station} ${a.row.user}`.toLowerCase().includes(search)) return false;
      return true;
    });
    listEl.innerHTML = filtered.length ? filtered.map(a => `
      <div class="cc-alert-row cc-tone-${a.row.resultTone}" data-container="${ccEsc(a.row.container)}">
        <span class="cc-risk-pill cc-risk-${a.risk.category.toLowerCase()}">${a.risk.score}</span>
        <div class="cc-alert-main">
          <span class="cc-alert-tote">${ccEsc(a.row.container)}</span><span class="cc-badge cc-tone-${a.row.resultTone}">${ccEsc(a.row.resultLabel)}</span>
          <div class="cc-alert-meta">${ccEsc(a.row.station) || "—"} · ${ccEsc(a.row.user) || "—"} · ${ccFmtTime(ctx, a.row.createTime)}</div>
        </div>
      </div>`).join("") : `<div class="cc-empty">No alerts match this filter.</div>`;
    listEl.querySelectorAll(".cc-alert-row").forEach((el, i) => el.addEventListener("click", () => {
      const match = filtered.find(a => a.row.container === el.dataset.container);
      if (match) ctx.openDrawer(match.row);
    }));
  }
  root.querySelectorAll(".cc-stat-card[data-cat]").forEach(el => el.addEventListener("click", () => { $$("ccAlertCatFilter", root).value = el.dataset.cat; draw(); }));
  [$$("ccAlertCatFilter", root), $$("ccAlertResultFilter", root), $$("ccAlertSearch", root)].forEach(el => el.addEventListener("input", draw));
  draw();
}

// ── Reconciliation ──────────────────────────────────────────────────────────────
function renderReconciliation(root, ctx) {
  const presetSearch = window.__ccPresetSearch; window.__ccPresetSearch = null;
  if (!ctx.current) { root.innerHTML = `<div class="cc-empty">Click "Load" to populate Reconciliation.</div>`; return; }
  const summary = ctx.current.summary;
  const allRows = ctx.current.classified;
  const types = [...new Set(allRows.map(e => e.operationType).filter(Boolean))].sort();

  root.innerHTML = `
    <div class="cc-section">
      <div class="cc-grid-4" style="margin-bottom:14px">
        <div class="cc-stat-card"><span class="cc-stat-v">${summary.total}</span><span class="cc-stat-l">Total Rows</span></div>
        <div class="cc-stat-card cc-tone-good"><span class="cc-stat-v">${summary.CORRECTLY_FLAGGED}</span><span class="cc-stat-l">Correctly Flagged</span></div>
        <div class="cc-stat-card cc-tone-warn"><span class="cc-stat-v">${summary.INCORRECTLY_FLAGGED}</span><span class="cc-stat-l">Incorrectly Flagged</span></div>
        <div class="cc-stat-card cc-tone-bad"><span class="cc-stat-v">${summary.GHOST}</span><span class="cc-stat-l">Ghost Totes</span></div>
      </div>
      <div class="cc-filters">
        <label>Operation Type<select id="ccOperationTypeFilter"><option value="">All</option>${types.map(t => `<option value="${ccEsc(t)}">${ccEsc(t)}</option>`).join("")}</select></label>
        <label>Marked As<select id="ccDiscrepancyTypeFilter"><option value="">All</option><option value="SHORT">SHORT</option><option value="ALRIGHT">ALRIGHT</option></select></label>
        <label>Result<select id="ccResultFilter">
          <option value="">All</option>
          <option value="CORRECTLY_FLAGGED">Correctly Flagged</option>
          <option value="INCORRECTLY_FLAGGED">Incorrectly Flagged</option>
          <option value="CORRECTLY_RELEASED">Correctly Released Clean</option>
          <option value="DATA_MISMATCH">Data Mismatch</option>
          <option value="UNMATCHED_NO_STOCK_CHECK">Unmatched (No SC Yet)</option>
          <option value="GHOST">Ghost Tote</option>
        </select></label>
        <label>Search<input type="text" id="ccSearchInput" placeholder="Tote ID, station, or user" value="${ccEsc(presetSearch || "")}" /></label>
        <button class="cc-btn" id="ccExportReconBtn">Export CSV</button>
      </div>
      <p class="cc-formula-note">Click any row for the Investigation drawer. Risk formula is editable in Settings.</p>
      <div class="cc-table-wrap">
        <table>
          <thead><tr><th>Tote</th><th>Station</th><th>User</th><th>Op Type</th><th>Marked As</th><th>SC Verdict</th><th>SC (A/S/E)</th><th>Result</th><th>Risk</th><th>Time</th></tr></thead>
          <tbody id="ccResultsBody"></tbody>
        </table>
      </div>
    </div>
  `;
  let filteredCache = [];
  function draw() {
    const opType = $$("ccOperationTypeFilter", root).value, discType = $$("ccDiscrepancyTypeFilter", root).value,
          result = $$("ccResultFilter", root).value, search = $$("ccSearchInput", root).value.trim().toLowerCase();
    filteredCache = allRows.filter(e => {
      if (opType && e.operationType !== opType) return false;
      if (discType && e.discrepancyType !== discType) return false;
      if (result && e.resultKey !== result) return false;
      if (search && !`${e.container} ${e.station} ${e.user}`.toLowerCase().includes(search)) return false;
      return true;
    });
    const body = $$("ccResultsBody", root);
    body.innerHTML = filteredCache.length ? filteredCache.map((e, i) => {
      const counts = e.stockCheckCounts ? `${e.stockCheckCounts.alright}/${e.stockCheckCounts.short}/${e.stockCheckCounts.excess}` : "—";
      const risk = CC_CLASSIFY.computeRiskScore(e, ctx.repeatOffenderSet, ctx.settings.riskWeights);
      return `<tr class="cc-row-click" data-idx="${i}">
        <td>${ccEsc(e.container)}</td><td>${ccEsc(e.station)}</td><td>${ccEsc(e.user)}</td><td>${ccEsc(e.operationType)}</td>
        <td>${ccEsc(e.discrepancyType) || "—"}</td><td>${ccEsc(e.stockCheckVerdict) || "—"}</td><td>${counts}</td>
        <td><span class="cc-badge cc-tone-${e.resultTone}">${ccEsc(e.resultLabel)}</span></td>
        <td><span class="cc-risk-pill cc-risk-${risk.category.toLowerCase()}">${risk.score} · ${risk.category}</span></td>
        <td>${ccFmtTime(ctx, e.createTime)}</td>
      </tr>`;
    }).join("") : `<tr><td colspan="10" class="cc-empty">No rows match the current filters.</td></tr>`;
    body.querySelectorAll("tr.cc-row-click").forEach(tr => tr.addEventListener("click", () => {
      const row = filteredCache[parseInt(tr.dataset.idx, 10)];
      if (row) ctx.openDrawer(row);
    }));
  }
  [$$("ccOperationTypeFilter", root), $$("ccDiscrepancyTypeFilter", root), $$("ccResultFilter", root), $$("ccSearchInput", root)].forEach(el => el.addEventListener("input", draw));
  $$("ccExportReconBtn", root).addEventListener("click", () => {
    ctx.downloadCsv(`cc_reconciliation_${Date.now()}.csv`,
      ["Tote", "Station", "User", "Operation Type", "Marked As", "Stock Check Verdict", "SC Alright", "SC Short", "SC Excess", "Result", "Risk Score", "Risk Category", "Time"],
      filteredCache.map(e => { const c = e.stockCheckCounts || { alright: "", short: "", excess: "" }; const risk = CC_CLASSIFY.computeRiskScore(e, ctx.repeatOffenderSet, ctx.settings.riskWeights);
        return [e.container, e.station, e.user, e.operationType, e.discrepancyType, e.stockCheckVerdict, c.alright, c.short, c.excess, e.resultLabel, risk.score, risk.category, ccFmtTime(ctx, e.createTime)]; }));
  });
  draw();
}

// ── Ghost Inventory ───────────────────────────────────────────────────────────
function renderGhost(root, ctx) {
  if (!ctx.current) { root.innerHTML = `<div class="cc-empty">Click "Load" to populate Ghost Inventory.</div>`; return; }
  const ghosts = CC_CLASSIFY.ghostTotes(ctx.discRows, ctx.scRows);
  const totalSessions = ctx.current.summary.total ? [...CC_CLASSIFY.rollupStockCheckByContainer(ctx.scRows).values()].length : 0;
  const ghostRate = totalSessions ? (ghosts.length / totalSessions) * 100 : 0;
  let trendHtml = "";
  if (ctx.previous) {
    const delta = ctx.current.summary.GHOST - ctx.previous.summary.GHOST;
    const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat vs";
    trendHtml = `<div class="cc-insight cc-tone-${delta > 0 ? "bad" : "good"}">Ghost tote count is ${dir} ${Math.abs(delta)} vs the previous ${ctx.periodLabel} (${ctx.previous.summary.GHOST} → ${ctx.current.summary.GHOST}).</div>`;
  } else {
    trendHtml = `<div class="cc-insight cc-tone-neutral">Previous-period comparison unavailable this load.</div>`;
  }

  root.innerHTML = `
    <div class="cc-section">
      <div class="cc-section-title">Ghost Inventory <span class="cc-hint">stock-checked, never marked discrepant by an operator</span></div>
      <div class="cc-grid-2" style="margin-bottom:14px">
        <div class="cc-stat-card cc-tone-bad"><span class="cc-stat-v">${ghosts.length}</span><span class="cc-stat-l">Ghost Totes This Period</span><div class="cc-stat-why">Either cycle counts run outside the discrepancy-report flow, or operators are skipping the report step. Worth confirming which with the floor team.</div></div>
        <div class="cc-stat-card"><span class="cc-stat-v">${ghostRate.toFixed(1)}%</span><span class="cc-stat-l">Of All Stock-Checked Totes</span></div>
      </div>
      ${trendHtml}
    </div>
    <div class="cc-section">
      <div class="cc-section-title">Ghost Tote List</div>
      <div class="cc-table-wrap">
        <table>
          <thead><tr><th>Tote</th><th>Station</th><th>User</th><th>Verdict</th><th>Counts (A/S/E)</th><th>Time</th></tr></thead>
          <tbody>${ghosts.length ? ghosts.map(g => `<tr class="cc-row-click" data-container="${ccEsc(g.container)}"><td>${ccEsc(g.container)}</td><td>${ccEsc(g.station)}</td><td>${ccEsc(g.user)}</td><td>${ccEsc(g.stockCheckVerdict)}</td><td>${g.stockCheckCounts.alright}/${g.stockCheckCounts.short}/${g.stockCheckCounts.excess}</td><td>${ccFmtTime(ctx, g.createTime)}</td></tr>`).join("") : `<tr><td colspan="6" class="cc-empty">None in this window.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `;
  root.querySelectorAll("tr.cc-row-click").forEach(tr => tr.addEventListener("click", () => {
    const row = ghosts.find(g => g.container === tr.dataset.container);
    if (row) ctx.openDrawer(row);
  }));
}

// ── Operators ─────────────────────────────────────────────────────────────────
function renderOperators(root, ctx) {
  if (!ctx.current) { root.innerHTML = `<div class="cc-empty">Click "Load" to populate Operators.</div>`; return; }
  const stats = [...ctx.current.operatorStats.values()].sort((a, b) => (b.falseRate ?? -1) - (a.falseRate ?? -1));
  const flagged = stats.filter(s => s.correctlyFlagged + s.incorrectlyFlagged >= ctx.settings.minSample);

  root.innerHTML = `
    <div class="cc-section">
      <div class="cc-section-title">Operator Accuracy <span class="cc-hint">worst false-rate first, min ${ctx.settings.minSample} flagged (Settings)</span></div>
      <div class="cc-table-wrap">
        <table>
          <thead><tr><th>Operator</th><th>False Rate</th><th>Flagged Sample</th><th>Total Rows</th><th>Issues</th></tr></thead>
          <tbody>${flagged.length ? flagged.map(s => `<tr class="cc-row-click" data-key="${ccEsc(s.key)}"><td>${ccEsc(s.key)}</td><td>${s.falseRate.toFixed(1)}%</td><td>${s.correctlyFlagged + s.incorrectlyFlagged}</td><td>${s.total}</td><td>${s.issueCount}</td></tr>`).join("") : `<tr><td colspan="5" class="cc-empty">Not enough flagged volume yet.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
    <div class="cc-section">
      <div class="cc-section-title">All Operators <span class="cc-hint">including low-sample</span></div>
      <div class="cc-table-wrap cc-small">
        <table>
          <thead><tr><th>Operator</th><th>Total Rows</th><th>Correctly Flagged</th><th>Incorrectly Flagged</th></tr></thead>
          <tbody>${stats.length ? stats.map(s => `<tr class="cc-row-click" data-key="${ccEsc(s.key)}"><td>${ccEsc(s.key)}</td><td>${s.total}</td><td>${s.correctlyFlagged}</td><td>${s.incorrectlyFlagged}</td></tr>`).join("") : `<tr><td colspan="4" class="cc-empty">No data.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `;
  root.querySelectorAll("tr.cc-row-click").forEach(tr => tr.addEventListener("click", () => ctx.goToModule("reconciliation", tr.dataset.key)));
}

// ── Stations ──────────────────────────────────────────────────────────────────
function renderStations(root, ctx) {
  if (!ctx.current) { root.innerHTML = `<div class="cc-empty">Click "Load" to populate Stations.</div>`; return; }
  const stationEntries = [...ctx.current.stationStats.values()].sort((a, b) => b.issueRate - a.issueRate);
  const pareto = CC_CLASSIFY.paretoAnalysis(ctx.current.stationStats);

  root.innerHTML = `
    <div class="cc-section">
      <div class="cc-section-title">Station Health Map <span class="cc-hint">colour = issue rate · click a station to drill into Reconciliation</span></div>
      <div class="cc-heat-grid" id="ccStationsHeat">${stationEntries.length ? stationEntries.map(ccHeatCell).join("") : `<div class="cc-empty">No station data.</div>`}</div>
    </div>
    <div class="cc-grid-2">
      <div class="cc-section"><div class="cc-section-title">Pareto — Stations by Issue Volume</div>
        <div class="cc-table-wrap cc-small"><table><thead><tr><th>Station</th><th>Issues</th><th>% of Issues</th><th>Cumulative %</th></tr></thead>
          <tbody>${pareto.length ? pareto.map(s => `<tr><td>${ccEsc(s.key)}</td><td>${s.issueCount}</td><td>${s.pctOfIssues.toFixed(1)}%</td><td>${s.cumulativePct.toFixed(1)}%</td></tr>`).join("") : `<tr><td colspan="4" class="cc-empty">No issues in this window.</td></tr>`}</tbody>
        </table></div>
      </div>
      <div class="cc-section"><div class="cc-section-title">Station Accuracy Ranking <span class="cc-hint">min ${ctx.settings.minSample} flagged</span></div>
        <div class="cc-table-wrap cc-small"><table><thead><tr><th>Station</th><th>False Rate</th><th>Sample</th><th>Issues</th></tr></thead>
          <tbody id="ccStationRankBody">${ccRankingRows(ctx.current.stationStats, ctx.settings.minSample)}</tbody>
        </table></div>
      </div>
    </div>
  `;
  root.querySelectorAll("#ccStationsHeat .cc-heat-cell, #ccStationRankBody .cc-row-click").forEach(el => el.addEventListener("click", () => ctx.goToModule("reconciliation", el.dataset.key)));
}

// ── Analytics ─────────────────────────────────────────────────────────────────
function renderAnalytics(root, ctx) {
  if (!ctx.current || !ctx.range.fromDate) { root.innerHTML = `<div class="cc-empty">Click "Load" to populate Analytics.</div>`; return; }
  const discBuckets = CC_CLASSIFY.bucketByHour(ctx.discRows, r => CC_CLASSIFY.parseCreateTime(r.createTime), ctx.range.fromDate, ctx.range.toDate);
  const seen = new Map();
  for (const row of ctx.scRows) { if (!seen.has(row.container) || row.createTime > seen.get(row.container)) seen.set(row.container, row.createTime); }
  const scSessionRows = [...seen.values()].map(createTime => ({ createTime }));
  const scBuckets = CC_CLASSIFY.bucketByHour(scSessionRows, r => CC_CLASSIFY.parseCreateTime(r.createTime), ctx.range.fromDate, ctx.range.toDate);
  const dist = CC_CLASSIFY.timeToCheckDistribution(ctx.current.classified);
  const distMax = Math.max(1, ...Object.values(dist));
  const discStats = CC_CLASSIFY.discrepancyActivityStats(ctx.discRows);
  const scStats = CC_CLASSIFY.stockCheckActivityStats(ctx.scRows);

  root.innerHTML = `
    <div class="cc-grid-2">
      <div class="cc-section"><div class="cc-section-title">Discrepancy Marked — Hourly Volume</div><div class="cc-hourbar-list">${ccHourBars(discBuckets)}</div></div>
      <div class="cc-section"><div class="cc-section-title">Stock Check — Hourly Volume (totes)</div><div class="cc-hourbar-list">${ccHourBars(scBuckets)}</div></div>
    </div>
    <div class="cc-grid-2">
      <div class="cc-section"><div class="cc-section-title">Time to Stock Check <span class="cc-hint">SHORT-marked, matched rows only</span></div>
        <div class="cc-hourbar-list">${Object.entries(dist).map(([label, count]) => `<div class="cc-hourbar-row"><span class="cc-hb-label">${label}</span><span class="cc-hb-track"><span class="cc-hb-fill" style="width:${(count / distMax) * 100}%"></span></span><span class="cc-hb-count">${count}</span></div>`).join("")}</div>
      </div>
      <div class="cc-section"><div class="cc-section-title">Discrepancy Marked — By Operation Type</div>
        <div class="cc-table-wrap cc-small"><table><thead><tr><th>Operation Type</th><th>Count</th></tr></thead><tbody>${ccBreakdownRows(discStats.byOperationType)}</tbody></table></div>
      </div>
    </div>
    <div class="cc-grid-2">
      <div class="cc-section"><div class="cc-section-title">Volume Summary</div>
        <div class="cc-grid-2">
          <div class="cc-stat-card"><span class="cc-stat-v">${discStats.total}</span><span class="cc-stat-l">Discrepancy Events</span></div>
          <div class="cc-stat-card"><span class="cc-stat-v">${scStats.totalSessions}</span><span class="cc-stat-l">Totes Stock-Checked</span></div>
          <div class="cc-stat-card"><span class="cc-stat-v">${scStats.totalSkuLines}</span><span class="cc-stat-l">SKU Lines Counted</span></div>
          <div class="cc-stat-card"><span class="cc-stat-v">${scStats.mixed}</span><span class="cc-stat-l">Mixed-Result Totes</span></div>
        </div>
      </div>
      <div class="cc-section"><div class="cc-section-title">Stock Check — By Station</div>
        <div class="cc-table-wrap cc-small"><table><thead><tr><th>Station</th><th>Count</th></tr></thead><tbody>${ccBreakdownRows(scStats.byStation)}</tbody></table></div>
      </div>
    </div>
  `;
}

// ── Reports ───────────────────────────────────────────────────────────────────
function renderReports(root, ctx) {
  if (!ctx.current) { root.innerHTML = `<div class="cc-empty">Click "Load" to populate Reports.</div>`; return; }
  root.innerHTML = `
    <div class="cc-section">
      <div class="cc-section-title">Export</div>
      <div class="cc-grid-3">
        <button class="cc-btn" id="ccExpRecon">Reconciliation (all rows, with risk)</button>
        <button class="cc-btn" id="ccExpAlerts">Alert Queue</button>
        <button class="cc-btn" id="ccExpGhost">Ghost Totes</button>
        <button class="cc-btn" id="ccExpOffenders">Repeat Offenders</button>
        <button class="cc-btn" id="ccExpStations">Station Breakdown</button>
        <button class="cc-btn" id="ccExpOperators">Operator Breakdown</button>
      </div>
    </div>
    <div class="cc-section">
      <div class="cc-section-title">Raw Discrepancy Marked Events <span class="cc-hint">most recent 200</span></div>
      <div class="cc-table-wrap cc-small"><table><thead><tr><th>Tote</th><th>Station</th><th>User</th><th>Op Type</th><th>Marked As</th><th>Time</th></tr></thead>
        <tbody>${ctx.discRows.slice(0, 200).map(r => `<tr><td>${ccEsc(r.container)}</td><td>${ccEsc(r.station)}</td><td>${ccEsc(r.user)}</td><td>${ccEsc(r.operationType)}</td><td>${ccEsc(r.discrepancyType)}</td><td>${ccFmtTime(ctx, r.createTime)}</td></tr>`).join("") || `<tr><td colspan="6" class="cc-empty">No data.</td></tr>`}</tbody>
      </table></div>
    </div>
    <div class="cc-section">
      <div class="cc-section-title">Raw Stock Check Rows <span class="cc-hint">most recent 200, SKU-level</span></div>
      <div class="cc-table-wrap cc-small"><table><thead><tr><th>Tote</th><th>SKU</th><th>Result</th><th>Station</th><th>User</th><th>Time</th></tr></thead>
        <tbody>${ctx.scRows.slice(0, 200).map(r => `<tr><td>${ccEsc(r.container)}</td><td>${ccEsc(r.sku)}</td><td>${ccEsc(r.resultType)}</td><td>${ccEsc(r.station)}</td><td>${ccEsc(r.user)}</td><td>${ccFmtTime(ctx, r.createTime)}</td></tr>`).join("") || `<tr><td colspan="6" class="cc-empty">No data.</td></tr>`}</tbody>
      </table></div>
    </div>
  `;
  $$("ccExpRecon", root).addEventListener("click", () => ctx.downloadCsv(`cc_reconciliation_${Date.now()}.csv`,
    ["Tote", "Station", "User", "Op Type", "Marked As", "SC Verdict", "Result", "Risk", "Time"],
    ctx.current.classified.map(e => { const risk = CC_CLASSIFY.computeRiskScore(e, ctx.repeatOffenderSet, ctx.settings.riskWeights); return [e.container, e.station, e.user, e.operationType, e.discrepancyType, e.stockCheckVerdict, e.resultLabel, risk.score, ccFmtTime(ctx, e.createTime)]; })));
  $$("ccExpAlerts", root).addEventListener("click", () => {
    const alerts = CC_CLASSIFY.alertQueue(ctx.current.classified, ctx.repeatOffenderSet, ctx.settings.riskWeights);
    ctx.downloadCsv(`cc_alerts_${Date.now()}.csv`, ["Tote", "Station", "User", "Result", "Risk Score", "Risk Category", "Time"],
      alerts.map(a => [a.row.container, a.row.station, a.row.user, a.row.resultLabel, a.risk.score, a.risk.category, ccFmtTime(ctx, a.row.createTime)]));
  });
  $$("ccExpGhost", root).addEventListener("click", () => {
    const ghosts = CC_CLASSIFY.ghostTotes(ctx.discRows, ctx.scRows);
    ctx.downloadCsv(`cc_ghost_totes_${Date.now()}.csv`, ["Tote", "Station", "User", "Verdict", "Alright", "Short", "Excess", "Time"],
      ghosts.map(g => [g.container, g.station, g.user, g.stockCheckVerdict, g.stockCheckCounts.alright, g.stockCheckCounts.short, g.stockCheckCounts.excess, ccFmtTime(ctx, g.createTime)]));
  });
  $$("ccExpOffenders", root).addEventListener("click", () => ctx.downloadCsv(`cc_repeat_offenders_${Date.now()}.csv`,
    ["Tote", "SHORT Count", "Stations", "Users", "Last Seen"],
    ctx.current.offenders.map(o => [o.container, o.count, o.stations, o.users, ccFmtTime(ctx, o.lastCreateTime)])));
  $$("ccExpStations", root).addEventListener("click", () => ctx.downloadCsv(`cc_station_breakdown_${Date.now()}.csv`,
    ["Station", "Total", "Correctly Flagged", "Incorrectly Flagged", "False Rate", "Issue Count"],
    [...ctx.current.stationStats.values()].map(s => [s.key, s.total, s.correctlyFlagged, s.incorrectlyFlagged, s.falseRate == null ? "" : s.falseRate.toFixed(1), s.issueCount])));
  $$("ccExpOperators", root).addEventListener("click", () => ctx.downloadCsv(`cc_operator_breakdown_${Date.now()}.csv`,
    ["Operator", "Total", "Correctly Flagged", "Incorrectly Flagged", "False Rate", "Issue Count"],
    [...ctx.current.operatorStats.values()].map(s => [s.key, s.total, s.correctlyFlagged, s.incorrectlyFlagged, s.falseRate == null ? "" : s.falseRate.toFixed(1), s.issueCount])));
}

// ── Settings ──────────────────────────────────────────────────────────────────
function renderSettings(root, ctx) {
  const s = ctx.settings;
  const w = s.riskWeights;
  root.innerHTML = `
    <div class="cc-section">
      <div class="cc-section-title">Recommendation Thresholds <span class="cc-hint">drive Recommendations + Plant Intelligence "why" text</span></div>
      <div class="cc-settings-row"><div><div class="cc-settings-label">Station false-rate warning</div><div class="cc-settings-sub">Flag a station in Recommendations above this %</div></div><input class="cc-settings-input" id="ccSFalseRate" type="number" value="${s.falseRateWarn}" /></div>
      <div class="cc-settings-row"><div><div class="cc-settings-label">Minimum sample size</div><div class="cc-settings-sub">Ignore rankings/recommendations below this many flagged totes</div></div><input class="cc-settings-input" id="ccSMinSample" type="number" value="${s.minSample}" /></div>
      <div class="cc-settings-row"><div><div class="cc-settings-label">Ghost count warning</div><div class="cc-settings-sub">Trigger a recommendation above this many ghost totes</div></div><input class="cc-settings-input" id="ccSGhostWarn" type="number" value="${s.ghostWarn}" /></div>
      <div class="cc-settings-row"><div><div class="cc-settings-label">Pending stock-check warning</div><div class="cc-settings-sub">Trigger a recommendation above this many pending totes</div></div><input class="cc-settings-input" id="ccSPendingWarn" type="number" value="${s.pendingWarn}" /></div>
      <div class="cc-settings-row"><div><div class="cc-settings-label">Repeat offender threshold</div><div class="cc-settings-sub">SHORT count to qualify as a repeat offender tote</div></div><input class="cc-settings-input" id="ccSOffenderMin" type="number" value="${s.offenderMinCount}" min="2" /></div>
    </div>
    <div class="cc-section">
      <div class="cc-section-title">Risk Score Weights <span class="cc-hint">${CC_CLASSIFY.riskFormulaText()}</span></div>
      <div class="cc-grid-3">
        <div class="cc-settings-row"><div class="cc-settings-label">Base — Ghost</div><input class="cc-settings-input" id="ccWGhost" type="number" value="${w.base.GHOST}" /></div>
        <div class="cc-settings-row"><div class="cc-settings-label">Base — Data Mismatch</div><input class="cc-settings-input" id="ccWMismatch" type="number" value="${w.base.DATA_MISMATCH}" /></div>
        <div class="cc-settings-row"><div class="cc-settings-label">Base — Incorrectly Flagged</div><input class="cc-settings-input" id="ccWIncorrect" type="number" value="${w.base.INCORRECTLY_FLAGGED}" /></div>
        <div class="cc-settings-row"><div class="cc-settings-label">Base — Unmatched</div><input class="cc-settings-input" id="ccWUnmatched" type="number" value="${w.base.UNMATCHED_NO_STOCK_CHECK}" /></div>
        <div class="cc-settings-row"><div class="cc-settings-label">Base — Correctly Flagged</div><input class="cc-settings-input" id="ccWCorrectFlag" type="number" value="${w.base.CORRECTLY_FLAGGED}" /></div>
        <div class="cc-settings-row"><div class="cc-settings-label">Base — Correctly Released</div><input class="cc-settings-input" id="ccWCorrectRel" type="number" value="${w.base.CORRECTLY_RELEASED}" /></div>
        <div class="cc-settings-row"><div class="cc-settings-label">Repeat offender bonus</div><input class="cc-settings-input" id="ccWRepeat" type="number" value="${w.repeatOffenderBonus}" /></div>
        <div class="cc-settings-row"><div class="cc-settings-label">Gap &gt;4h bonus</div><input class="cc-settings-input" id="ccWGap4" type="number" value="${w.gapOver4hBonus}" /></div>
        <div class="cc-settings-row"><div class="cc-settings-label">Gap &gt;24h bonus</div><input class="cc-settings-input" id="ccWGap24" type="number" value="${w.gapOver24hBonus}" /></div>
      </div>
    </div>
    <div class="cc-section">
      <button class="cc-btn cc-btn-primary" id="ccSaveSettings">Save Settings</button>
      <button class="cc-btn cc-btn-ghost" id="ccResetSettings">Reset to Defaults</button>
      <p class="cc-formula-note" style="margin-top:10px">Settings persist locally in this browser profile (chrome.storage.local) and apply immediately to Risk, Alerts, Recommendations, and rankings across all modules. The Grafana connection itself is managed in this console's own Grafana Integration section, not here.</p>
    </div>
  `;
  $$("ccSaveSettings", root).addEventListener("click", () => {
    const num = id => Number($$(id, root).value);
    ctx.saveSettings({
      falseRateWarn: num("ccSFalseRate"), minSample: num("ccSMinSample"), ghostWarn: num("ccSGhostWarn"),
      pendingWarn: num("ccSPendingWarn"), offenderMinCount: Math.max(2, num("ccSOffenderMin")),
      riskWeights: {
        base: { GHOST: num("ccWGhost"), DATA_MISMATCH: num("ccWMismatch"), INCORRECTLY_FLAGGED: num("ccWIncorrect"), UNMATCHED_NO_STOCK_CHECK: num("ccWUnmatched"), CORRECTLY_FLAGGED: num("ccWCorrectFlag"), CORRECTLY_RELEASED: num("ccWCorrectRel") },
        repeatOffenderBonus: num("ccWRepeat"), gapOver4hBonus: num("ccWGap4"), gapOver24hBonus: num("ccWGap24"),
      },
    });
  });
  $$("ccResetSettings", root).addEventListener("click", () => {
    ctx.saveSettings({ falseRateWarn: 25, minSample: 5, ghostWarn: 5, pendingWarn: 5, offenderMinCount: 2, riskWeights: JSON.parse(JSON.stringify(CC_CLASSIFY.DEFAULT_RISK_WEIGHTS)) });
  });
}
