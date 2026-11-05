// ui/components/tracker.js
// Tracker tab — bulk tote lookup. Per tote: Tote Finder (tracker/location/lane/
// updated) + derived Status + Last Good Location (bad trackers) + Scanner Events
// (latest create_time + 5 scanners-reason) + Blocked-on-tote (Outside totes only,
// via the NexS blocked-inventory API mapped through the Quadron inventory dashboard).
// All data work runs in the background service worker (TRACKER_RUN).

const TrackerPanel = (() => {
  const $ = id => document.getElementById(id);
  const FACILITY_KEY = "qtp_purge_facility";   // shared with Purge tab
  const TOTE_RX = /T[SL]\d{10}/gi;

  let _rows = [];
  let _running = false;

  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const fmt = ms => (ms == null || ms === "" ? "" : new Date(Number(ms)).toLocaleString());
  const parseTotes = raw => [...new Set((String(raw).match(TOTE_RX) || []).map(s => s.toUpperCase()))];

  const ST_CLASS = { "Bad Tracker": "bad", "Buffer": "buf", "Outside Tote": "out", "On Location": "on" };
  const badge = s => (s && s !== "—" ? `<span class="tr-st ${ST_CLASS[s] || "unk"}">${esc(s)}</span>` : (s || ""));

  function render(container) {
    const facility = localStorage.getItem(FACILITY_KEY) || "NXS1";
    container.innerHTML = `
      <style>
        #tab-tracker .tr-controls{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-bottom:12px}
        #tab-tracker .tr-totes{width:380px;max-width:100%;min-height:110px;font-family:ui-monospace,Menlo,monospace}
        #tab-tracker .tr-tote-panel{display:flex;flex-direction:column;gap:8px}
        #tab-tracker .tr-tote-btns{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
        #tab-tracker .tr-side{display:flex;flex-direction:column;gap:0;flex:1;min-width:220px}
        #tab-tracker .tr-status{color:var(--muted,#8b949e);font-size:12px;flex:1}
        #tab-tracker .tr-tablewrap{overflow:auto;border:1px solid var(--line,#2a313c);border-radius:10px;max-height:66vh}
        #tab-tracker table.tr-table{border-collapse:collapse;width:100%;font-size:12px;white-space:nowrap}
        #tab-tracker table.tr-table th,#tab-tracker table.tr-table td{padding:7px 9px;border-bottom:1px solid var(--line,#2a313c);text-align:left;vertical-align:top}
        #tab-tracker table.tr-table thead th{position:sticky;top:0;background:#1b2230;z-index:1;font-weight:600;color:var(--muted,#8b949e)}
        #tab-tracker td .sc{font-weight:600}
        #tab-tracker td .rs{color:var(--muted,#8b949e);font-size:11px;margin-top:2px}
        #tab-tracker td.tr-err{color:var(--err,#f85149)}
        #tab-tracker .tr-seg{border-left:2px solid var(--line,#2a313c)}
        #tab-tracker .tr-blk{font-weight:700}
        #tab-tracker .tr-blk.hot{color:var(--err,#f85149)}
        #tab-tracker .tr-pg{padding:2px 9px;border-radius:11px;font-size:11px;font-weight:700;display:inline-block}
        #tab-tracker .tr-pg.safe{background:#0f2e1a;color:#56d364}
        #tab-tracker .tr-pg.unsafe{background:#3a1115;color:#ff7b72}
        #tab-tracker .tr-pgdetail{white-space:normal;max-width:200px}
        #tab-tracker .tr-st{padding:2px 9px;border-radius:11px;font-size:11px;font-weight:600;display:inline-block;white-space:nowrap}
        #tab-tracker .tr-st.bad{background:#3a1115;color:#ff7b72}
        #tab-tracker .tr-st.buf{background:#3a2e10;color:#e3b341}
        #tab-tracker .tr-st.out{background:#10283a;color:#79c0ff}
        #tab-tracker .tr-st.on{background:#0f2e1a;color:#56d364}
        #tab-tracker .tr-st.unk{background:#21262d;color:#8b949e}
        #tab-tracker .tr-sum-box{border:1px solid var(--line,#2a313c);border-radius:10px;overflow:hidden;width:100%}
        #tab-tracker .tr-sum-row{display:flex;justify-content:space-between;align-items:center;padding:8px 14px;border-bottom:1px solid var(--line,#2a313c)}
        #tab-tracker .tr-sum-row:last-child{border-bottom:none}
        #tab-tracker .tr-sum-label{font-size:12px;color:var(--muted,#8b949e)}
        #tab-tracker .tr-sum-val{font-size:14px;font-weight:700;font-family:ui-monospace,Menlo,monospace;color:var(--text,#e6edf3);min-width:28px;text-align:right}
        #tab-tracker .tr-sum-row.out .tr-sum-val{color:#79c0ff}
        #tab-tracker .tr-sum-row.on  .tr-sum-val{color:#56d364}
        #tab-tracker .tr-sum-row.buf .tr-sum-val{color:#e3b341}
        #tab-tracker .tr-sum-row.bad .tr-sum-val{color:#ff7b72}
        #tab-tracker .tr-sum-row.tot{background:rgba(255,255,255,.03)}
        #tab-tracker .tr-sum-row.tot .tr-sum-label{font-weight:600;color:var(--text,#e6edf3)}
        #tab-tracker .tr-sum-row.tot .tr-sum-val{color:var(--accent,#7aa2f7)}
      </style>

      <div class="card">
        <div class="card-title">🔎 Outside Tote Analysis</div>
        <p class="purge-sub" style="margin-bottom:12px">Per tote: tracker · location · derived status · last good location (bad tracker) · 5 recent scanner events · blocked-on-tote for Outside totes. Read-only.</p>

        <div class="tr-controls">
          <!-- Left: tote textarea + Run/Export below it -->
          <div class="tr-tote-panel">
            <label class="field" style="margin-bottom:0">
              <span class="label">Totes <span class="hint" id="trCount">0</span></span>
              <textarea id="trTotes" class="tr-totes" rows="5" placeholder="TL0000002607&#10;TL0000002608&#10;TS0000019983"></textarea>
            </label>
            <div class="tr-tote-btns">
              <button id="trRunBtn" class="btn primary">▶ Run</button>
              <button id="trCsvBtn" class="btn ghost subtle">⬇ Export CSV</button>
              <span class="tr-status" id="trStatus"></span>
            </div>
          </div>

          <!-- Right: live summary stats (host + facility kept as hidden inputs) -->
          <div class="tr-side">
            <input id="trHost" type="hidden" />
            <input id="trFacility" type="hidden" value="${esc(facility)}" />
            <div class="tr-sum-box">
              <div class="tr-sum-row out"><span class="tr-sum-label">Outside Tote</span><span class="tr-sum-val" id="trSumOut">—</span></div>
              <div class="tr-sum-row on"><span class="tr-sum-label">On Location</span><span class="tr-sum-val" id="trSumOn">—</span></div>
              <div class="tr-sum-row buf"><span class="tr-sum-label">On Buffer</span><span class="tr-sum-val" id="trSumBuf">—</span></div>
              <div class="tr-sum-row bad"><span class="tr-sum-label">Bad Tracker</span><span class="tr-sum-val" id="trSumBad">—</span></div>
              <div class="tr-sum-row"><span class="tr-sum-label">No Data</span><span class="tr-sum-val" id="trSumNone">—</span></div>
              <div class="tr-sum-row tot"><span class="tr-sum-label">Total Totes</span><span class="tr-sum-val" id="trSumTotal">—</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="tr-tablewrap">
          <table class="tr-table">
            <thead><tr>
              <th>Tote</th><th>Tracker</th><th>Location</th><th>Status</th><th>Last Good Loc</th>
              <th>Blocked on Tote</th><th>Purge</th><th>Lane</th><th>Updated</th>
              <th class="tr-seg">Latest Scan</th>
              <th class="tr-seg">Scan 1</th><th>Scan 2</th><th>Scan 3</th><th>Scan 4</th><th>Scan 5</th>
            </tr></thead>
            <tbody id="trBody"></tbody>
          </table>
        </div>
      </div>`;
  }

  const setVal = (id, v) => { const e = $(id); if (e) e.textContent = v; };

  function renderSummary(rows) {
    const all    = rows || [];
    const n      = s => all.filter(r => !r.error && r.status === s).length;
    const noData = all.filter(r => r.error || !["Outside Tote","On Location","Buffer","Bad Tracker"].includes(r.status)).length;
    const dash   = all.length === 0 ? "—" : null;
    setVal("trSumOut",   dash ?? n("Outside Tote"));
    setVal("trSumOn",    dash ?? n("On Location"));
    setVal("trSumBuf",   dash ?? n("Buffer"));
    setVal("trSumBad",   dash ?? n("Bad Tracker"));
    setVal("trSumNone",  dash ?? noData);
    setVal("trSumTotal", dash ?? all.length);
  }

  function renderRows(rows) {
    _rows = rows || [];
    renderSummary(_rows);
    const tb = $("trBody");
    if (!tb) return;
    if (!_rows.length) { tb.innerHTML = `<tr><td colspan="15" class="purge-empty">No results.</td></tr>`; return; }
    tb.innerHTML = _rows.map(r => {
      if (r.error) return `<tr><td>${esc(r.tote || "")}</td><td colspan="14" class="tr-err">${esc(r.error)}</td></tr>`;
      const scans = r.scans || [];
      const isCand = r.status === "Outside Tote" || r.status === "Bad Tracker";
      let blkCell = "";
      if (isCand) {
        blkCell = (r.blocked == null)
          ? `<span class="tr-blk" title="No PID match / NexS or Concinity login needed">—</span>`
          : `<span class="tr-blk${r.blocked > 0 ? " hot" : ""}">${r.blocked}</span>`;
      }
      let pgCell = "";
      if (isCand) {
        if (r.purgeSafe == null) pgCell = `<span title="Tote not found in live inventory or ASRS dump — no PIDs to evaluate">—</span>`;
        else {
          const detail = r.purgeSafe
            ? `all PIDs in &gt;2 totes (min ${esc(r.pidToteMin)})`
            : ((r.unsafePids && r.unsafePids.length)
                ? "critical: " + r.unsafePids.map(u => `${esc(u.pid)} ×${esc(u.count)}`).join(", ")
                : `min ${esc(r.pidToteMin)} totes`);
          pgCell = `<span class="tr-pg ${r.purgeSafe ? "safe" : "unsafe"}">${r.purgeSafe ? "Safe" : "Unsafe"}</span><div class="rs tr-pgdetail">${detail}</div>`;
        }
      }
      let cells =
        `<td>${esc(r.tote)}</td>` +
        `<td>${esc(r.tracker)}</td>` +
        `<td>${esc(r.location)}</td>` +
        `<td>${badge(r.status)}</td>` +
        `<td>${esc(r.lastGood)}</td>` +
        `<td>${blkCell}</td>` +
        `<td>${pgCell}</td>` +
        `<td>${esc(r.lane)}</td>` +
        `<td>${fmt(r.updated)}</td>` +
        `<td class="tr-seg">${fmt(r.latestScan)}</td>`;
      for (let k = 0; k < 5; k++) {
        const s = scans[k];
        const seg = k === 0 ? ' class="tr-seg"' : "";
        if (s) {
          const reason = s.reason == null ? "—" : esc(s.reason);
          cells += `<td${seg} title="decision: ${esc(s.decision)}"><div class="sc">${esc(s.scanner)}</div><div class="rs">${reason}</div></td>`;
        } else cells += `<td${seg}></td>`;
      }
      return `<tr>${cells}</tr>`;
    }).join("");
  }

  function status(msg) { const el = $("trStatus"); if (el) el.textContent = msg || ""; }

  async function run() {
    if (_running) return;
    const totes = parseTotes($("trTotes").value);
    const host = ($("trHost").value || "").trim().replace(/\/+$/, "");
    const facility = ($("trFacility").value || "NXS1").trim() || "NXS1";
    localStorage.setItem(FACILITY_KEY, facility);
    if (!totes.length) { status("Enter at least one tote (TL/TS + 10 digits)."); return; }

    _running = true;
    const btn = $("trRunBtn"); if (btn) { btn.disabled = true; btn.textContent = "Running…"; }
    status(`Running ${totes.length} tote(s)…`);
    renderRows([]);

    let resp;
    try { resp = await chrome.runtime.sendMessage({ type: "TRACKER_RUN", totes, host, facility }); }
    catch (e) { resp = { ok: false, reason: e.message || String(e) }; }

    _running = false;
    if (btn) { btn.disabled = false; btn.textContent = "▶ Run"; }

    if (!resp || !resp.ok) { status("Failed: " + ((resp && resp.reason) || "unknown error")); return; }
    renderRows(resp.rows);
    const outs = resp.rows.filter(r => r.status === "Outside Tote").length;
    const bad = resp.rows.filter(r => r.status === "Bad Tracker").length;
    status(`Done — ${resp.rows.length} tote(s) · ${outs} outside · ${bad} bad tracker`);
  }

  function exportCsv() {
    if (!_rows.length) return;
    const head = ["Tote", "Tracker", "Location", "Status", "LastGoodLocation", "BlockedOnTote", "PurgeDecision", "MinPIDTotes", "UnsafePIDs", "Lane", "Updated", "LatestScan"];
    for (let k = 1; k <= 5; k++) head.push(`Scanner ${k} - Decision`);
    const cell = v => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [head.join(",")];
    _rows.forEach(r => {
      if (r.error) { lines.push([r.tote || "", r.error].map(cell).join(",")); return; }
      const scans = r.scans || [];
      const isCand = r.status === "Outside Tote" || r.status === "Bad Tracker";
      const blk = isCand ? (r.blocked == null ? "" : r.blocked) : "";
      const pg = isCand ? (r.purgeSafe == null ? "" : (r.purgeSafe ? "Safe" : "Unsafe")) : "";
      const minT = (isCand && r.pidToteMin != null) ? r.pidToteMin : "";
      const unsafe = (isCand && r.unsafePids && r.unsafePids.length) ? r.unsafePids.map(u => `${u.pid}(${u.count})`).join(" ") : "";
      const row = [r.tote, r.tracker, r.location, r.status, r.lastGood, blk, pg, minT, unsafe, r.lane, fmt(r.updated), fmt(r.latestScan)];
      for (let k = 0; k < 5; k++) { const s = scans[k]; row.push(s ? `${s.scanner}-${s.reason == null ? "" : s.reason}` : ""); }
      lines.push(row.map(cell).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tote-tracker-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  async function init() {
    const container = $("tab-tracker");
    if (!container) return;
    render(container);

    // Default host from saved config
    try {
      const { config } = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
      $("trHost").value = (config && (config.grafanaUrl || config.host)) || "https://192.168.24.230";
    } catch (e) { $("trHost").value = "https://192.168.24.230"; }

    $("trRunBtn")?.addEventListener("click", run);
    $("trCsvBtn")?.addEventListener("click", exportCsv);
    $("trTotes")?.addEventListener("input", () => { const c = $("trCount"); if (c) c.textContent = parseTotes($("trTotes").value).length; });

    chrome.runtime.onMessage.addListener(msg => {
      if (msg && msg.type === "TRACKER_PROGRESS") status(`Blocked inventory: ${msg.done}/${msg.total} PIDs…`);
    });
  }

  return { init };
})();
