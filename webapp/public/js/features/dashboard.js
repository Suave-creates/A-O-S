// ASRS Control Center - the view of today's site day (06:00 IST onward).
// Tiles arrive over the live stream (public/js/core/live.js). The server reads them when this tab opens, on
// Refresh, and on the Dashboard's CENTRAL auto refresh: one interval per tile source for the whole site, set by
// an admin, run by the server once per interval however many people watch (live/dashboardAutoRefresh.js,
// operator decision 2026-11-04). This page only shows the settings and the shared countdown.
// Clicking a tile opens its drill-down popup (features/dashboardDetail.js):
// the hour-by-hour history behind that number. The One Pager Report is the
// historical twin of this screen - both read the same server data layer.
//
// 100% READ-ONLY: no tile triggers an operation. A tile or group shows an
// honest empty state ("No data yet") when its source has produced nothing,
// never a made-up value.
const Dashboard = (() => {
  const refreshBtn = document.getElementById("dashRefreshBtn");
  const lastRefreshedEl = document.getElementById("dashLastRefreshed");
  const clockEl = document.getElementById("dashClock");
  const tilesEl = document.getElementById("dashTiles");
  const groupsEl = document.getElementById("dashGroups");
  const livePill = document.getElementById("dashLivePill");
  const liveLabel = document.getElementById("dashLiveLabel");

  const LIVE_LABELS = { live: "LIVE", connecting: "CONNECTING", reconnecting: "RECONNECTING", paused: "PAUSED", idle: "OFFLINE" };
  Live.onState((st) => {
    livePill.className = "live-pill live-" + st;
    liveLabel.textContent = LIVE_LABELS[st] || "OFFLINE";
  });

  const nf = (n) => (n == null ? "No data" : Fmt.num(n));
  const pct = (f) => (f == null ? "-" : (f * 100).toFixed(1) + "%");
  const pctNum = (p) => (p == null ? "-" : Number(p).toFixed(1) + "%");

  // ── Central auto refresh (server-run, admin-set; this page shows it and lets an admin change it) ──
  // Tiles per source, for the freshness colours; the sources themselves come from the server.
  const TILES_OF = {
    "dashboard.compaction": ["compaction", "toteFreed"],
    "dashboard.cc": ["ccDone", "bermuda", "discrepancies"],
    "dashboard.outside": ["outside"],
    "locked-tote-info.latest": ["locked"],
    "dashboard.utilisation": ["utilisation", "totesInAsrs"],
    "dashboard.aisle": ["aisle"],
  };
  let ar = null; // { sources: [{ topic, label, minutes, def, nextAt, refreshing }], updatedBy, updatedAt }
  const isAdmin = () => typeof window.currentUserRole === "function" && window.currentUserRole() === "ADMIN";
  const minutesForTile = (id) => {
    const src = ar && ar.sources.find((x) => (TILES_OF[x.topic] || []).includes(id));
    return src ? src.minutes : 0;
  };
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  const arBtn = document.getElementById("dashArBtn");
  const arPanel = document.getElementById("dashArPanel");
  const arRows = document.getElementById("dashArRows");
  const arSummary = document.getElementById("dashArSummary");
  const arNote = document.getElementById("dashArNote");
  const arReset = document.getElementById("dashArReset");

  function buildAr() {
    if (!ar) return;
    const admin = isAdmin();
    arRows.innerHTML = ar.sources.map((r) => `<label class="dash-ar-row"><span class="dash-ar-k">${r.label}</span><input type="number" min="0" max="240" step="1" inputmode="numeric" data-topic="${r.topic}" value="${r.minutes}"${admin ? "" : " disabled"} aria-label="${r.label} auto refresh minutes"><span class="dash-ar-left" data-left="${r.topic}"></span></label>`).join("");
    arReset.hidden = !admin;
  }
  function paintAr() {
    if (!ar) return;
    for (const r of ar.sources) {
      const el = arRows.querySelector(`[data-left="${r.topic}"]`);
      if (!el) continue;
      el.textContent = !r.minutes ? "off" : r.refreshing ? "refreshing…" : r.nextAt ? "next " + mmss(r.nextAt - Date.now()) : "every " + r.minutes + " min";
      el.classList.toggle("off", !r.minutes);
    }
    const on = ar.sources.filter((r) => r.minutes).length;
    arSummary.textContent = on ? `Auto refresh on for ${on} of ${ar.sources.length} tile sources (same for everyone)` : "Auto refresh off - Refresh to update";
    arNote.textContent = (isAdmin() ? "You are an admin: changes apply to everyone. " : "Only an admin can change these. ") +
      (ar.updatedBy ? `Last changed by ${ar.updatedBy} at ${Fmt.time(ar.updatedAt)}.` : "Defaults in use.");
  }
  function applyAr(data) {
    const shapeChanged = !ar || ar.sources.map((r) => r.topic + ":" + r.minutes).join() !== data.sources.map((r) => r.topic + ":" + r.minutes).join();
    const editing = arRows.contains(document.activeElement);
    ar = data;
    if (shapeChanged && !editing) { buildAr(); paintAll(); }
    paintAr();
  }
  async function saveAr(body) {
    try {
      applyAr(await Api.put("/dashboard-auto-refresh", body));
    } catch (e) {
      Toast.show({ title: "Not saved", message: e.message, tone: "danger", ms: 4000 });
      buildAr();
    }
  }
  arRows.addEventListener("change", (e) => {
    const i = e.target.closest("input[data-topic]");
    if (!i || !isAdmin()) return;
    const v = Math.round(Number(i.value));
    saveAr({ minutes: { [i.dataset.topic]: Number.isFinite(v) ? Math.min(240, Math.max(0, v)) : 0 } });
  });
  arReset.addEventListener("click", () => { if (isAdmin()) saveAr({ reset: true }); });
  arBtn.addEventListener("click", () => {
    const open = arPanel.classList.toggle("hidden") === false;
    arBtn.setAttribute("aria-expanded", String(open));
    arBtn.classList.toggle("active", open);
    if (open) { buildAr(); paintAr(); }
  });
  // Called every second by the clock: only repaints the shared countdown - the server does the refreshing.
  function tickAr() {
    if (!arPanel.classList.contains("hidden")) paintAr();
  }

  // ── Wall clock + shift (IST), the only interval on this screen ──────────
  function istParts(now = new Date()) {
    const d = new Date(now.getTime() + 5.5 * 3600000);
    return { h: d.getUTCHours(), m: d.getUTCMinutes() };
  }
  function currentShift() {
    const { h } = istParts();
    return h >= 6 && h < 14 ? "A" : h >= 14 && h < 22 ? "B" : "C";
  }
  let tick = 0;
  function tickClock() {
    clockEl.textContent = new Date().toLocaleTimeString([], { hour12: false });
    tickAr();
    if (++tick % 10 === 0) paintAll(); // keeps "Ns ago" honest between pushes
  }
  setInterval(tickClock, 1000);

  // ── Freshness from the server's own timestamps ─────────────────────────
  // Judged against that tile's own Auto refresh interval: fresh within one interval (+1 min slack), amber within
  // two, then "since HH:MM". With the tile's auto refresh off: 10 min / 20 min.
  function freshness(iso, tileId) {
    if (!iso) return null;
    const age = Math.max(0, Date.now() - new Date(iso).getTime());
    const every = (minutesForTile(tileId) || 10) * 60000;
    const ago = age < 60000 ? (age < 10000 ? "just now" : Math.round(age / 1000) + "s ago") : Math.round(age / 60000) + "m ago";
    if (age < every + 60000) return { state: "live", text: ago };
    if (age < 2 * every + 60000) return { state: "degraded", text: ago };
    return { state: "stale", text: "since " + Fmt.time(iso) };
  }

  // The running shift (currentShift above) is marked "now" on the tiles.
  // { A, B, C, Total } -> the tile's split: a proportional bar + one cell per shift.
  const shiftSplit = (s) => {
    if (!s) return null;
    const now = currentShift();
    const hours = { A: "06-14", B: "14-22", C: "22-06" };
    return { cells: ["A", "B", "C"].map((k) => ({ k: k, v: s[k] || 0, tone: k.toLowerCase(), sub: hours[k], now: k === now })) };
  };

  // ── State per tile: latest data + when the server last confirmed it ─────
  const state = {}; // id -> { data, at, stale }
  function put(id, data, at) {
    state[id] = { data, at: at || new Date().toISOString() };
    paint(id);
  }

  // ── Simple tiles ────────────────────────────────────────────────────────
  // detail = popup metric id; go = tab to open instead (tiles that live elsewhere)
  const TILES = [
    { id: "compaction", label: "Compaction", icon: "compact", tone: "blue", detail: "compaction" },
    { id: "toteFreed", label: "Tote Freed", icon: "package", tone: "ok", detail: "toteFreed" },
    { id: "ccDone", label: "CC Done", icon: "checkcircle", tone: "ok", detail: "ccDone" },
    { id: "bermuda", label: "Bermuda Totes", icon: "layers", tone: "warn", detail: "ccDone", focus: "bermuda" },
    { id: "discrepancies", label: "Discrepancies Marked", icon: "filter", tone: "warn", detail: "discrepancies" },
    { id: "outside", label: "Outside Totes", icon: "outbound", tone: "danger", detail: "outside" },
    { id: "locked", label: "Locked Totes", icon: "lock", tone: "warn", detail: "locked" },
    { id: "auto", label: "Auto Puller", icon: "zap", tone: "purple", go: "autoPuller" },
  ];

  function specFor(t) {
    const st = state[t.id];
    const base = { icon: t.icon, tone: t.tone, label: t.label, emptyText: "No data yet" };
    if (!st || !st.data) return { ...base, value: null };
    const d = st.data;
    const f = freshness(st.at, t.id);
    const stale = d.stale ? { status: { text: "STALE", kind: "warn" } } : {};
    switch (t.id) {
            case "compaction": return { ...base, ...stale, value: nf(d.shifts.compaction.Total), split: shiftSplit(d.shifts.compaction), freshness: f };
            case "toteFreed": return { ...base, ...stale, value: nf(d.shifts.toteFreed.Total), split: shiftSplit(d.shifts.toteFreed), freshness: f };
      // True CC Done (Bermuda totes are separated out); the stations that ran / are running now ride along.
            case "ccDone": return { ...base, ...stale, value: nf(d.shifts.ccDone.Total), split: shiftSplit(d.shifts.ccDone), meta: [["Qty short", nf(d.shifts.shortQty.Total)], ["Stations", nf(d.stationsNow) + " running"]], freshness: f };
            case "bermuda": return { ...base, ...stale, value: nf(d.shifts.bermudaTotes.Total), split: shiftSplit(d.shifts.bermudaTotes), meta: [["Units short", nf(d.shifts.bermudaShortQty.Total)], ["Purged", nf(d.shifts.purgedTotes.Total) + " · " + nf(d.shifts.purgedShortQty.Total) + " units"]], freshness: f };
            case "discrepancies": return { ...base, ...stale, value: nf(d.shifts.discrepancies.Total), split: shiftSplit(d.shifts.discrepancies), freshness: f };
            case "outside": return { ...base, ...stale, value: nf(d.total), split: { cells: [{ k: "24h+", v: d.h24plus || 0, tone: "danger" }, { k: "12-24h", v: d.h12to24 || 0, tone: "warn" }] }, freshness: f };
      case "locked": return d;
      case "auto": return d;
      default: return { ...base, value: null };
    }
  }

  function ensureTiles() {
    if (tilesEl.childElementCount) return;
    tilesEl.innerHTML = TILES.map((t) => `<div class="kpi-card tile" id="tile-${t.id}" role="button" tabindex="0" data-tile="${t.id}"></div>`).join("");
    TILES.forEach((t) => paint(t.id));
  }

  // ── Grouped tiles (three related numbers each) ──────────────────────────
  const GROUPS = [
    // both come from the same utilisation run; its full view is the Tote Utilisation screen, so they open that
    { id: "utilisation", label: "Tote Utilisation", icon: "chart", tone: "blue", go: "utilisation" },
    { id: "totesInAsrs", label: "Totes in ASRS", icon: "package", tone: "ok", go: "utilisation" },
    { id: "aisle", label: "Aisle Occupancy", icon: "grid", tone: "warn", go: "aisleOccupancy" },
  ];

  function groupRows(g) {
    const st = state[g.id];
    const d = st && st.data;
    if (g.id === "utilisation") {
      if (!d || d.empty) return null;
      return [
        ["Large Tote Utilisation", pct(d.large.util), d.large.util == null ? null : d.large.util * 100],
        ["Small Tote Utilisation", pct(d.small.util), d.small.util == null ? null : d.small.util * 100],
        ["Total Utilisation", pct(d.total.util), d.total.util == null ? null : d.total.util * 100, true],
      ];
    }
    if (g.id === "totesInAsrs") {
      if (!d || d.empty) return null;
      const large = d.large.totes, small = d.small.totes, total = large + small;
      const share = (n) => (total ? (n / total) * 100 : 0);
      return [["Large Tote", nf(large), share(large)], ["Small Totes", nf(small), share(small)], ["Total Totes", nf(total), 100, true]];
    }
    if (!d) return null;
    return [
      ["Large", pctNum(d.large && d.large.average), d.large ? d.large.average : null],
      ["Short", pctNum(d.short && d.short.average), d.short ? d.short.average : null],
      ["Overall Utilisation", pctNum(d.occupancy && d.occupancy.average), d.occupancy ? d.occupancy.average : null, true],
    ];
  }

  function groupHtml(g) {
    const st = state[g.id];
    const rows = groupRows(g);
    const f = st ? freshness(st.at, g.id) : null;
    const body = rows
      ? rows.map(([label, value, p, total]) => `<div class="grp-row${total ? " grp-total" : ""}"><span class="grp-k">${label}</span><span class="grp-v">${value}</span>${Charts.meter(p, g.id === "totesInAsrs" ? { tone: "blue" } : {})}</div>`).join("")
      : `<div class="grp-empty">${g.id === "aisle" ? "No data yet" : "No utilisation run yet - it runs on a refresh once a NexS dump is in."}</div>`;
    return `<div class="kpi-head"><span class="kpi-ico"><i class="ico" data-i="${g.icon}"></i></span><div class="kpi-label">${g.label}</div>${st && st.data && st.data.stale ? '<span class="kpi-status-pill status-pill status-PENDING">STALE</span>' : ""}</div>
      <div class="grp-rows">${body}</div>
      <div class="kpi-foot"><span class="grp-open">Open ${g.go === "aisleOccupancy" ? "Aisle Occupancy" : "Tote Utilisation"} <i class="ico" data-i="outbound"></i></span>${KpiCard.freshnessHtml(f)}</div>`;
  }

  function ensureGroups() {
    if (groupsEl.childElementCount) return;
    groupsEl.innerHTML = GROUPS.map((g) => `<div class="kpi-card group" id="group-${g.id}" role="button" tabindex="0" data-tile="${g.id}" data-tone="${g.tone}"></div>`).join("");
    GROUPS.forEach((g) => paint(g.id));
  }

  // ── Painting ───────────────────────────────────────────────────────────
  function paint(id) {
    const tile = TILES.find((t) => t.id === id);
    if (tile) {
      const el = document.getElementById("tile-" + id);
      if (el) KpiCard.mount(el, specFor(tile));
      return;
    }
    const group = GROUPS.find((g) => g.id === id);
    if (group) {
      const el = document.getElementById("group-" + id);
      if (!el) return;
      const html = groupHtml(group);
      if (el.dataset.html !== html) {
        el.innerHTML = html;
        el.dataset.html = html;
        el.querySelectorAll(".grp-v").forEach((v) => Live.flash(v, "kpi-changed"));
      }
    }
  }
  function paintAll() {
    TILES.forEach((t) => paint(t.id));
    GROUPS.forEach((g) => paint(g.id));
  }

  // The server's fetch time, not the browser clock (DESIGN.md §9.1).
  function touchLastUpdated(at) {
    lastRefreshedEl.textContent = "Updated " + Fmt.time(at);
  }

  // ── Locked totes / Auto puller (own screens; clicking opens them) ───────
  const trendArrow = (delta) => {
    if (delta == null || Math.abs(delta) < 0.05) return { text: "→ flat", cls: "trend-flat" };
    return delta > 0 ? { text: `↑ ${Math.abs(delta).toFixed(1)}`, cls: "trend-up" } : { text: `↓ ${Math.abs(delta).toFixed(1)}`, cls: "trend-down" };
  };

  function applyLocked(history, at) {
    const latest = history && history[0];
    const prev = history && history[1];
    if (!latest) return put("locked", { label: "Locked Totes", icon: "lock", tone: "warn", value: null, emptyText: "No snapshot yet" }, at);
    const s = latest.summary || {};
    const delta = prev && prev.summary ? s.total - prev.summary.total : null;
    const trend = trendArrow(delta);
    put("locked", {
      label: "Locked Totes", icon: "lock", tone: "warn", value: nf(s.total),
      split: { cells: [{ k: "P0", v: s.p0Count || 0, tone: "danger" }, { k: "P1", v: s.p1Count || 0, tone: "warn" }, { k: "P2", v: s.p2Count || 0, tone: "blue" }, { k: "SD", v: s.sdCount || 0, tone: "c" }] },
      trendText: prev ? trend.text : null, trendClass: trend.cls, freshness: freshness(latest.createdAt, "locked"),
    }, at);
  }

  // Anyone's running Auto session counts (the feed carries a safe summary of every one), not only the viewer's own.
  function applyAuto(d, at) {
    const sessions = (d && d.sessions) || [];
    const active = sessions.length > 0;
    const first = sessions[0];
    const who = sessions.length > 1 ? sessions.length + " sessions" : first && first.by ? "by " + first.by : "";
    put("auto", active
      ? { label: "Auto Puller", icon: "zap", tone: "purple", value: "RUNNING", sub: who, meta: [["Called", String(sessions.reduce((n, s) => n + (s.called || 0), 0))], ["Queued", String(sessions.reduce((n, s) => n + (s.queued || 0), 0))]], status: { text: first.status || "RUNNING", kind: "ok" }, freshness: { state: "live", text: "active session" } }
      : { label: "Auto Puller", icon: "zap", tone: "purple", value: "IDLE", status: { text: "IDLE", kind: "muted" } }, at);
  }

  // ── Live wiring ─────────────────────────────────────────────────────────
  // A feed error only degrades a tile that has never had data; a stale value stays
  // visible (the server marks it stale) rather than being replaced by a guess.
  function handler(apply) {
    let last = null;
    return (evt) => {
      if (evt.type === "data") {
        last = evt.data;
        apply(evt.data, evt.at);
        touchLastUpdated(evt.checkedAt || evt.at);
      } else if (evt.type === "checked" && last) {
        const id = evt.topic;
        void id;
        apply(last, evt.checkedAt); // nothing changed: only refreshes the freshness stamp
      }
    };
  }

  const stamp = (id) => (data, at) => put(id, data, at);
  const TOPICS = ["dashboard.compaction", "dashboard.cc", "dashboard.outside", "dashboard.utilisation", "dashboard.aisle", "locked-tote-info.latest", "auto.active"];
  let unsubs = [];

  function start() {
    ensureTiles();
    ensureGroups();
    if (unsubs.length) return;
    unsubs = [
      Live.subscribe("dashboard.autoRefresh", (evt) => { if (evt.type === "data" && evt.data) applyAr(evt.data); }),
      Live.subscribe("dashboard.compaction", handler((d, at) => { put("compaction", d, at); put("toteFreed", d, at); })),
      Live.subscribe("dashboard.cc", handler((d, at) => { put("ccDone", d, at); put("bermuda", d, at); put("discrepancies", d, at); })),
      Live.subscribe("dashboard.outside", handler(stamp("outside"))),
      Live.subscribe("dashboard.utilisation", handler((d, at) => { put("utilisation", d, at); put("totesInAsrs", d, at); })),
      Live.subscribe("dashboard.aisle", handler(stamp("aisle"))),
      Live.subscribe("locked-tote-info.latest", handler(applyLocked)),
      Live.subscribe("auto.active", handler(applyAuto)),
    ];
  }

  function stop() {
    unsubs.forEach((off) => off());
    unsubs = [];
  }

  // Manual Refresh asks the SERVER hub to re-run every feed (rate-limited there).
  refreshBtn.addEventListener("click", () => {
    refreshBtn.disabled = true;
    TOPICS.forEach((t) => Live.refresh(t)); // the server restarts each tile's countdown from this read
    touchLastUpdated();
    setTimeout(() => { refreshBtn.disabled = false; }, 1500);
  });

  // Click / Enter / Space on a tile opens its popup (or its own screen).
  function activate(el) {
    const id = el && el.dataset.tile;
    if (!id) return;
    const t = TILES.find((x) => x.id === id) || GROUPS.find((x) => x.id === id);
    if (!t) return;
    if (t.go) location.hash = "#" + t.go;
    else DashboardDetail.open(t.detail, { focus: t.focus });
  }
  document.getElementById("tab-dashboard").addEventListener("click", (e) => activate(e.target.closest("[data-tile]")));
  document.getElementById("tab-dashboard").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-tile]")) {
      e.preventDefault();
      activate(e.target.closest("[data-tile]"));
    }
  });

  return { start, stop };
})();
