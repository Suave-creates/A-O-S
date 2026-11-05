// Picking Monitor - items picked at each GTP picking station, live, in the same form as the Control Center:
// KPI tiles with the A / B / C shift split, and a click opens the hour-by-hour popup behind the number.
// The numbers come from two server topics, "picking.monitor:<TYPE>-<PRIORITY>-<MINUTES>[-<STATION TYPE>-<STATION
// PRIORITY>]" and "picking.pipeline:<TYPE>-<PRIORITY>-<MINUTES>" (one shared Grafana read per filter choice for everybody); this file only draws
// them. It never polls and never calls an upstream. A future hour is an empty slot and a failed source is
// "Unavailable" - never a zero.
const PickingMonitor = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const nf = (n) => (n == null ? "No data" : Fmt.num(n));
  // A station that has only just started can be +1656%: true but unreadable, so very large changes show as "999%+".
  const pctText = (p) => (p == null ? "" : (p > 0 ? "+" : p < 0 ? "−" : "") + (Math.abs(p) > 999 ? "999%+" : Math.abs(p) + "%"));
  const signed = (n) => (n > 0 ? "+" + nf(n) : n < 0 ? "−" + nf(Math.abs(n)) : "0");
  const TONE = { A: "a", B: "b", C: "c" };
  const WINDOW_LABEL = { 15: "15 min", 30: "30 min", 60: "hour", 120: "2 hours", 240: "4 hours" };
  const PACE = {
    ahead: { text: "AHEAD OF PACE", kind: "ok" },
    steady: { text: "ON PACE", kind: "muted" },
    behind: { text: "BEHIND PACE", kind: "warn" },
    building: { text: "TOO EARLY", kind: "muted" },
  };
  const STORE = "aso_pm_filters";
  // Station health (rules live on the server, in stationHealth.js; this only names them).
  const HEALTH = { green: { text: "GREEN", kind: "ok", tone: "ok" }, yellow: { text: "YELLOW", kind: "warn", tone: "warn" }, red: { text: "RED", kind: "danger", tone: "danger" } };
  const CLASS_TEXT = { PRIORITY: "Priority", NONPRIORITY: "Non-priority", CHECK: "Supervisor to check" };

  let offs = [];
  let model = null; // latest station / hour reading
  let flow = null; // latest order-flow reading
  let modelEvt = null;
  let flowEvt = null;
  let detail = null; // { spec, modal } while a popup is open
  let filterText = "";
  let clockTimer = null;
  let stationOrder = "";

  // ── Header: clock and the shared live indicator (same as the Control Center) ──
  const LIVE_LABELS = { live: "LIVE", connecting: "CONNECTING", reconnecting: "RECONNECTING", paused: "PAUSED", idle: "OFFLINE" };
  Live.onState((st) => {
    $("pmLivePill").className = "live-pill live-" + st;
    $("pmLiveLabel").textContent = LIVE_LABELS[st] || "OFFLINE";
  });
  function currentShift() {
    const h = new Date(Date.now() + 5.5 * 3600000).getUTCHours();
    return h >= 6 && h < 14 ? "A" : h >= 14 && h < 22 ? "B" : "C";
  }
  function freshness(iso) {
    if (!iso) return null;
    const age = Math.max(0, Date.now() - new Date(iso).getTime());
    if (age < 90 * 1000) return { state: "live", text: age < 10000 ? "just now" : Math.round(age / 1000) + "s ago" };
    if (age < 10 * 60 * 1000) return { state: "degraded", text: Math.round(age / 60000) + "m ago" };
    return { state: "stale", text: "since " + Fmt.time(iso) };
  }
  let tick = 0;
  function tickClock() {
    $("pmClock").textContent = new Date().toLocaleTimeString([], { hour12: false });
    if (++tick % 10 === 0) { paintTiles(); paintFlow(); } // keeps "Ns ago" honest between pushes
  }

  // ── Filters (remembered per browser; the server validates every value again) ──
  function loadFilters() {
    try {
      const f = JSON.parse(localStorage.getItem(STORE) || "null");
      if (f) {
        // The station-type list comes from the station config; keep the remembered choice selectable until it arrives.
        if (f.stationType && f.stationType !== "ALL" && /^[A-Z0-9_]{1,24}$/.test(f.stationType)) $("pmStationType").add(new Option(f.stationType, f.stationType));
        for (const [id, v] of [["pmType", f.type], ["pmPriority", f.priority], ["pmWindow", f.window], ["pmStationType", f.stationType], ["pmStationPriority", f.stationPriority]]) {
          if ([...$(id).options].some((o) => o.value === String(v))) $(id).value = String(v);
        }
      }
    } catch (e) { /* storage unavailable - defaults are fine */ }
  }
  function saveFilters() {
    try { localStorage.setItem(STORE, JSON.stringify({ type: $("pmType").value, priority: $("pmPriority").value, window: $("pmWindow").value, stationType: $("pmStationType").value, stationPriority: $("pmStationPriority").value })); } catch (e) { /* ignore */ }
  }
  // The pipeline counts orders, so the station filters are not part of its key (no extra Grafana reads).
  const pipelineKey = () => `${$("pmType").value}-${$("pmPriority").value}-${$("pmWindow").value}`;
  const currentKey = () => pipelineKey() + `-${$("pmStationType").value}-${$("pmStationPriority").value}`;
  // Fill the Station type list from the station config the first time it arrives (and keep the choice).
  function syncStationTypes(types) {
    const sel = $("pmStationType");
    const have = [...sel.options].map((o) => o.value).filter((v) => v !== "ALL").sort().join(",");
    if (!types || !types.length || have === [...types].sort().join(",")) return;
    const keep = sel.value;
    sel.innerHTML = '<option value="ALL">All</option>' + types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
    sel.value = types.includes(keep) ? keep : "ALL";
  }
  const windowText = () => WINDOW_LABEL[$("pmWindow").value] || $("pmWindow").value + " min";

  // ── Tiles ─────────────────────────────────────────────────────────────
  const shiftSplit = (shifts) => {
    const now = currentShift();
    const hours = { A: "06-14", B: "14-22", C: "22-06" };
    return { cells: ["A", "B", "C"].map((k) => ({ k, v: (shifts[k] && shifts[k].total) || 0, tone: TONE[k], sub: hours[k], now: k === now })) };
  };
  const staleOf = (evt, d) => ((evt && evt.stale) || (d && d.stale) ? { status: { text: "STALE", kind: "warn" } } : {});

  // Station health: how much of the 300 items/hour design capacity the judged stations reach.
  function capacityTile(d, stale, f) {
    const c = d.capacity;
    if (!d.configAvailable) return { id: "capacity", detail: { kind: "stations" }, label: "Capacity Used", icon: "chart", tone: "muted", ...stale, value: null, emptyText: "Station details unavailable", sub: "needs the GTP station list", freshness: f };
    const bad = c.red;
    return {
      id: "capacity", detail: { kind: "stations" }, label: "Capacity Used", icon: "chart", tone: c.judged === 0 ? "muted" : bad ? "danger" : c.yellow ? "warn" : "ok", ...stale,
      value: c.utilisationPct == null ? null : c.utilisationPct + "%", emptyText: "No station judged",
      sub: `${c.designPerHour} items / hour per station`,
      meta: [["Green / Yellow / Red", `${c.green} / ${c.yellow} / ${c.red}`], ["Supervisor to check", nf(c.check.length)]],
      status: bad ? { text: bad + " RED", kind: "danger" } : c.check.length ? { text: c.check.length + " TO CHECK", kind: "warn" } : c.judged ? { text: "ON TARGET", kind: "ok" } : null,
      freshness: f,
    };
  }

  function tileSpecs(d) {
    const t = d.totals;
    const stale = staleOf(modelEvt, d);
    const f = freshness(modelEvt && modelEvt.at);
    const p = d.pace;
    const trend = t.deltaPct == null ? {} : { trendText: pctText(t.deltaPct) || "0%", trendClass: t.deltaPct > 0 ? "trend-up trend-good" : t.deltaPct < 0 ? "trend-down trend-bad" : "" };
    return [
      { id: "picked", detail: { kind: "picked" }, label: "Items Picked", icon: "package", tone: "ok", ...stale, value: nf(t.today),
        split: shiftSplit(d.shifts), meta: [["Avg / hour", d.avgPerHour == null ? "-" : nf(d.avgPerHour)], ["Peak hour", d.peak ? `${d.peak.label} · ${nf(d.peak.total)}` : "-"]], freshness: f },
      { id: "window", detail: { kind: "stations" }, label: `Last ${windowText()}`, icon: "trend", tone: "blue", ...stale, ...trend, value: nf(t.window),
        sub: t.prev == null ? "no previous window to compare" : `vs ${nf(t.prev)} in the ${windowText()} before`, freshness: f },
      { id: "stations", detail: { kind: "stations" }, label: "Active Stations", icon: "grid", tone: t.idle.length ? "warn" : "ok", ...stale, value: `${t.stationsActive} / ${t.stationsSeen}`,
        meta: [["Idle", nf(t.idle.length)], ["Slow", nf(t.slow.length)]], status: t.idle.length ? { text: t.idle.length + " IDLE", kind: "warn" } : { text: "ALL PICKING", kind: "ok" }, freshness: f },
      capacityTile(d, stale, f),
      { id: "hour", detail: { kind: "picked" }, label: "This Hour", icon: "zap", tone: "purple", ...stale, value: p && p.projected != null ? nf(p.projected) : null, emptyText: p ? "Too early" : "No hour running",
        sub: p ? (p.projected != null ? `on pace for ${p.label}` : `${p.label} · ${p.elapsedMin} min in`) : "the site day starts at 06:00 IST",
        meta: p ? [["So far", nf(p.soFar)], ["Day avg / hr", p.avgPerHour == null ? "-" : nf(p.avgPerHour)]] : null,
        status: p ? { text: PACE[p.state].text, kind: PACE[p.state].kind } : null, freshness: f },
    ];
  }

  function paintTiles() {
    if (!model) return;
    const host = $("pmTiles");
    const specs = tileSpecs(model);
    if (!host.childElementCount) {
      host.innerHTML = specs.map((s) => `<div class="kpi-card tile" id="pmt-${s.id}" role="button" tabindex="0" data-tile="${s.id}"></div>`).join("");
    }
    specs.forEach((s) => KpiCard.mount($("pmt-" + s.id), s));
    tileSpecs.byId = Object.fromEntries(specs.map((s) => [s.id, s]));
  }

  const FLOW_ICON = { synced: "download", created: "file", inProgress: "layers", allocated: "grid", completed: "checkcircle" };
  const FLOW_TONE = { synced: "blue", created: "blue", inProgress: "purple", allocated: "warn", completed: "ok" };
  function paintFlow() {
    const host = $("pmFlow");
    if (!flow) return;
    const tiles = flow.groups.flatMap((g) => g.tiles);
    if (host.childElementCount !== tiles.length) host.innerHTML = tiles.map((t) => `<div class="kpi-card tile" id="pmf-${t.key}"></div>`).join("");
    const f = freshness(flowEvt && flowEvt.at);
    const stale = staleOf(flowEvt, flow);
    for (const t of tiles) {
      KpiCard.mount($("pmf-" + t.key), {
        label: t.label, icon: FLOW_ICON[t.key], tone: FLOW_TONE[t.key], emptyText: "Unavailable", ...stale,
        value: t.value == null ? null : nf(t.value),
        sub: t.value == null ? "unavailable: " + t.error : t.scope === "now" ? "right now" : `last ${WINDOW_LABEL[flow.windowMin] || flow.windowMin + " min"}`,
        freshness: f,
      });
      $("pmf-" + t.key).title = t.help;
    }
  }

  function stationSpec(s) {
    const trend = s.deltaPct == null ? {} : { trendText: pctText(s.deltaPct) || "0%", trendClass: s.delta > 0 ? "trend-up trend-good" : s.delta < 0 ? "trend-down trend-bad" : "" };
    const hl = s.health ? HEALTH[s.health] : null;
    let status = s.state === "idle" ? { text: "IDLE", kind: "muted" } : s.state === "slow" ? { text: "SLOW", kind: "warn" } : null;
    if (hl) status = { text: `${s.capacityPct}% · ${hl.text}`, kind: hl.kind };
    else if (s.priorityClass === "CHECK" && s.picking) status = { text: "CHECK PRIORITY", kind: "warn" };
    return {
      label: s.id, icon: "grid", tone: hl ? hl.tone : s.state === "idle" ? "danger" : s.state === "slow" ? "warn" : "ok", ...trend, value: nf(s.picks),
      sub: [s.type, s.priorityClass ? CLASS_TEXT[s.priorityClass] : null].filter(Boolean).join(" · ") || null,
      meta: [["Today", nf(s.today)], s.queuedItems == null ? ["Share", s.share + "%"] : ["Queued", nf(s.queuedItems)]],
      status,
    };
  }
  function paintStations() {
    if (!model) return;
    const host = $("pmStations");
    const order = model.stations.map((s) => s.id).join(",");
    if (order !== stationOrder) {
      stationOrder = order;
      host.innerHTML = model.stations.length
        ? model.stations.map((s) => `<div class="kpi-card tile" id="pms-${esc(s.id)}" role="button" tabindex="0" data-station="${esc(s.id)}"></div>`).join("")
        : `<div class="pm-none">No station has picked anything today with this filter.</div>`;
    }
    for (const s of model.stations) KpiCard.mount($("pms-" + s.id), stationSpec(s));
  }

  // ── Popups (the same 80% dialog and styling as the Control Center's) ────
  const stat = (label, value, { tone = "", sub = "" } = {}) =>
    `<div class="dd-stat ${tone ? "tone-" + tone : ""}"><div class="dd-stat-k">${esc(label)}</div><div class="dd-stat-v">${value}</div>${sub ? `<div class="dd-stat-s">${esc(sub)}</div>` : ""}</div>`;
  const card = (title, inner, { cls = "", right = "" } = {}) => `<section class="dd-card ${cls}"><header><h4>${esc(title)}</h4>${right}</header>${inner}</section>`;
  const legend = `<div class="dd-legend"><span class="tone-a">Shift A</span><span class="tone-b">Shift B</span><span class="tone-c">Shift C</span><span class="dd-note">Hours not reached yet stay empty.</span></div>`;

  function hourItems(hours, valueOf) {
    return hours.map((h, i) => {
      const v = valueOf(h, i);
      return { label: h.label, value: v, tone: TONE[h.shift], current: h.status === "current", tip: `${h.label} (shift ${h.shift}): ${v == null ? "not reached yet" : nf(v) + " items"}` };
    });
  }
  function hourRows(hours, valueOf) {
    const reached = hours.map((h, i) => ({ h, v: valueOf(h, i) })).filter((r) => r.v != null);
    const max = Math.max(1, ...reached.map((r) => r.v));
    return hours.map((h, i) => {
      const v = valueOf(h, i);
      const prevIdx = i - 1;
      const prevV = prevIdx >= 0 ? valueOf(hours[prevIdx], prevIdx) : null;
      const delta = v != null && prevV != null && h.status === "closed" ? v - prevV : null; // the running hour is partial
      return `<tr class="${h.status === "current" ? "is-now" : ""}${v == null ? " is-future" : ""}"><td>${esc(h.label)}</td><td><span class="shift-chip tone-${TONE[h.shift]}">${h.shift}</span></td>
        <td class="num">${v == null ? "-" : nf(v)}</td><td class="share">${v == null ? "" : `<span class="meter tone-${TONE[h.shift]}"><i style="width:${Math.round((v / max) * 100)}%"></i></span>`}</td>
        <td class="num">${delta == null ? "" : signed(delta)}</td><td>${h.status === "current" ? '<span class="now-tag">now</span>' : ""}</td></tr>`;
    }).join("");
  }
  const hourTable = (hours, valueOf) => `<div class="dd-scroll tall"><table class="dd-table hours"><thead><tr><th>Hour</th><th>Shift</th><th class="num">Items</th><th></th><th class="num">vs previous</th><th></th></tr></thead><tbody>${hourRows(hours, valueOf)}</tbody></table></div>`;

  const stateChip = (s) => (s.state === "idle" ? "Idle" : s.state === "slow" ? "Slow" : "");
  const healthChip = (s) => (s.health ? `<span class="pm-chip ${s.health}">${HEALTH[s.health].text}</span>` : s.picking && s.priorityClass === "CHECK" ? '<span class="pm-chip check">Check</span>' : "");
  const classText = (s) => (s.priorityClass ? CLASS_TEXT[s.priorityClass] : "");
  function stationsTable(d) {
    if (!d.stations.length) return '<p class="dd-empty">No station matches this filter.</p>';
    const win = windowText();
    const facts = d.configAvailable;
    const rows = d.stations.map((s) => `<tr data-station="${esc(s.id)}"><td class="num">${s.rank}</td><td><b>${esc(s.id)}</b></td>
      ${facts ? `<td>${esc(s.type || "")}</td><td>${esc(classText(s))}</td><td>${s.picking ? "Picking" : esc(s.operationType || "")}</td>` : ""}
      <td class="num">${nf(s.picks)}</td>${facts ? `<td class="num">${s.picking && s.capacityPct != null ? s.capacityPct + "%" : ""}</td><td>${healthChip(s)}</td>` : ""}
      <td class="num">${s.prev == null ? "-" : nf(s.prev)}</td><td class="num">${s.deltaPct == null ? "-" : pctText(s.deltaPct) || "0%"}</td>
      <td class="num">${nf(s.today)}</td>${d.queueAvailable ? `<td class="num">${s.queuedItems == null ? "" : nf(s.queuedItems)}</td><td class="num">${s.slots == null ? "" : nf(s.slots)}</td>` : ""}
      <td>${stateChip(s)}</td></tr>`).join("");
    return `<div class="dd-scroll tall"><table class="dd-table"><thead><tr><th class="num">#</th><th>Station</th>${facts ? "<th>Type</th><th>Priority</th><th>Operation</th>" : ""}<th class="num">Last ${esc(win)}</th>${facts ? '<th class="num">% of 300/h</th><th>Health</th>' : ""}<th class="num">Before</th><th class="num">Change</th><th class="num">Today</th>${d.queueAvailable ? '<th class="num">Queued items</th><th class="num">Slots used</th>' : ""}<th>State</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function renderPicked(d) {
    const p = d.pace;
    return `<div class="dd-stats">
        ${stat("Today (06:00 → now)", nf(d.totals.today), { tone: "hero", sub: "items picked" })}
        ${stat("Shift A · 06-14", nf(d.shifts.A.total), { tone: "a" })}
        ${stat("Shift B · 14-22", nf(d.shifts.B.total), { tone: "b" })}
        ${stat("Shift C · 22-06", nf(d.shifts.C.total), { tone: "c" })}
        ${stat("Peak hour", d.peak ? nf(d.peak.total) : "-", { sub: d.peak ? d.peak.label : "no hour closed yet" })}
        ${stat("Average / hour", d.avgPerHour == null ? "-" : nf(d.avgPerHour), { sub: "closed hours" })}
        ${p ? stat("This hour on pace for", p.projected == null ? "-" : nf(p.projected), { sub: `${nf(p.soFar)} so far · ${p.elapsedMin} min in` }) : ""}
      </div>
      ${card("By hour (IST)", Charts.bars(hourItems(d.hours, (h) => h.total), { unit: "items" }) + legend)}
      <div class="dd-grid">
        ${card("Hour by hour", hourTable(d.hours, (h) => h.total))}
        <div class="dd-stack">${card("Top stations today", d.stations.length ? `<div class="dd-scroll"><table class="dd-table"><thead><tr><th>Station</th><th class="num">Today</th><th class="num">Last ${esc(windowText())}</th></tr></thead><tbody>${[...d.stations].sort((a, b) => b.today - a.today).slice(0, 12).map((s) => `<tr data-station="${esc(s.id)}"><td><b>${esc(s.id)}</b></td><td class="num">${nf(s.today)}</td><td class="num">${nf(s.picks)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="dd-empty">Nothing picked yet today.</p>')}</div>
      </div>
      <p class="dd-note def">Filter: order type <b>${esc(d.filters.type)}</b>, priority <b>${esc(d.filters.priority)}</b>. Items picked = order lines picked, counted at the picking station they were picked at.</p>`;
  }

  function renderStations(d) {
    const t = d.totals;
    return `<div class="dd-stats">
        ${stat(`Picked, last ${windowText()}`, nf(t.window), { tone: "hero", sub: t.deltaPct == null ? "no previous window" : `${pctText(t.deltaPct) || "0%"} vs ${nf(t.prev)} before` })}
        ${stat("Active stations", `${t.stationsActive} / ${t.stationsSeen}`, { sub: "picked in the window / seen today" })}
        ${stat("Idle", nf(t.idle.length), { sub: t.idle.length ? "picked earlier today, nothing in the window" : "none" })}
        ${stat("Slow", nf(t.slow.length), { sub: t.peerMedian == null ? "needs 4 active stations" : `below half the median (${nf(t.peerMedian)})` })}
        ${d.configAvailable ? stat("Capacity used", d.capacity.utilisationPct == null ? "-" : d.capacity.utilisationPct + "%", { tone: d.capacity.red ? "danger" : d.capacity.yellow ? "warn" : "", sub: `${d.capacity.green} green · ${d.capacity.yellow} yellow · ${d.capacity.red} red` }) : ""}
        ${d.queue ? stat("Still queued on PTL", nf(d.queue.items), { sub: `${nf(d.queue.slots)} slots occupied` }) : ""}
      </div>
      ${card("Stations", '<input type="search" class="dd-filter" data-filter placeholder="Filter by station or state (Idle / Slow)" />' + stationsTable(d), { cls: "dd-done", right: d.stations.length ? '<button class="link" data-copy-table>Copy table</button>' : "" })}
      ${d.configAvailable ? `<p class="dd-note def"><b>Health</b> = the station's rate in the window, scaled to an hour, as a share of its ${d.capacity.designPerHour} items/hour design capacity. <b>Non-priority</b> (weight 0): green above 85%, yellow 70-85%, red below 70%. <b>Priority</b> (weight 300000000): green above 65%, yellow 50-65%, red below 50%. Any other weight is shown as <b>Supervisor to check</b> and gets no colour. Only logged-in stations on the PICKING operation are judged.${d.capacity.check.length ? ` To check now: ${esc(d.capacity.check.join(", "))}.` : ""}</p>` : ""}
      <p class="dd-note def"><b>Idle</b> = picked items earlier today but none in the window. <b>Slow</b> = picking below half of the median active station, when at least four stations are active. Click a row for that station's whole day.</p>`;
  }

  function renderStation(d, id) {
    const s = d.stations.find((x) => x.id === id);
    if (!s) return `<div class="dd-banner warn">${esc(id)} has not picked anything today with this filter.</div>`;
    const val = (h, i) => s.hours[i];
    return `<div class="dd-stats">
        ${stat(`Last ${windowText()}`, nf(s.picks), { tone: "hero", sub: `rank ${s.rank} of ${d.stations.length} · ${s.share}% of all stations` })}
        ${stat(`The ${windowText()} before`, s.prev == null ? "-" : nf(s.prev), { sub: s.deltaPct == null ? "" : `${pctText(s.deltaPct) || "0%"} change` })}
        ${stat("Today", nf(s.today), { sub: "items since 06:00 IST" })}
        ${d.configAvailable ? stat("Capacity", s.picking && s.capacityPct != null ? s.capacityPct + "%" : "-", { tone: s.health === "red" ? "danger" : s.health === "yellow" ? "warn" : "", sub: s.picking ? `${nf(s.ratePerHour)} items/hour · ${s.health ? HEALTH[s.health].text : "to be checked"}` : "not picking right now" }) : ""}
        ${d.configAvailable ? stat("Station", s.type || "-", { sub: [classText(s), s.userId ? "user " + s.userId : "no user logged in"].filter(Boolean).join(" · ") }) : ""}
        ${s.queuedItems == null ? "" : stat("Queued on PTL", nf(s.queuedItems), { sub: `${nf(s.queuedLines)} lines · ${nf(s.slots)} slots used` })}
        ${stat("State", stateChip(s) || "Picking", { sub: s.state === "idle" ? "nothing in the window" : s.state === "slow" ? "below half the peer median" : "normal" })}
      </div>
      ${card("By hour (IST)", Charts.bars(hourItems(d.hours, val), { unit: "items" }) + legend)}
      ${card("Hour by hour", hourTable(d.hours, val))}`;
  }

  function renderDetail() {
    if (!detail || !detail.modal.isOpen() || !model) return;
    const { spec, modal } = detail;
    const scroll = modal.body.scrollTop;
    const html = spec.kind === "picked" ? renderPicked(model) : spec.kind === "station" ? renderStation(model, spec.id) : renderStations(model);
    modal.body.innerHTML = `<div class="dd">${staleBanner()}${html}</div>`;
    modal.body.scrollTop = scroll;
    wireDetail(modal);
    modal.setLive(modelEvt && modelEvt.stale ? "reconnecting" : "live", `${modelEvt && modelEvt.stale ? "STALE" : "LIVE"} · ${Fmt.time((modelEvt && (modelEvt.checkedAt || modelEvt.at)) || Date.now())}`);
  }
  const staleBanner = () => (model && (model.stale || (modelEvt && modelEvt.stale)) ? `<div class="dd-banner warn">Showing the last good data - the latest refresh failed${model.staleReason ? ` (${esc(String(model.staleReason).slice(0, 140))})` : ""}. It retries automatically.</div>` : "");

  function wireDetail(modal) {
    const copy = modal.body.querySelector("[data-copy-table]");
    if (copy) {
      // The WHOLE table, tab-separated so it pastes straight into Excel / Sheets; rows hidden by the filter are left out.
      copy.addEventListener("click", async () => {
        const table = copy.closest(".dd-card").querySelector("table");
        const clean = (t) => String(t).replace(/[\t\r\n]+/g, " ").trim();
        const lines = [...table.querySelectorAll("tr")].filter((tr) => tr.style.display !== "none").map((tr) => [...tr.children].map((c) => clean(c.innerText)).join("\t"));
        try {
          await navigator.clipboard.writeText(lines.join("\n"));
          Toast.show({ title: "Copied", message: (lines.length - 1) + " rows with all columns", tone: "ok", ms: 1800 });
        } catch (e) {
          Toast.show({ title: "Couldn't copy", tone: "warn" });
        }
      });
    }
    const fl = modal.body.querySelector("[data-filter]");
    if (fl) {
      const apply = () => {
        const q = fl.value.trim().toUpperCase();
        fl.closest(".dd-card").querySelectorAll("tbody tr").forEach((tr) => { tr.style.display = !q || tr.innerText.toUpperCase().includes(q) ? "" : "none"; });
      };
      fl.value = filterText;
      fl.addEventListener("input", () => { filterText = fl.value; apply(); });
      apply();
    }
    modal.body.querySelectorAll("tr[data-station]").forEach((tr) => { tr.style.cursor = "pointer"; tr.addEventListener("click", () => openDetail({ kind: "station", id: tr.dataset.station })); });
  }

  const TITLES = { picked: ["Items Picked", "package"], stations: ["Stations", "grid"], station: ["Station", "grid"] };
  function openDetail(spec) {
    if (!model) return;
    if (detail && detail.modal.isOpen()) detail.modal.close();
    filterText = "";
    const [title, icon] = TITLES[spec.kind];
    const modal = Modal.open({ title: spec.kind === "station" ? spec.id : title, subtitle: `${spec.kind === "picked" ? "items picked at every station" : spec.kind === "station" ? "one picking station" : "ranked by the window"} · today since 06:00 IST`, icon, onClose: () => { detail = null; } });
    detail = { spec, modal };
    renderDetail();
  }

  // ── States ───────────────────────────────────────────────────────────
  function showBody(on) {
    $("pmBody").classList.toggle("hidden", !on);
    $("pmEmpty").classList.toggle("hidden", on);
  }
  function setBanner(evt, d) {
    const b = $("pmBanner");
    if (d && d.configAvailable === false && !(evt && evt.stale) && !d.stale) {
      b.textContent = "The GTP station list is unavailable, so stations are shown without type, priority and capacity colours. It is retried automatically.";
      b.classList.remove("hidden");
      return;
    }
    if (!((evt && evt.stale) || (d && d.stale))) { b.classList.add("hidden"); return; }
    b.textContent = `Showing the last good reading${d && d.staleSince ? " from " + Fmt.when(d.staleSince) : ""} - ${(d && d.staleReason) || "the source did not answer"}.`;
    b.classList.remove("hidden");
  }
  function touchLastUpdated() {
    $("pmLastRefreshed").textContent = modelEvt ? `Updated ${Fmt.when(modelEvt.at)}. Refreshes every 2 min while you watch.` : "Waiting for the first reading…";
  }

  function onPicking(evt) {
    if (evt.type === "data" || (evt.type === "checked" && model)) {
      if (evt.type === "data") { model = evt.data; }
      modelEvt = { ...(modelEvt || {}), ...evt, type: "data", at: evt.type === "data" ? evt.at : (modelEvt && modelEvt.at) || evt.at };
      if (!model || !model.stations) return;
      syncStationTypes(model.stationTypes);
      showBody(true);
      setBanner(modelEvt, model);
      paintTiles();
      paintStations();
      renderDetail();
      touchLastUpdated();
    } else if (evt.type === "feed-error" && !model) {
      showBody(false);
      $("pmEmpty").innerHTML = `<i class="ico" data-i="alert"></i><h4>Data unavailable</h4><p>${esc(evt.message || "The picking source did not answer.")}</p><p class="note">It is retried automatically. Press Refresh to try now.</p>`;
    }
  }
  function onFlow(evt) {
    if (evt.type === "data" || (evt.type === "checked" && flow)) {
      if (evt.type === "data") flow = evt.data;
      flowEvt = { ...(flowEvt || {}), ...evt, type: "data", at: evt.type === "data" ? evt.at : (flowEvt && flowEvt.at) || evt.at };
      if (flow && flow.groups) paintFlow();
    } else if (evt.type === "feed-error" && !flow) {
      $("pmFlow").innerHTML = `<div class="pm-none">Order flow unavailable - ${esc(evt.message || "the source did not answer")}. It is retried automatically.</div>`;
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────
  function start() {
    if (offs.length) return;
    offs = [Live.subscribe("picking.monitor:" + currentKey(), onPicking), Live.subscribe("picking.pipeline:" + pipelineKey(), onFlow)];
    if (!clockTimer) { tickClock(); clockTimer = setInterval(tickClock, 1000); } // the clock is the only interval on this screen
  }
  function stop() {
    offs.forEach((off) => off());
    offs = [];
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    if (detail && detail.modal.isOpen()) detail.modal.close();
  }

  // A filter changed: follow the new choice's topics, and say so until its first reading arrives.
  function onFilterChange() {
    saveFilters();
    const watching = offs.length > 0;
    offs.forEach((off) => off());
    offs = [];
    if (detail && detail.modal.isOpen()) detail.modal.close();
    model = flow = modelEvt = flowEvt = null;
    stationOrder = "";
    $("pmTiles").innerHTML = "";
    $("pmFlow").innerHTML = "";
    $("pmStations").innerHTML = "";
    showBody(false);
    $("pmEmpty").innerHTML = `<i class="ico" data-i="trend"></i><h4>Reading this filter…</h4><p>The first read of a new filter takes a little longer; after that only the running hour is refreshed.</p>`;
    touchLastUpdated();
    if (watching) start();
  }

  loadFilters();
  for (const id of ["pmType", "pmPriority", "pmWindow", "pmStationType", "pmStationPriority"]) $(id).addEventListener("change", onFilterChange);
  $("pmRefreshBtn").addEventListener("click", () => {
    const btn = $("pmRefreshBtn");
    btn.disabled = true;
    Live.refresh("picking.monitor:" + currentKey());
    Live.refresh("picking.pipeline:" + pipelineKey());
    setTimeout(() => { btn.disabled = false; }, 1500);
  });

  // Click / Enter / Space on a tile opens its popup; a station tile opens that station's day.
  function activate(el) {
    if (!el) return;
    if (el.dataset.station) { openDetail({ kind: "station", id: el.dataset.station }); return; }
    const spec = tileSpecs.byId && tileSpecs.byId[el.dataset.tile];
    if (spec && spec.detail) openDetail(spec.detail);
  }
  $("tab-pickingMonitor").addEventListener("click", (e) => activate(e.target.closest("[data-tile], [data-station]")));
  $("tab-pickingMonitor").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-tile], [data-station]")) {
      e.preventDefault();
      activate(e.target.closest("[data-tile], [data-station]"));
    }
  });

  return { start, stop };
})();
