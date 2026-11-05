// Locked Tote Information - read-only, analysis-only. Never renders a checkbox, row action, or link into
// Manual/Auto pulling - this panel cannot cause a Quadron mutation, by construction of what it puts in the DOM
// as much as by what the backend routes allow (see server/features/locked-tote-info/).
//
// Layout: tiles per priority (click to filter), a priority x age grid and an aisle table (click a cell / an
// aisle to filter), then every locked tote with one search box and priority / age filters, and the past
// snapshots folded at the bottom. Everything is worked out here from the one snapshot the server sends.
const LockedToteInformation = (() => {
  let _last = null; // the full current snapshot (from refresh(), /current, or a history row)
  let sortKey = null;
  let sortDir = 1; // 1 asc, -1 desc
  let _refreshing = false; // our own refresh request is in flight
  let _failed = false; // the last refresh or live fetch failed (last good snapshot, if any, is stale)
  let _noSnapshot = false; // the server has never produced a snapshot
  const filter = { priority: "", age: "", aisle: "", q: "" };

  const $ = (id) => document.getElementById(id);
  const refreshBtn = $("ltiRefreshBtn");
  const freshEl = $("ltiFreshness");
  const emptyEl = $("ltiEmpty");
  const refreshedAtEl = $("ltiRefreshedAt");
  const factsEl = $("ltiFactsLine");
  const degradedNoteEl = $("ltiDegradedNote");
  const errBox = $("ltiError");
  const overviewPanel = $("ltiOverviewPanel");
  const dumpPanel = $("ltiDumpPanel");
  const dumpNoteEl = $("ltiDumpNote");
  const dumpTable = $("ltiDumpTable");
  const historyPanel = $("ltiHistoryPanel");
  const historyTable = $("ltiHistoryTable");

  const CAP = 1000;
  const PRIORITIES = ["SD", "P0", "P1", "P2"];
  const PRIORITY_ORDER = { SD: 0, P0: 1, P1: 2, P2: 3 };
  const P_LABEL = { SD: "Supervisor", P0: "P0 Critical", P1: "P1 High", P2: "P2 Standard" };
  const UNCONFIRMED = "NQ"; // the "Not in Quadron" list: in the Locked Tote Dump, but Quadron does not hold it with stock
  const VERDICT = { MATCH: "In Quadron", EMPTY_IN_QUADRON: "Empty in Quadron", MISSING_IN_QUADRON: "Not in Quadron" };
  const P_COLOUR = { SD: "var(--purple)", P0: "var(--danger)", P1: "var(--warn)", P2: "var(--blue)" };
  const HOUR = 3600000;
  const AGES = [
    { key: "d1", label: "Under 1 day", short: "< 1 d", max: 24 * HOUR },
    { key: "d3", label: "1-3 days", short: "1-3 d", max: 72 * HOUR },
    { key: "d7", label: "3-7 days", short: "3-7 d", max: 168 * HOUR },
    { key: "d30", label: "7-30 days", short: "7-30 d", max: 720 * HOUR },
    { key: "old", label: "Over 30 days", short: "30 d +", max: Infinity },
  ];

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const nf = (n) => (n == null ? "—" : Fmt.num(n));

  function status(msg, isErr) {
    errBox.textContent = isErr ? msg : "";
    errBox.classList.toggle("hidden", !isErr);
  }

  // ── tote facts worked out from the snapshot ─────────────────────────────
  const ageMs = (t) => { const ms = Date.now() - new Date(t.lockedSince).getTime(); return Number.isFinite(ms) && ms >= 0 ? ms : null; };
  const ageBucket = (t) => { const ms = ageMs(t); return ms == null ? null : AGES.find((a) => ms < a.max).key; };
  const aisleOf = (t) => { const m = /aisle_?0*(\d+)/i.exec(String(t.zone || "")); return m ? m[1] : null; };
  function lockedFor(ms) {
    if (ms == null) return "";
    const m = Math.floor(ms / 60000);
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    return h < 48 ? h + "h " + (m % 60) + "m" : Math.floor(h / 24) + "d " + (h % 24) + "h";
  }
  const ageTone = (ms) => (ms == null ? "" : ms >= 168 * HOUR ? "old" : ms >= 72 * HOUR ? "mid" : "");

  // ── Freshness (DESIGN.md §9.1) - one badge, derived from the state flags above ─────────────────
  function paintFreshness() {
    const past = _last && _currentQueryId && _last.queryId !== _currentQueryId; // a History row, not the current run
    const at = _last && _last.generatedAt;
    const src = "Grafana locked totes, Supervisor dump, Quadron inventory";
    const announce = "Locked totes";
    let stale = false;
    if (_refreshing) Freshness.mount(freshEl, { announce, state: "refreshing" });
    else if (!_last && _noSnapshot) Freshness.mount(freshEl, { announce, state: "neutral", label: "No snapshot yet" });
    else if (!_last && _failed) Freshness.mount(freshEl, { announce, state: "unavailable", reason: "Locked tote refresh failed", source: src });
    else if (!_last) Freshness.mount(freshEl, { announce, state: "refreshing" });
    else if (past) Freshness.mount(freshEl, { announce, state: "neutral", label: "Past snapshot · " + Fmt.time(at), at, source: src });
    else if (_failed) { stale = true; Freshness.mount(freshEl, { announce, state: "stale", at, source: src }); }
    else Freshness.mount(freshEl, { announce, state: "live", at, source: src, cadence: "Updates when a refresh completes" });
    overviewPanel.classList.toggle("is-stale", stale);
    dumpPanel.classList.toggle("is-stale", stale);
  }

  function renderDegradedNote(snapshot) {
    const notes = [];
    if (snapshot.degraded.supervisor) notes.push(`Supervisor Dump unavailable this refresh (${snapshot.degradedReasons.supervisor || "unknown reason"}) — SD classification may be incomplete.`);
    if (snapshot.degraded.inventory) notes.push(`This is an older snapshot taken while Quadron Inventory was unavailable (${snapshot.degradedReasons.inventory || "unknown reason"}) — its totes were not confirmed by Quadron and default toward P2.`);
    degradedNoteEl.textContent = notes.join(" ");
    degradedNoteEl.className = notes.length ? "note mt-total-warn" : "note";
  }

  const unconfirmedOf = () => (_last && _last.unconfirmed) || [];

  function renderFacts() {
    const s = _last.summary;
    const quadron = _last.unconfirmed ? `Quadron confirmed ${nf(s.total)} of ${nf(s.lockedCount)} in the Locked Tote Dump` : "not confirmed by Quadron (older snapshot)";
    factsEl.textContent = `${quadron} · Supervisor dump ${nf(s.supervisorRawCount)} rows, ${nf(s.supervisorIntersectedCount)} locked (SD)`;
  }

  // ── overview: tiles, priority x age, aisles ─────────────────────────────
  function renderOverview() {
    overviewPanel.style.display = "";
    const s = _last.summary;
    const ages = _last.totes.map(ageMs).filter((v) => v != null).sort((a, b) => a - b);
    const oldest = ages.length ? ages[ages.length - 1] : null;
    const median = ages.length ? ages[ages.length >> 1] : null;
    const count = { SD: s.sdCount, P0: s.p0Count, P1: s.p1Count, P2: s.p2Count };
    const tile = (p) => `<button type="button" class="ot-kpi lti-tile${filter.priority === p ? " active" : ""}" data-p="${p}" style="--c:${P_COLOUR[p]}"><span>${P_LABEL[p]}</span><b>${nf(count[p])}</b><small>${s.total ? Math.round((count[p] / s.total) * 100) : 0}% of locked</small></button>`;
    $("ltiKpis").innerHTML =
      `<button type="button" class="ot-kpi lti-tile${!filter.priority ? " active" : ""}" data-p="" style="--c:var(--text)"><span>Locked totes</span><b>${nf(s.total)}</b><small>${nf(s.totalInventory)} units inside</small></button>` +
      PRIORITIES.map(tile).join("") +
      `<button type="button" class="ot-kpi lti-tile${filter.priority === UNCONFIRMED ? " active" : ""}" data-p="${UNCONFIRMED}" style="--c:var(--muted)"><span>Not in Quadron</span><b>${nf(unconfirmedOf().length)}</b><small>in the dump, not counted</small></button>` +
      `<div class="ot-kpi" style="--c:var(--warn)"><span>Oldest lock</span><b>${oldest == null ? "—" : lockedFor(oldest)}</b><small>half are locked over ${median == null ? "—" : lockedFor(median)}</small></div>`;

    // priority x age: count per cell, tinted by its share of the busiest cell
    const grid = {};
    for (const p of PRIORITIES) grid[p] = Object.fromEntries(AGES.map((a) => [a.key, 0]));
    for (const t of _last.totes) { const b = ageBucket(t); if (b && grid[t.priority]) grid[t.priority][b]++; }
    const max = Math.max(1, ...PRIORITIES.flatMap((p) => AGES.map((a) => grid[p][a.key])));
    const cell = (p, a, n) => `<td class="lti-cell${filter.priority === p && filter.age === a ? " active" : ""}" data-p="${p}" data-a="${a}" style="--h:${(n / max).toFixed(3)};--c:${P_COLOUR[p]}">${n ? nf(n) : '<span class="lti-zero">0</span>'}</td>`;
    const colTotal = (a) => PRIORITIES.reduce((acc, p) => acc + grid[p][a], 0);
    $("ltiAgeGrid").innerHTML =
      `<thead><tr><th class="lti-l">Priority</th>${AGES.map((a) => `<th>${a.short}</th>`).join("")}<th>Total</th></tr></thead><tbody>` +
      PRIORITIES.map((p) => `<tr><td class="lti-l"><span class="lti-dot" style="--c:${P_COLOUR[p]}"></span>${P_LABEL[p]}</td>${AGES.map((a) => cell(p, a.key, grid[p][a.key])).join("")}<td class="lti-t">${nf(count[p])}</td></tr>`).join("") +
      `<tr class="lti-sum"><td class="lti-l">All</td>${AGES.map((a) => `<td class="lti-cell${!filter.priority && filter.age === a.key ? " active" : ""}" data-p="" data-a="${a.key}">${nf(colTotal(a.key))}</td>`).join("")}<td class="lti-t">${nf(s.total)}</td></tr></tbody>`;

    // aisles
    const aisles = new Map();
    for (const t of _last.totes) {
      const k = aisleOf(t) || "?";
      if (!aisles.has(k)) aisles.set(k, { aisle: k, SD: 0, P0: 0, P1: 0, P2: 0, total: 0, units: 0 });
      const a = aisles.get(k);
      a[t.priority] = (a[t.priority] || 0) + 1;
      a.total++;
      a.units += Number(t.totalToteInv) || 0;
    }
    const rows = [...aisles.values()].sort((x, y) => (x.aisle === "?" ? 1 : y.aisle === "?" ? -1 : Number(x.aisle) - Number(y.aisle)));
    const top = Math.max(1, ...rows.map((r) => r.total));
    $("ltiAisleGrid").innerHTML =
      `<thead><tr><th class="lti-l">Aisle</th>${PRIORITIES.map((p) => `<th>${p}</th>`).join("")}<th>Total</th><th class="lti-barcol"></th><th>Units</th></tr></thead><tbody>` +
      rows.map((r) => `<tr class="lti-aisle${filter.aisle === r.aisle ? " active" : ""}" data-aisle="${esc(r.aisle)}"><td class="lti-l"><b>${r.aisle === "?" ? "Unknown" : "Aisle " + esc(r.aisle)}</b></td>${PRIORITIES.map((p) => `<td class="${p === "P0" && r.P0 ? "lti-p0" : ""}">${r[p] ? nf(r[p]) : '<span class="lti-zero">0</span>'}</td>`).join("")}<td class="lti-t">${nf(r.total)}</td><td class="lti-barcol"><span class="lti-bar"><i style="width:${((r.total / top) * 100).toFixed(1)}%"></i></span></td><td>${nf(r.units)}</td></tr>`).join("") +
      `</tbody>`;
  }

  // ── the tote list ───────────────────────────────────────────────────────
  function applyFilters(totes) {
    const q = filter.q.trim().toLowerCase();
    return totes.filter((t) => {
      if (filter.priority && filter.priority !== UNCONFIRMED && t.priority !== filter.priority) return false;
      if (filter.age && ageBucket(t) !== filter.age) return false;
      if (filter.aisle && (aisleOf(t) || "?") !== filter.aisle) return false;
      if (q) {
        const hay = [t.toteId, t.location, t.tracker, t.zone, t.shuttle, t.worstPid].map((v) => String(v || "").toLowerCase()).join(" ");
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function applySort(totes) {
    if (!sortKey) return [...totes].sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) || (ageMs(b) || 0) - (ageMs(a) || 0)); // priority, then oldest first
    const val = (t) => (sortKey === "priority" ? PRIORITY_ORDER[t.priority] ?? 99 : sortKey === "age" ? ageMs(t) : t[sortKey]);
    return [...totes].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls/unavailable sort last regardless of direction
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
      return String(av).localeCompare(String(bv)) * sortDir;
    });
  }

  const COLUMNS = [
    { key: "toteId", label: "Tote" },
    { key: "priority", label: "Priority" },
    { key: "age", label: "Locked for", num: true },
    { key: "zone", label: "Zone" },
    { key: "location", label: "Location" },
    { key: "shuttle", label: "Shuttle" },
    { key: "quadronQty", label: "Quadron qty", num: true },
    { key: "worstPid", label: "Scarcest PID" },
    { key: "reason", label: "Reason" },
  ];

  function renderDump() {
    if (!_last) return;
    dumpPanel.style.display = "";
    const nq = filter.priority === UNCONFIRMED;
    const pool = nq ? unconfirmedOf() : _last.totes;
    const filtered = applySort(applyFilters(pool));
    const shown = filtered.slice(0, CAP);
    dumpNoteEl.textContent = (nq ? "Not in Quadron - not counted as locked · " : "") + (filtered.length > CAP ? `first ${CAP} of ${filtered.length} - export for all` : `${nf(filtered.length)} of ${nf(pool.length)}`);
    const head = `<thead><tr>${COLUMNS.map((c) => {
      const arrow = sortKey === c.key ? ` <i class="ico" data-i="${sortDir === 1 ? "chevup" : "chevdown"}"></i>` : "";
      return `<th class="sortable${sortKey === c.key ? " sort-active" : ""}${c.num ? " num" : ""}" data-sort="${c.key}">${c.label}${arrow}</th>`;
    }).join("")}${nq ? "<th>Quadron</th>" : ""}</tr></thead>`;
    const val = (x) => (x == null || x === "" ? '<span class="lti-zero">—</span>' : esc(x));
    const rows = shown.map((t) => {
      const ms = ageMs(t);
      return `<tr><td><b>${esc(t.toteId)}</b></td>` +
        `<td><span class="lti-pill" style="--c:${P_COLOUR[t.priority] || "var(--muted)"}">${esc(t.priority)}</span></td>` +
        `<td class="num"><span class="lti-age ${ageTone(ms)}" title="${t.lockedSince ? "locked since " + esc(Fmt.when(t.lockedSince)) : ""}">${ms == null ? "—" : lockedFor(ms)}</span></td>` +
        `<td>${val(t.zone)}</td><td>${val(t.location)}</td><td>${val(t.shuttle)}</td>` +
        `<td class="num">${nf(t.quadronQty != null ? t.quadronQty : t.totalToteInv)}</td>` +
        `<td>${t.worstPid ? `${esc(t.worstPid)}${t.scarcityCount != null ? ` <span class="lti-sub">in ${esc(t.scarcityCount)} tote${t.scarcityCount === 1 ? "" : "s"}</span>` : ""}` : '<span class="lti-zero">—</span>'}</td>` +
        `<td class="lti-reason" title="${esc(t.reason)} · ${esc(t.source)}">${val(t.reason)}</td>` +
        (nq ? `<td><span class="lti-verdict">${esc(VERDICT[t.quadronVerdict] || t.quadronVerdict || "")}</span></td>` : "") + `</tr>`;
    }).join("");
    const emptyRow = nq && !pool.length ? "Quadron confirmed every tote in the Locked Tote Dump." : pool.length
      ? `No locked totes match these filters. <button class="link" data-clear-filters>Clear filters</button>`
      : `No locked totes in this snapshot. Checked at ${Fmt.time(_last.generatedAt)}.`;
    dumpTable.innerHTML = head + `<tbody>${rows || `<tr><td colspan="${COLUMNS.length + 1}" class="lti-none">${emptyRow}</td></tr>`}</tbody>`;
  }

  // one place that sets the filters and repaints what shows them
  function setFilter(next) {
    Object.assign(filter, next);
    $("ltiPrioritySeg").querySelectorAll("[data-v]").forEach((b) => b.classList.toggle("active", b.dataset.v === filter.priority || (filter.priority === UNCONFIRMED && b.dataset.v === "")));
    $("ltiAgeSeg").querySelectorAll("[data-v]").forEach((b) => b.classList.toggle("active", b.dataset.v === filter.age));
    const chip = $("ltiAisleChip");
    chip.classList.toggle("hidden", !filter.aisle);
    chip.innerHTML = filter.aisle ? `${filter.aisle === "?" ? "Unknown aisle" : "Aisle " + esc(filter.aisle)} <button type="button" class="link" data-clear-aisle aria-label="Clear aisle">✕</button>` : "";
    if (_last) { renderOverview(); renderDump(); }
  }

  $("ltiAgeSeg").innerHTML = `<button type="button" data-v="" class="active">Any age</button>` + AGES.map((a) => `<button type="button" data-v="${a.key}">${a.short}</button>`).join("");
  $("ltiPrioritySeg").addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b) setFilter({ priority: b.dataset.v }); });
  $("ltiAgeSeg").addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b) setFilter({ age: b.dataset.v }); });
  $("ltiAisleChip").addEventListener("click", (e) => { if (e.target.closest("[data-clear-aisle]")) setFilter({ aisle: "" }); });
  $("ltiSearch").addEventListener("input", () => { filter.q = $("ltiSearch").value; renderDump(); });
  const jumpToList = () => dumpPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  $("ltiKpis").addEventListener("click", (e) => { const b = e.target.closest("[data-p]"); if (b) setFilter({ priority: b.dataset.p, age: "", aisle: "" }); });
  $("ltiAgeGrid").addEventListener("click", (e) => { const c = e.target.closest("[data-a]"); if (c) { setFilter({ priority: c.dataset.p, age: c.dataset.a, aisle: "" }); jumpToList(); } });
  $("ltiAisleGrid").addEventListener("click", (e) => { const r = e.target.closest("[data-aisle]"); if (r) { setFilter({ aisle: filter.aisle === r.dataset.aisle ? "" : r.dataset.aisle }); jumpToList(); } });

  dumpTable.addEventListener("click", (e) => {
    if (e.target.closest("[data-clear-filters]")) {
      $("ltiSearch").value = "";
      setFilter({ priority: "", age: "", aisle: "", q: "" });
      return;
    }
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const key = th.dataset.sort;
    if (sortKey === key) sortDir = -sortDir;
    else { sortKey = key; sortDir = key === "age" || key === "totalToteInv" ? -1 : 1; }
    renderDump();
  });

  // ── Render a whole snapshot (from refresh(), /current, or history) ─────
  function renderSnapshot(snapshot) {
    _last = snapshot;
    _noSnapshot = false;
    emptyEl.classList.add("hidden");
    refreshedAtEl.textContent = `Refreshed ${Fmt.when(snapshot.generatedAt)}${snapshot.refreshedBy ? ` by ${snapshot.refreshedBy}` : ""}`;
    paintFreshness();
    renderDegradedNote(snapshot);
    renderFacts();
    sortKey = null;
    renderOverview();
    renderDump();
  }

  // ── Refresh (real Query Manager operation - LOCKED_TOTE_INFO_REFRESH,
  // visible in Active Queries; blocking single response, no polling) ─────
  async function refresh() {
    status("", false);
    refreshBtn.disabled = true;
    _refreshing = true;
    paintFreshness();
    try {
      const snapshot = await Api.post("/locked-tote-info/refresh");
      _currentQueryId = snapshot.queryId; // our own refresh is now "current" (the live feed will confirm it)
      _failed = false;
      renderSnapshot(snapshot);
      Live.refresh("locked-tote-info.history");
    } catch (e) {
      status(e.message, true);
      _failed = true;
    } finally {
      _refreshing = false;
      paintFreshness();
      refreshBtn.disabled = false;
    }
  }

  // ── History (lightweight list; "Open" loads one past run into the screen - read-only) ───
  function renderHistory(rows) {
    historyPanel.style.display = "";
    const head = `<thead><tr><th>Refreshed</th><th>By</th><th class="num">Total</th><th class="num">SD</th><th class="num">P0</th><th class="num">P1</th><th class="num">P2</th><th></th></tr></thead>`;
    const body = rows.length
      ? rows.map((r) => {
          const s = r.summary || {};
          return `<tr><td class="when">${esc(Fmt.when(r.createdAt))}</td><td>${esc(r.refreshedBy)}</td>` +
            `<td class="num"><b>${s.total ?? "—"}</b></td><td class="num">${s.sdCount ?? "—"}</td><td class="num">${s.p0Count ?? "—"}</td>` +
            `<td class="num">${s.p1Count ?? "—"}</td><td class="num">${s.p2Count ?? "—"}</td>` +
            `<td><button class="link" data-view-history="${esc(r.queryId)}">Open</button></td></tr>`;
        }).join("")
      : `<tr><td colspan="8" class="lti-none">No past refreshes yet.</td></tr>`;
    historyTable.innerHTML = head + `<tbody>${body}</tbody>`;
  }

  historyTable.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-view-history]");
    if (!btn) return;
    try {
      const snapshot = await Api.get("/locked-tote-info/history/" + encodeURIComponent(btn.dataset.viewHistory));
      renderSnapshot(snapshot);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e2) {
      status("Failed to load that snapshot: " + e2.message, true);
    }
  });
  $("ltiHistoryRefreshBtn").addEventListener("click", (e) => { e.preventDefault(); Live.refresh("locked-tote-info.history"); });

  // ── Exports - ALWAYS the full, unfiltered, uncapped current snapshot's totes array ─────
  const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  function dl(content, filename, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime || "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function dumpCsv() {
    const headers = ["Tote ID", "Counted as locked", "Classification", "Zone", "Location", "Tracker", "Shuttle", "Total Tote Inv", "Locked Since", "Locked For", "Source", "Reason", "Worst PID", "Scarcity Count", "Quadron Qty", "Quadron Verdict"];
    const rows = [..._last.totes.map((t) => ["Yes", t]), ...unconfirmedOf().map((t) => ["No", t])].map(([counted, t]) => [t.toteId, counted, t.priority, t.zone || "", t.location || "", t.tracker || "", t.shuttle || "", t.totalToteInv == null ? "" : t.totalToteInv, t.lockedSince || "", lockedFor(ageMs(t)), t.source || "", t.reason || "", t.worstPid || "", t.scarcityCount == null ? "" : t.scarcityCount, t.quadronQty == null ? "" : t.quadronQty, t.quadronVerdict || ""]);
    return [`# Locked Tote Information — generated ${_last.generatedAt}`, `# Query: ${_last.queryId}`, "", headers.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
  }
  $("ltiDlCsvBtn").addEventListener("click", () => { if (_last) dl(dumpCsv(), `locked-tote-information-${stamp()}.csv`, "text/csv"); });
  $("ltiDlJsonBtn").addEventListener("click", () => { if (_last) dl(JSON.stringify(_last, null, 2), `locked-tote-information-${stamp()}.json`, "application/json"); });

  refreshBtn.addEventListener("click", refresh);

  // ── Live (server-pushed; subscribed only while this tab is open) ──────
  // "current": when ANOTHER user (or the auto-refresh) completes a new snapshot, this screen follows it - but only
  // if the operator is looking at the current snapshot. Someone viewing a past run is never yanked away.
  let _currentQueryId = null;
  let offs = [];

  function onCurrent(evt) {
    if (evt.type === "feed-error") { _failed = true; paintFreshness(); return; }
    if (evt.type !== "data") return;
    if (!evt.data || evt.data.empty) {
      _noSnapshot = !_last;
      emptyEl.classList.toggle("hidden", !_noSnapshot);
      paintFreshness();
      return;
    }
    _failed = !!evt.stale;
    const snap = evt.data;
    const following = !_last || _last.queryId === _currentQueryId;
    _currentQueryId = snap.queryId;
    if (following) {
      if (!_last || _last.queryId !== snap.queryId) renderSnapshot(snap);
      else paintFreshness();
    } else if (_last && _last.queryId !== snap.queryId && !evt.initial) {
      refreshedAtEl.textContent += " - a newer snapshot exists (refresh, or open it from Past snapshots).";
    }
  }
  const onHistory = (evt) => { if (evt.type === "data") renderHistory(evt.data); };

  function start() {
    if (offs.length) return;
    paintFreshness();
    offs = [Live.subscribe("locked-tote-info.current", onCurrent), Live.subscribe("locked-tote-info.history", onHistory)];
  }
  function stop() { offs.forEach((off) => off()); offs = []; }

  return { start, stop };
})();
