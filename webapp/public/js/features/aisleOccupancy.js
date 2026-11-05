// Aisle Occupancy (Monitor). Live occupancy of the six aisles from Grafana, plus the Location Audit breakdown
// (container tracking) of the chosen aisle: by level, side, depth, zone and shuttle health. Read-only.
//
// Fed by the live topic "aisle-occupancy.current" (server/live/dashboardFeeds.js); the server shares one
// Grafana read and one container-tracking read between this screen, the Dashboard tile and Location Audit.
// The Dashboard's Aisle Occupancy tile opens this screen.
const AisleOccupancy = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const nf = (n) => (n == null ? "No data" : Fmt.num(n));
  const pct1 = (p) => (p == null ? "-" : Number(p).toFixed(1) + "%");

  let off = null;
  let last = null;
  let selectedAisle = 1;

  const stat = (label, value, { tone = "", sub = "" } = {}) =>
    `<div class="dd-stat ${tone ? "tone-" + tone : ""}"><div class="dd-stat-k">${esc(label)}</div><div class="dd-stat-v">${value}</div>${sub ? `<div class="dd-stat-s">${esc(sub)}</div>` : ""}</div>`;
  const card = (title, inner, { cls = "", right = "" } = {}) =>
    `<section class="dd-card ${cls}"><header><h4>${esc(title)}</h4>${right}</header>${inner}</section>`;

  // Same thresholds as before: 90%+ crowded, 75%+ filling, otherwise fine.
  function heatCell(v) {
    if (v == null) return "<td>-</td>";
    const color = v >= 90 ? "var(--danger)" : v >= 75 ? "var(--warn)" : "var(--accent)";
    return `<td class="heat" style="--p:${Math.min(100, v)};--h:${color}">${v.toFixed(1)}%</td>`;
  }

  function liveHtml(g) {
    const avg = (r) => (r && r.average != null ? r.average / 100 : null);
    const gRow = (label, r) => `<tr><td><span class="shift-tag">${label}</span></td>${(r ? r.values : []).map(heatCell).join("")}${heatCell(r ? r.average : null)}</tr>`;
    return `
      <div class="dd-rings">
        ${card("Large aisles", Charts.ring(avg(g.large), { label: "average" }), { cls: "center" })}
        ${card("Short aisles", Charts.ring(avg(g.short), { label: "average" }), { cls: "center" })}
        ${card("Overall", Charts.ring(avg(g.occupancy), { label: "all aisles", size: 140 }), { cls: "center hero" })}
      </div>
      ${card("Occupancy by aisle (live)", `<div class="dd-scroll"><table class="dd-table centered"><thead><tr><th></th>${[1, 2, 3, 4, 5, 6].map((n) => `<th>Aisle ${n}</th>`).join("")}<th>Average</th></tr></thead><tbody>${gRow("Overall", g.occupancy)}${gRow("Large", g.large)}${gRow("Short", g.short)}</tbody></table></div>`)}`;
  }

  function auditHtml(a, auditAt) {
    const sel = a.aisles.find((x) => x.aisle === selectedAisle) || a.aisles[0];
    const tabs = a.aisles.map((x) => `<button class="aisle-tab ${x.aisle === sel.aisle ? "active" : ""}" data-aisle="${x.aisle}"><b>Aisle ${x.aisle}</b><span>${pct1(x.pct)}</span></button>`).join("");
    const levelRows = [...sel.levels].reverse()
      .map((l) => `<div class="lvl"><span class="lvl-n">L${String(l.level).padStart(2, "0")}</span>${Charts.meter(l.pct)}<span class="lvl-p">${l.pct.toFixed(1)}%</span><span class="lvl-c">${nf(l.occupied)}/${nf(l.total)}</span></div>`)
      .join("");
    const split = (title, left, right, ll, rl) => `<div class="split"><h5>${title}</h5><div class="split-row"><span>${ll}</span>${Charts.meter(left.pct)}<b>${pct1(left.pct)}</b></div><div class="split-row"><span>${rl}</span>${Charts.meter(right.pct)}<b>${pct1(right.pct)}</b></div></div>`;
    const list = (rows, key, label) => (rows.length ? `<ul class="dd-list">${rows.map((r) => `<li><span>${esc(r[key])}</span><b>${nf(r.occupied)}</b></li>`).join("")}</ul>` : `<p class="dd-empty">No ${label} data.</p>`);
    return `
      <h3 class="dd-h3">Location Audit detail</h3>
      <div class="dd-stats">
        ${stat("Slots in the ASRS", nf(a.overall.total), { sub: "all aisles" })}
        ${stat("Occupied", nf(a.overall.occupied), { tone: "hero", sub: pct1(a.overall.pct) })}
        ${stat("Empty", nf(a.overall.empty))}
        ${stat("Duplicate slots", nf(a.anomalies.duplicateSlots), { tone: a.anomalies.duplicateSlots ? "warn" : "", sub: "same slot, two totes" })}
        ${stat("Unreadable locations", nf(a.anomalies.unparsedLocations), { tone: a.anomalies.unparsedLocations ? "warn" : "" })}
      </div>
      <div class="aisle-tabs">${tabs}</div>
      <div class="dd-grid">
        ${card(`Aisle ${sel.aisle} - by level (top to bottom)`, `<div class="levels">${levelRows}</div>`, { right: `<span class="dd-note">${nf(sel.occupied)} of ${nf(sel.total)} slots · ${pct1(sel.pct)}</span>` })}
        <div class="dd-stack">
          ${card("Side and depth", split("Left vs right side", sel.sides.left, sel.sides.right, "Left", "Right") + split("Front vs back depth", sel.depths.front, sel.depths.back, "Front", "Back"))}
          ${card("Top zones", list(sel.zones, "zone", "zone"))}
          ${card("Shuttle health", list(sel.shuttleHealth, "status", "shuttle"))}
        </div>
      </div>
      <p class="dd-note">Location Audit snapshot from ${esc(auditAt ? Fmt.time(auditAt) : "-")} (container tracking, refreshed every few minutes). Slots per level = 226 positions × 2 depths.</p>`;
  }

  function render() {
    const d = last;
    if (!d) return;
    const body = $("aoBody");
    const audit = d.audit
      ? auditHtml(d.audit, d.auditAt)
      : card("Location Audit detail", '<p class="dd-empty">The Location Audit data is not available right now. It retries automatically.</p>');
    const stale = d.grafana && d.grafana.stale
      ? `<div class="dd-banner warn">Showing the last good live reading - the latest refresh failed${d.grafana.staleReason ? ` (${esc(String(d.grafana.staleReason).slice(0, 140))})` : ""}. It retries automatically.</div>`
      : "";
    body.innerHTML = stale + liveHtml(d.grafana || {}) + audit;
    body.querySelectorAll("[data-aisle]").forEach((b) => b.addEventListener("click", () => { selectedAisle = Number(b.dataset.aisle); render(); }));
    $("aoEmpty").hidden = true;
    body.hidden = false;
  }

  function start() {
    if (off) return;
    off = Live.subscribe("aisle-occupancy.current", (evt) => {
      if (evt.type === "data") {
        last = evt.data;
        $("aoError").classList.add("hidden");
        $("aoUpdated").textContent = "Updated " + Fmt.time(evt.checkedAt || evt.at);
        render();
      } else if (evt.type === "checked" && last) {
        $("aoUpdated").textContent = "Updated " + Fmt.time(evt.checkedAt);
      } else if (evt.type === "feed-error") {
        // a failed refresh keeps the last good view on screen; it only explains itself
        $("aoError").textContent = `Couldn't refresh: ${evt.message}. It retries automatically.`;
        $("aoError").classList.remove("hidden");
      }
    });
  }

  function stop() {
    if (off) off();
    off = null;
  }

  $("aoRefreshBtn").addEventListener("click", () => {
    const btn = $("aoRefreshBtn");
    btn.disabled = true;
    Live.refresh("aisle-occupancy.current");
    setTimeout(() => { btn.disabled = false; }, 1500);
  });

  return { start, stop };
})();
