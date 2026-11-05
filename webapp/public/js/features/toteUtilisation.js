// Tote Utilisation - reads the canonical NEXS ASRS Tote Dump snapshot only
// (via POST /queries/tote-utilisation -> server/features/tote-utilisation/toteUtilisationJob.js
// -> nexsAsrsDumpEngine.getCurrentSnapshot()). Never triggers its own ASRS
// fetch. Read-only - there is no "Call Tote"/"Execute"/"Dispatch" control
// anywhere in this file or the HTML it drives.
//
// The screen opens on the latest run (whoever ran it - history is site-wide) and answers "how full are the totes?"
// first: a KPI row with the change since the previous run, Large vs Small cards, how full every tote is (fill
// bands), mixed and nearly empty totes, then every tote (searchable, filterable) and the run history with a trend.
// Everything shown is computed from the run's own result - no extra reads.
const Utilisation = (() => {
  const $ = (id) => document.getElementById(id);

  const CAP_KEY = "aso_util_caps";
  const DEFAULT_CAPS = { largeLens: 300, largeFrame: 200, smallLens: 200, smallFrame: 100 }; // same as the server's (toteUtilisation.js)
  const CATS = [
    { key: "largeLens", label: "Large · Lens", size: "Large", product: "Lens", capId: "capLargeLens" },
    { key: "largeFrame", label: "Large · Frame", size: "Large", product: "Frame", capId: "capLargeFrame" },
    { key: "smallLens", label: "Small · Lens", size: "Small", product: "Lens", capId: "capSmallLens" },
    { key: "smallFrame", label: "Small · Frame", size: "Small", product: "Frame", capId: "capSmallFrame" },
  ];
  const DETAIL_CAP = 1000; // rendered rows; CSV export always covers the full set
  const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"]);

  // One fill scale for the whole screen, three colours: red = mostly empty, yellow = under-used, green = well used.
  // "full" and "over" stay separate bands (the fill filter and labels use them) but share green.
  const SCALE = [
    { key: "low", max: 0.3, color: "var(--danger)", label: "Under 30% — mostly empty" },
    { key: "mid", max: 0.5, color: "var(--ut-yellow)", label: "30–50% — under-used" },
    { key: "good", max: 0.9, color: "var(--ok)", label: "50–90% — healthy" },
    { key: "full", max: 1.0000001, color: "var(--ok)", label: "90–100% — nearly full" },
    { key: "over", max: Infinity, color: "var(--ok)", label: "Over capacity" },
  ];
  const LEGEND = [
    { color: "var(--danger)", label: "Under 30% — mostly empty" },
    { color: "var(--ut-yellow)", label: "30–50% — under-used" },
    { color: "var(--ok)", label: "50%+ — well used" },
  ];
  const bandOf = (u) => SCALE.find((b) => (u || 0) < b.max) || SCALE[SCALE.length - 1];
  const fillColor = (u) => (u == null ? "var(--muted)" : bandOf(u).color);

  let activeQueryId = null;
  let _result = null; // the result on screen (a fresh run or a loaded past run)
  let _resultMeta = null; // { queryId, createdAt, runBy }
  let _sortKey = "utilisation";
  let _sortDir = 1;
  let _history = [];
  let _autoLoaded = false; // the latest run is opened once, on arrival
  let _filters = { q: "", size: "ALL", product: "ALL", band: "ALL" };
  const _compareSelected = new Set(); // up to 2 queryIds
  const _resultCache = new Map(); // queryId -> full result

  const runBtn = $("runUtilisationBtn");
  const csvBtn = $("utilCsvBtn");
  const statusBox = $("utStatus");
  const statusPill = $("utilStatusPill");
  const statusLine = $("utilStatusLine");
  const errBox = $("utilisationError");
  const historyBody = $("utilHistoryBody");
  const historyErrBox = $("utilHistoryError");
  const compareBtn = $("utilCompareBtn");
  const comparePanel = $("utilComparePanel");
  const capsPanel = $("utCaps");
  const capsBtn = $("utCapsBtn");

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const nf = (n) => Fmt.num(n || 0);
  const pct = (u, d = 1) => (u == null ? "—" : (u * 100).toFixed(d) + "%");
  const ratio = (a, b) => (b > 0 ? a / b : null);

  // ── Capacities (saved on this browser) ─────────────────────────────────
  function loadCaps() {
    try { return { ...DEFAULT_CAPS, ...(JSON.parse(localStorage.getItem(CAP_KEY)) || {}) }; } catch (e) { return { ...DEFAULT_CAPS }; }
  }
  function saveCaps(c) {
    try { localStorage.setItem(CAP_KEY, JSON.stringify(c)); } catch (e) { /* ignore */ }
  }
  function applyCapsToUI(c) { CATS.forEach((cat) => { $(cat.capId).value = c[cat.key]; }); }
  function readCapsFromUI() {
    const c = {};
    CATS.forEach((cat) => {
      const v = parseInt($(cat.capId).value, 10);
      c[cat.key] = Number.isFinite(v) && v > 0 ? v : DEFAULT_CAPS[cat.key];
    });
    return c;
  }
  function toggleCaps(open) {
    const show = open == null ? capsPanel.hidden : open;
    capsPanel.hidden = !show;
    capsBtn.setAttribute("aria-expanded", String(show));
    if (show) $(CATS[0].capId).focus();
  }

  // ── Run ─────────────────────────────────────────────────────────────────
  function status(msg, state) {
    statusLine.textContent = msg || "";
    statusPill.textContent = state || "";
    statusPill.className = "status-pill" + (state ? " status-" + state : "");
    statusPill.hidden = !state;
    statusBox.hidden = !msg && !state;
  }
  function showError(box, msg) { box.textContent = msg; box.classList.remove("hidden"); }

  async function run() {
    errBox.classList.add("hidden");
    runBtn.disabled = true;
    const caps = readCapsFromUI();
    saveCaps(caps);
    toggleCaps(false);
    status("Reading the canonical NEXS ASRS Tote Dump snapshot…", "RUNNING");
    try {
      const query = await Api.post("/queries/tote-utilisation", { caps });
      activeQueryId = query.queryId;
      watch();
    } catch (e) {
      runBtn.disabled = false;
      status("", "");
      showError(errBox, e.message);
    }
  }

  // Progress over the live stream (topic "query:<id>"): the server pushes each status change.
  let stopWatchFn = null;
  function stopWatch() { if (stopWatchFn) { stopWatchFn(); stopWatchFn = null; } }
  function watch() {
    stopWatch();
    const watchedId = activeQueryId;
    stopWatchFn = Live.watch("query:" + watchedId, (evt) => {
      if (watchedId !== activeQueryId) return true;
      if (evt.type === "feed-error") { runBtn.disabled = false; showError(errBox, evt.message); return true; }
      if (evt.type !== "data") return false;
      const query = evt.data;
      status("Reading the canonical NEXS ASRS Tote Dump snapshot…", query.status);
      if (!TERMINAL.has(query.status)) return false;
      finishRun(query, watchedId);
      return true;
    });
  }

  async function finishRun(query, queryId) {
    runBtn.disabled = false;
    if (query.status !== "COMPLETED") {
      status("", "");
      showError(errBox, query.error || `Run ended: ${query.status}`);
      return;
    }
    try {
      const full = await fetchResultCached(queryId);
      const me = window.currentUserId ? window.currentUserId() : null;
      showResult(full, { queryId, createdAt: full.generatedAt || new Date().toISOString(), runBy: me });
      status(`Done — ${nf(full.pipeline.scanned)} rows scanned · ${nf(full.totals.totes)} totes · ${pct(full.totals.util, 2)} full`, "");
      setTimeout(() => { if (!runBtn.disabled) status("", ""); }, 6000);
      Live.refresh("tote-utilisation.history");
    } catch (e) {
      showError(errBox, e.message);
    }
  }

  // ── Result ─────────────────────────────────────────────────────────────
  function showResult(result, meta) {
    _result = result;
    _resultMeta = meta;
    csvBtn.disabled = false;
    $("utEmpty").hidden = true;
    $("utBody").hidden = false;
    renderResult();
    renderHistory();
  }

  // the run before the one on screen (history is newest first)
  function previousRun() {
    if (!_resultMeta) return null;
    const i = _history.findIndex((h) => h.queryId === _resultMeta.queryId);
    return i >= 0 ? _history[i + 1] || null : _history[0] && _history[0].queryId !== _resultMeta.queryId ? _history[0] : null;
  }
  const isLatest = () => !_history.length || !_resultMeta || _history[0].queryId === _resultMeta.queryId;

  function ring(u, size = 132, stroke = 12) {
    const R = (size - stroke) / 2, C = 2 * Math.PI * R, frac = Math.max(0, Math.min(1, u || 0));
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
      <circle cx="${size / 2}" cy="${size / 2}" r="${R}" fill="none" stroke="var(--bg-2)" stroke-width="${stroke}" />
      <circle class="ut-ring-arc" cx="${size / 2}" cy="${size / 2}" r="${R}" fill="none" stroke="${fillColor(u)}" stroke-width="${stroke}" stroke-linecap="round"
        stroke-dasharray="${(frac * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})" style="--c:${C.toFixed(1)}" />
    </svg>`;
  }

  function deltaChip(now, before, { unit = "pts", higherIsGood = true } = {}) {
    if (now == null || before == null) return `<span class="ut-delta flat">no earlier run</span>`;
    const d = unit === "pts" ? (now - before) * 100 : now - before;
    if (Math.abs(d) < (unit === "pts" ? 0.05 : 0.5)) return `<span class="ut-delta flat">→ same as last run</span>`;
    const good = higherIsGood ? d > 0 : d < 0;
    const txt = unit === "pts" ? `${Math.abs(d).toFixed(1)} pts` : nf(Math.abs(d));
    return `<span class="ut-delta ${good ? "up" : "down"}">${d > 0 ? "↑" : "↓"} ${txt} vs last run</span>`;
  }

  function renderResult() {
    const r = _result;
    if (!r) return;
    const prev = previousRun();
    const prevTotals = prev && prev.totals;

    // viewing bar: which run, by whom, which caps
    const caps = CATS.map((c) => `<span class="chip">${c.label.replace(" · ", " ")} ${nf(r.stats[c.key].capPer)}</span>`).join("");
    $("utViewing").innerHTML = `
      <span class="ut-run-badge ${isLatest() ? "latest" : "older"}">${isLatest() ? "Latest run" : "Older run"}</span>
      <b>${esc(_resultMeta.queryId || "")}</b>
      <span class="note">${_resultMeta.runBy ? "by " + esc(_resultMeta.runBy) + " · " : ""}${esc(Fmt.when(r.generatedAt || _resultMeta.createdAt))}</span>
      <span class="ut-caps-chips" title="Capacity per tote used by this run">${caps}</span>
      ${isLatest() ? "" : `<button class="ghost" id="utBackLatest"><i class="ico" data-i="refresh"></i>Back to latest</button>`}`;
    const back = $("utBackLatest");
    if (back) back.addEventListener("click", () => openRun(_history[0].queryId));

    // KPI row: the hero (ring + %) and four facts; the trend lives under Recent runs
    const free = r.totals.cap - r.totals.qty;
    $("utKpis").innerHTML = `
      <div class="ut-hero">
        <div class="ut-ring">${ring(r.totals.util)}<div class="ut-ring-c" style="color:${fillColor(r.totals.util)}">${pct(r.totals.util, 2)}</div></div>
        <div class="ut-hero-txt">
          <div class="dd-stat-k">Overall fill</div>
          ${deltaChip(r.totals.util, prevTotals && prevTotals.util)}
        </div>
      </div>
      ${kpi("Totes counted", nf(r.totals.totes), deltaChip(r.totals.totes, prevTotals && prevTotals.totes, { unit: "n", higherIsGood: true }))}
      ${kpi("Items stored", nf(r.totals.qty))}
      ${kpi("Capacity", nf(r.totals.cap))}
      ${kpi("Free space", nf(free))}`;

    renderSizes(r);
    renderBands(r);
    renderMixed(r);
    renderLow(r);
    renderDetail();
  }
  const kpi = (label, value, sub) => `<div class="dd-stat ut-kpi"><div class="dd-stat-k">${label}</div><div class="dd-stat-v">${value}</div>${sub ? `<div class="dd-stat-s">${sub}</div>` : ""}</div>`;

  // Large vs Small: one card each. A small table - column labels once, a row (+ fill bar) per product, then the
  // size total - so every count stays at reading size without repeating "totes / items / capacity" nine times.
  function renderSizes(r) {
    $("utSizes").innerHTML = ["Large", "Small"].map((size) => {
      const cats = CATS.filter((c) => c.size === size);
      const qty = cats.reduce((s, c) => s + (r.stats[c.key].qty || 0), 0);
      const cap = cats.reduce((s, c) => s + (r.stats[c.key].cap || 0), 0);
      const totes = cats.reduce((s, c) => s + (r.stats[c.key].totes || 0), 0);
      const u = ratio(qty, cap);
      const rows = cats.map((c) => {
        const s = r.stats[c.key];
        const w = Math.min(100, (s.util || 0) * 100);
        return `<div class="ut-st-row">
          <div class="ut-st-name">${c.product}<small>${nf(s.capPer)} per tote</small></div>
          <div>${nf(s.totes)}</div><div>${nf(s.qty)}</div><div>${nf(s.cap)}</div>
          <div class="ut-st-fill" style="color:${fillColor(s.util)}">${pct(s.util)}</div>
          <div class="ut-bar"><i style="width:${w.toFixed(1)}%;background:${fillColor(s.util)}"></i></div>
        </div>`;
      }).join("");
      return `<div class="panel ut-size ${size.toLowerCase()}">
        <div class="ut-size-head">
          <div class="ut-size-id"><span class="ut-size-tag">${size === "Large" ? "TL" : "TS"}</span><h3>${size} totes</h3></div>
          <div class="ut-size-v" style="color:${fillColor(u)}">${pct(u)}<small>full</small></div>
        </div>
        <div class="ut-st">
          <div class="ut-st-row ut-st-k"><div></div><div>Totes</div><div>Items</div><div>Capacity</div><div>Fill</div></div>
          ${rows}
          <div class="ut-st-row ut-st-total"><div class="ut-st-name">Total</div><div>${nf(totes)}</div><div>${nf(qty)}</div><div>${nf(cap)}</div><div class="ut-st-fill" style="color:${fillColor(u)}">${pct(u)}</div></div>
        </div></div>`;
    }).join("");
  }

  // How full is every tote: 10 % bands (+ over capacity), coloured by the scale
  function renderBands(r) {
    const detail = r.detail || [];
    // index 10 = over capacity; each band keeps its tote count and the items those totes hold
    const bins = Array.from({ length: 11 }, () => ({ n: 0, qty: 0 }));
    for (const d of detail) {
      const u = d.utilisation || 0;
      const b = bins[u > 1.0000001 ? 10 : Math.min(9, Math.floor(u * 10))];
      b.n++;
      b.qty += Number(d.quantity) || 0;
    }
    const cols = bins.slice(0, 10).map((b, i) => ({ ...b, label: `${i * 10}–${i * 10 + 10}%`, u: i / 10 + 0.05 }));
    if (bins[10].n) cols.push({ ...bins[10], label: ">100%", u: 1.5 });
    const max = Math.max(1, ...cols.map((c) => c.n));
    $("utBandsNote").textContent = `${nf(detail.length)} totes by how full they are · items held below each bar`;
    $("utBands").innerHTML = cols.map((c, i) => `
      <div class="ut-band" title="${c.label}: ${nf(c.n)} totes holding ${nf(c.qty)} items" style="--i:${i}">
        <span class="ut-band-n">${c.n ? nf(c.n) : ""}</span>
        <div class="ut-band-bar"><i style="height:${((c.n / max) * 100).toFixed(1)}%;background:${fillColor(c.u)}"></i></div>
        <span class="ut-band-k">${c.label}</span>
        <span class="ut-band-q">${c.n ? Fmt.compact(c.qty) + " items" : "—"}</span>
      </div>`).join("");
    $("utLegend").innerHTML = LEGEND.map((b) => `<span><i style="background:${b.color}"></i>${esc(b.label)}</span>`).join("");
  }

  // Mixed totes are an exception, so they only take space when there are some: a warning strip under the cards.
  function renderMixed(r) {
    const box = $("utMixedWarn");
    const n = r.mixedCount || 0;
    box.hidden = !n;
    if (!n) { box.innerHTML = ""; return; }
    const ids = r.mixed || [];
    box.innerHTML = `<div class="ut-mixed-msg"><i class="ico" data-i="alert"></i><span><b>${nf(n)} mixed tote${n === 1 ? "" : "s"}</b> — Frame and Lens in the same tote, left out of the fill numbers as a data-integrity exception.</span></div>
      <div class="chips ut-mixed-ids">${ids.slice(0, 10).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}${ids.length > 10 ? `<button class="link" id="utMixedMore">+${nf(ids.length - 10)} more</button>` : ""}</div>`;
    const more = $("utMixedMore");
    if (more) more.addEventListener("click", () => {
      box.querySelector(".ut-mixed-ids").innerHTML = ids.map((t) => `<span class="chip">${esc(t)}</span>`).join("");
    });
  }

  function renderLow(r) {
    const dist = r.distribution || {};
    const vals = [1, 2, 3, 4, 5].map((k) => dist[k] || 0);
    const max = Math.max(1, ...vals);
    const total = vals.reduce((a, b) => a + b, 0);
    const items = vals.reduce((a, v, i) => a + v * (i + 1), 0);
    const counted = r.totals.totes || 0;
    // headline first (the total is the number that matters), then the 1..5 split with each row's share
    $("utLow").innerHTML = `
      <div class="ut-low-head">
        <div class="ut-low-total">${nf(total)}<small>totes</small></div>
        <p class="note">${counted ? pct(ratio(total, counted), 1) + " of " + nf(counted) + " counted totes · " : ""}${nf(items)} items between them — candidates to consolidate</p>
      </div>
      <div class="ut-low-rows">${vals.map((v, i) => `
        <div class="ut-low-row"><span>${i + 1} item${i ? "s" : ""}</span><div class="ut-bar"><i style="width:${((v / max) * 100).toFixed(1)}%;background:var(--danger)"></i></div><b>${nf(v)}</b><em>${total ? pct(ratio(v, total)) : "—"}</em></div>`).join("")}
      </div>`;
  }

  // ── Every tote: search, size / product / fill filters, sort ────────────
  function filteredDetail() {
    const q = _filters.q.trim().toUpperCase();
    return (_result.detail || []).filter((d) =>
      (!q || String(d.toteId).toUpperCase().includes(q)) &&
      (_filters.size === "ALL" || d.toteType === _filters.size) &&
      (_filters.product === "ALL" || d.productType === _filters.product) &&
      (_filters.band === "ALL" || bandOf(d.utilisation).key === _filters.band || (_filters.band === "full" && bandOf(d.utilisation).key === "over"))
    );
  }
  function renderDetail() {
    if (!_result) return;
    const rows = filteredDetail().sort((a, b) => (a[_sortKey] - b[_sortKey]) * _sortDir);
    const shown = rows.slice(0, DETAIL_CAP);
    const all = (_result.detail || []).length;
    $("utilDetailNote").textContent = rows.length > DETAIL_CAP
      ? `showing ${nf(DETAIL_CAP)} of ${nf(rows.length)} matching — the CSV export has all ${nf(all)}`
      : `${nf(rows.length)} of ${nf(all)} totes`;
    $("utilDetailBody").innerHTML = shown.map((d) => {
      const w = Math.min(100, (d.utilisation || 0) * 100);
      return `<tr>
        <td><b>${esc(d.toteId)}</b></td>
        <td><span class="ut-size-tag sm">${d.toteType === "Large" ? "TL" : "TS"}</span>${esc(d.toteType)}</td>
        <td>${esc(d.productType)}</td>
        <td class="num">${nf(d.quantity)}</td>
        <td class="num">${nf(d.capacity)}</td>
        <td><div class="ut-cell-fill"><div class="ut-bar sm"><i style="width:${w.toFixed(1)}%;background:${fillColor(d.utilisation)}"></i></div><b style="color:${fillColor(d.utilisation)}">${pct(d.utilisation)}</b></div></td>
      </tr>`;
    }).join("") || `<tr><td colspan="6" class="purge-empty">No totes match these filters.</td></tr>`;
    const setSort = (id, key) => {
      const th = $(id);
      const on = _sortKey === key;
      th.setAttribute("aria-sort", on ? (_sortDir === 1 ? "ascending" : "descending") : "none");
      th.querySelector(".ico").dataset.i = on && _sortDir === -1 ? "chevdown" : "chevup";
      th.classList.toggle("sorted", on);
    };
    setSort("utilSortQty", "quantity");
    setSort("utilSortUtil", "utilisation");
  }
  function toggleSort(key) {
    if (_sortKey === key) _sortDir *= -1; else { _sortKey = key; _sortDir = 1; }
    renderDetail();
  }
  function wireSeg(id, field) {
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest("[data-v]");
      if (!b) return;
      _filters[field] = b.dataset.v;
      $(id).querySelectorAll("[data-v]").forEach((x) => x.classList.toggle("active", x === b));
      renderDetail();
    });
  }

  // ── CSV export (always the full, uncapped detail set) ─────────────────
  const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function dl(content, filename, mime) {
    const blob = new Blob([content], { type: mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  function exportCsv() {
    if (!_result) return;
    const r = _result;
    const lines = [];
    lines.push(`# Tote Utilisation — ${_resultMeta && _resultMeta.queryId ? _resultMeta.queryId : "run"} — generated ${r.generatedAt || ""}`);
    lines.push("");
    lines.push("CATEGORY SUMMARY");
    lines.push(["Category", "Totes", "Capacity/Tote", "Total Capacity", "Quantity", "Utilisation %"].join(","));
    CATS.forEach((c) => {
      const s = r.stats[c.key];
      lines.push([c.label, s.totes, s.capPer, s.cap, s.qty, (s.util * 100).toFixed(2)].map(csvCell).join(","));
    });
    lines.push(["Total", r.totals.totes, "-", r.totals.cap, r.totals.qty, (r.totals.util * 100).toFixed(2)].map(csvCell).join(","));
    lines.push("");
    lines.push(`Mixed Totes Found,${r.mixedCount}`);
    if (r.mixedCount) lines.push("Mixed IDs," + csvCell((r.mixed || []).join(" ")));
    lines.push("");
    lines.push("QUANTITY DISTRIBUTION");
    [1, 2, 3, 4, 5].forEach((k) => lines.push([`Tote with ${k} item(s)`, (r.distribution || {})[k] || 0].join(",")));
    lines.push("");
    lines.push("PER-TOTE DETAIL");
    lines.push(["Tote ID", "Type", "Product", "Quantity", "Capacity", "Utilisation %"].join(","));
    (r.detail || []).forEach((d) => lines.push([d.toteId, d.toteType, d.productType, d.quantity, d.capacity, (d.utilisation * 100).toFixed(2)].map(csvCell).join(",")));
    dl(lines.join("\n"), `tote-utilisation-${stamp()}.csv`, "text/csv");
  }

  // ── History, trend, comparison ─────────────────────────────────────────
  // Pushed by the server (topic "tote-utilisation.history", site-wide) whenever any run completes.
  let historyOff = null;
  function start() {
    if (historyOff) return;
    historyOff = Live.subscribe("tote-utilisation.history", (evt) => {
      if (evt.type === "data") {
        historyErrBox.classList.add("hidden");
        _history = evt.data || [];
        renderHistory();
        if (!_autoLoaded && !_result && !runBtn.disabled) {
          _autoLoaded = true;
          if (_history.length) openRun(_history[0].queryId, { quiet: true });
          else { $("utEmptyTitle").textContent = "No runs yet"; $("utEmptyText").textContent = "Press Run now to measure how full the totes are."; }
        } else if (_result) renderResult(); // the delta / "latest" badge follow new runs
      } else if (evt.type === "feed-error" && !_history.length) {
        showError(historyErrBox, evt.message);
      }
    });
  }
  function stop() { if (historyOff) { historyOff(); historyOff = null; } }

  function renderTrend() {
    const pts = _history.slice().reverse().filter((h) => h.totals);
    const box = $("utTrend");
    if (pts.length < 2) { box.innerHTML = ""; return; }
    const W = 600, H = 96, pad = 8;
    const vals = pts.map((h) => h.totals.util * 100);
    const lo = Math.max(0, Math.floor(Math.min(...vals) - 1)), hi = Math.min(100, Math.ceil(Math.max(...vals) + 1));
    const x = (i) => pad + (i * (W - pad * 2)) / (pts.length - 1);
    const y = (v) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - pad * 2);
    const line = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const cur = _resultMeta ? pts.findIndex((h) => h.queryId === _resultMeta.queryId) : -1;
    box.innerHTML = `
      <div class="ut-trend-meta"><span class="dd-stat-k">Overall fill over the last ${pts.length} runs</span><span class="note">${lo}%–${hi}%</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <polygon points="${pad},${H - pad} ${line} ${W - pad},${H - pad}" fill="var(--accent)" opacity="0.08" />
        <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
      </svg>
      <div class="ut-trend-pts">${pts.map((h, i) => `<button type="button" class="ut-pt${i === cur ? " on" : ""}" data-q="${esc(h.queryId)}" style="left:${((x(i) / W) * 100).toFixed(2)}%;top:${((y(vals[i]) / H) * 100).toFixed(2)}%;--c:${fillColor(h.totals.util)}" title="${esc(h.queryId)} · ${esc(Fmt.when(h.createdAt))} · ${pct(h.totals.util, 2)}"></button>`).join("")}</div>`;
  }

  function renderHistory() {
    renderTrend();
    const cur = _resultMeta && _resultMeta.queryId;
    historyBody.innerHTML = _history.map((h, i) => {
      const checked = _compareSelected.has(h.queryId) ? "checked" : "";
      const u = h.totals ? h.totals.util : null;
      return `<tr class="${h.queryId === cur ? "ut-row-on" : ""}">
        <td class="ut-cb-col"><input type="checkbox" class="util-compare-cb" data-query-id="${esc(h.queryId)}" ${checked} aria-label="Compare ${esc(h.queryId)}" /></td>
        <td><b>${esc(h.queryId)}</b>${i === 0 ? ' <span class="ut-run-badge latest sm">Latest</span>' : ""}</td>
        <td class="when">${esc(Fmt.when(h.createdAt))}</td>
        <td>${esc(h.runBy || "—")}</td>
        <td class="num">${h.totals ? nf(h.totals.totes) : "—"}</td>
        <td><div class="ut-cell-fill"><div class="ut-bar sm"><i style="width:${Math.min(100, (u || 0) * 100).toFixed(1)}%;background:${fillColor(u)}"></i></div><b style="color:${fillColor(u)}">${pct(u, 2)}</b></div></td>
        <td class="num">${h.mixedCount != null ? nf(h.mixedCount) : "—"}</td>
        <td>${h.queryId === cur ? '<span class="note">On screen</span>' : `<button class="ghost ut-open" data-query-id="${esc(h.queryId)}">Open</button>`}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="8" class="purge-empty">No runs yet — press Run now.</td></tr>`;
  }

  async function fetchResultCached(queryId) {
    if (_resultCache.has(queryId)) return _resultCache.get(queryId);
    const full = await Api.get(`/queries/${queryId}/result`);
    _resultCache.set(queryId, full);
    return full;
  }

  async function openRun(queryId, { quiet = false } = {}) {
    historyErrBox.classList.add("hidden");
    try {
      const full = await fetchResultCached(queryId);
      const meta = _history.find((h) => h.queryId === queryId) || { queryId };
      showResult(full, meta);
      comparePanel.hidden = true;
      if (!quiet) $("utViewing").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      if (!_result) { $("utEmptyTitle").textContent = "Couldn't open the latest run"; $("utEmptyText").textContent = e.message; }
      showError(historyErrBox, e.message);
    }
  }

  function onCompareToggle(cb) {
    const id = cb.dataset.queryId;
    if (cb.checked) {
      if (_compareSelected.size >= 2) {
        cb.checked = false;
        showError(historyErrBox, "Only two runs can be compared at once — untick one first.");
        return;
      }
      historyErrBox.classList.add("hidden");
      _compareSelected.add(id);
    } else {
      _compareSelected.delete(id);
    }
    compareBtn.disabled = _compareSelected.size !== 2;
  }

  async function compareSelected() {
    if (_compareSelected.size !== 2) return;
    // older run on the left (A), newer on the right (B)
    const order = (id) => _history.findIndex((h) => h.queryId === id);
    const [idA, idB] = [..._compareSelected].sort((a, b) => order(b) - order(a));
    historyErrBox.classList.add("hidden");
    try {
      const [A, B] = await Promise.all([fetchResultCached(idA), fetchResultCached(idB)]);
      const metaA = _history.find((h) => h.queryId === idA) || {}, metaB = _history.find((h) => h.queryId === idB) || {};
      const row = (label, a, b, kind) => {
        const isPct = kind === "pct";
        const fmt = (v) => (v == null ? "—" : isPct ? pct(v, 2) : nf(v));
        let chip = "";
        if (a != null && b != null) {
          const d = isPct ? (b - a) * 100 : b - a;
          const flat = Math.abs(d) < (isPct ? 0.05 : 0.5);
          const cls = flat || kind === "n" ? "flat" : d > 0 ? "up" : "down";
          chip = `<span class="ut-delta ${cls}">${flat ? "→ same" : (d > 0 ? "↑ " : "↓ ") + (isPct ? Math.abs(d).toFixed(2) + " pts" : nf(Math.abs(d)))}</span>`;
        }
        return `<tr><td>${esc(label)}</td><td class="num">${fmt(a)}</td><td class="num">${fmt(b)}</td><td>${chip}</td></tr>`;
      };
      const head = (m, id, r, tag) => `<div class="ut-cmp-card"><span class="ut-run-badge ${tag === "B" ? "latest" : "older"}">${tag === "A" ? "Earlier" : "Later"}</span><b>${esc(id)}</b><span class="note">${esc(Fmt.when(m.createdAt))}${m.runBy ? " · " + esc(m.runBy) : ""}</span><div class="ut-cmp-v" style="color:${fillColor(r.totals.util)}">${pct(r.totals.util, 2)}</div></div>`;
      $("utCompare").innerHTML = `
        <div class="ut-cmp-heads">${head(metaA, idA, A, "A")}<div class="ut-cmp-arrow">→</div>${head(metaB, idB, B, "B")}</div>
        <div class="ut-table-wrap"><table>
          <thead><tr><th>Metric</th><th class="num">Earlier</th><th class="num">Later</th><th>Change</th></tr></thead>
          <tbody>
            ${row("Overall fill", A.totals.util, B.totals.util, "pct")}
            ${CATS.map((c) => row(`${c.label} fill`, A.stats[c.key].util, B.stats[c.key].util, "pct")).join("")}
            ${row("Totes counted", A.totals.totes, B.totals.totes, "n")}
            ${row("Items stored", A.totals.qty, B.totals.qty, "n")}
            ${row("Total capacity", A.totals.cap, B.totals.cap, "n")}
            ${row("Mixed totes", A.mixedCount, B.mixedCount, "n")}
            ${row("Rows scanned", A.pipeline.scanned, B.pipeline.scanned, "n")}
            ${row("Excluded (non-tote)", A.pipeline.excludedNonTote, B.pipeline.excludedNonTote, "n")}
          </tbody></table></div>`;
      comparePanel.hidden = false;
      comparePanel.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      showError(historyErrBox, e.message);
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  runBtn.addEventListener("click", run);
  $("utCapsRunBtn").addEventListener("click", run);
  capsBtn.addEventListener("click", () => toggleCaps());
  $("utilResetCapsBtn").addEventListener("click", () => {
    applyCapsToUI(DEFAULT_CAPS);
    saveCaps({ ...DEFAULT_CAPS });
    status("Capacities reset to defaults.", "");
  });
  csvBtn.addEventListener("click", exportCsv);
  $("utilHistoryRefreshBtn").addEventListener("click", () => Live.refresh("tote-utilisation.history"));
  compareBtn.addEventListener("click", compareSelected);
  $("utCompareClose").addEventListener("click", () => { comparePanel.hidden = true; });
  $("utilSortQty").addEventListener("click", () => toggleSort("quantity"));
  $("utilSortUtil").addEventListener("click", () => toggleSort("utilisation"));
  $("utDetailSearch").addEventListener("input", (e) => { _filters.q = e.target.value; renderDetail(); });
  wireSeg("utSizeSeg", "size");
  wireSeg("utProdSeg", "product");
  wireSeg("utBandSeg", "band");
  historyBody.addEventListener("click", (e) => {
    const b = e.target.closest(".ut-open");
    if (b) openRun(b.dataset.queryId);
  });
  historyBody.addEventListener("change", (e) => { if (e.target.matches(".util-compare-cb")) onCompareToggle(e.target); });
  $("utTrend").addEventListener("click", (e) => {
    const p = e.target.closest(".ut-pt");
    if (p) openRun(p.dataset.q);
  });

  applyCapsToUI(loadCaps());

  return { start, stop };
})();
