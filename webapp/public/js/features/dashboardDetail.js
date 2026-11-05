// Dashboard drill-downs. Clicking a tile opens a large popup with everything
// behind that number since 06:00 IST, hour by hour. (The grouped tiles - Tote
// Utilisation, Totes in ASRS, Aisle Occupancy - open their own screens instead.)
// The popup stays live: it subscribes to
// "dashboard-detail:<metric>" (server-pushed, shared fetch) while it is open and
// unsubscribes when it closes, so a closed popup costs the server nothing.
//
// Data comes from the server's single data layer (the same one the One Pager
// Report uses), so a popup always agrees with its tile.
const DashboardDetail = (() => {
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const nf = (n) => (n == null ? "No data" : Fmt.num(n));

  const META = {
    compaction: { icon: "compact", title: "Compaction", blurb: "Compaction events recorded by the ASRS" },
    toteFreed: { icon: "package", title: "Tote Freed", blurb: "Totes emptied by compaction and free to reuse" },
    ccDone: { icon: "checkcircle", title: "CC Done", blurb: "Proper cycle counts, Bermuda totes and the stations behind them" },
    discrepancies: { icon: "filter", title: "Discrepancies Marked", blurb: "Cycle-count events marked SHORT" },
    outside: { icon: "outbound", title: "Outside Totes", blurb: "Totes outside the ASRS for 12 hours or more" },
    locked: { icon: "lock", title: "Locked Totes", blurb: "Totes locked in the ASRS, hour by hour from the snapshots taken today" },
  };
  const TONE = { A: "a", B: "b", C: "c" };

  let active = null; // { modal, off, metric }
  let pendingFocus = null; // section to scroll to after the next render (e.g. "bermuda")
  let filterText = ""; // the CC Done list filter survives live re-renders

  // ── building blocks ────────────────────────────────────────────────────
  const stat = (label, value, { tone = "", sub = "" } = {}) =>
    `<div class="dd-stat ${tone ? "tone-" + tone : ""}"><div class="dd-stat-k">${esc(label)}</div><div class="dd-stat-v">${value}</div>${sub ? `<div class="dd-stat-s">${esc(sub)}</div>` : ""}</div>`;

  const card = (title, inner, { cls = "", right = "" } = {}) =>
    `<section class="dd-card ${cls}"><header><h4>${esc(title)}</h4>${right}</header>${inner}</section>`;

  function table(columns, rows, { empty = "Nothing to show yet." } = {}) {
    if (!rows.length) return `<p class="dd-empty">${esc(empty)}</p>`;
    const head = columns.map(([, label]) => `<th>${esc(label)}</th>`).join("");
    const body = rows.map((r) => `<tr>${columns.map(([k]) => `<td>${esc(typeof r[k] === "number" ? nf(r[k]) : r[k])}</td>`).join("")}</tr>`).join("");
    return `<div class="dd-scroll"><table class="dd-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  const staleBanner = (d) =>
    d.stale ? `<div class="dd-banner warn">Showing the last good data - the latest refresh failed${d.staleReason ? ` (${esc(String(d.staleReason).slice(0, 140))})` : ""}. It retries automatically.</div>` : "";

  // ── hourly metrics ─────────────────────────────────────────────────────
  // "05:54 IST today (before this site day began)" / "12 Oct, 21:15 IST"
  function lastEventText(d) {
    const le = d.lastEvent;
    if (!le) return "";
    const sameDay = le.date === d.siteDay;
    const nice = new Date(le.date + "T00:00:00Z").toLocaleDateString([], { day: "numeric", month: "short", timeZone: "UTC" });
    return sameDay ? `Last recorded today at ${le.time} IST - before this site day began at 06:00.` : `Last recorded ${nice} at ${le.time} IST.`;
  }

  // A real zero (nothing happened) is stated plainly instead of an empty chart.
  function zeroState(d) {
    return `<div class="dd-empty-state"><i class="ico" data-i="${META[d.metric].icon}"></i><h4>No ${esc(d.unit)} recorded since 06:00 IST</h4><p>${esc(lastEventText(d)) || "Nothing has been recorded in this site day yet."} This is a real zero, not missing data - the view fills in as soon as a record arrives.</p></div>`;
  }

  // ── Locked totes: a level, so each hour shows the count at the end of that hour (last snapshot in it) ──
  function renderLocked(d) {
    const items = d.hours.map((h) => ({
      label: h.label, value: h.value, tone: TONE[h.shift], current: h.status === "current",
      tip: h.label + " (shift " + h.shift + "): " + (h.value == null ? (h.status === "future" ? "not reached yet" : "no snapshot taken") : nf(h.value) + " locked" + (h.at ? " at " + h.at : "")),
    }));
    const hourRows = d.hours.map((h, i) => {
      const prev = d.hours.slice(0, i).reverse().find((x) => x.value != null);
      const diff = h.value != null && prev ? h.value - prev.value : null;
      return '<tr class="' + (h.status === "current" ? "is-now" : "") + (h.status === "future" ? " is-future" : "") + '">' +
        "<td>" + esc(h.label) + '</td><td><span class="shift-chip tone-' + TONE[h.shift] + '">' + h.shift + "</span></td>" +
        '<td class="num">' + (h.value == null ? (h.status === "future" ? "-" : "no snapshot") : nf(h.value)) + "</td>" +
        '<td class="num">' + (diff == null ? "-" : (diff > 0 ? "+" : "") + nf(diff)) + "</td>" +
        '<td class="num">' + nf(h.p0) + '</td><td class="num">' + nf(h.p1) + '</td><td class="num">' + nf(h.p2) + '</td><td class="num">' + nf(h.sd) + "</td>" +
        '<td class="num">' + (h.snapshots || "-") + "</td><td>" + (h.status === "current" ? '<span class="now-tag">now</span>' : "") + "</td></tr>";
    }).join("");
    const n = d.now;
    return '<div class="dd-stats">' +
        stat("Locked now", n ? nf(n.total) : "-", { tone: "hero", sub: n ? "snapshot at " + n.at + " IST" : "no snapshot yet today" }) +
        stat("Since 06:00", d.change == null ? "-" : (d.change > 0 ? "+" : "") + nf(d.change), { tone: d.change > 0 ? "warn" : "", sub: d.start ? "from " + nf(d.start.total) + " at " + d.start.at : "" }) +
        stat("Peak hour", d.peak ? nf(d.peak.value) : "-", { sub: d.peak ? d.peak.label : "no data yet" }) +
        stat("Lowest hour", d.low ? nf(d.low.value) : "-", { sub: d.low ? d.low.label : "no data yet" }) +
        stat("P0 · P1 · P2 · SD", n ? nf(n.p0) + " · " + nf(n.p1) + " · " + nf(n.p2) + " · " + nf(n.sd) : "-", { sub: "by priority, now" }) +
        stat("Snapshots today", nf(d.snapshotCount), { sub: "refreshed automatically every 15 min" }) +
      "</div>" +
      (d.snapshotCount ? card("Locked totes by hour (IST)", Charts.bars(items, { unit: "locked" }) + '<div class="dd-legend"><span class="tone-a">Shift A</span><span class="tone-b">Shift B</span><span class="tone-c">Shift C</span><span class="dd-note">value = last snapshot in the hour</span></div>') : card("Locked totes by hour (IST)", '<p class="dd-empty">No Locked Tote snapshot has been taken since 06:00. One is refreshed automatically while the app is open.</p>')) +
      card("Hour by hour", '<div class="dd-scroll tall"><table class="dd-table hours"><thead><tr><th>Hour</th><th>Shift</th><th class="num">Locked</th><th class="num">Change</th><th class="num">P0</th><th class="num">P1</th><th class="num">P2</th><th class="num">SD</th><th class="num">Snapshots</th><th></th></tr></thead><tbody>' + hourRows + "</tbody></table></div>") +
      '<p class="dd-note"><button class="link" data-go-locked>Open Locked Tote Information</button> for the tote-by-tote list.</p>';
  }

  function renderHourly(d) {
    const s = d.shifts || {};
    const items = d.hours.map((h) => ({
      label: h.label, value: h.value, tone: TONE[h.shift], current: h.status === "current",
      tip: `${h.label} (shift ${h.shift}): ${h.value == null ? "not reached yet" : nf(h.value) + " " + d.unit}`,
    }));
    const max = Math.max(1, ...d.hours.map((h) => h.value || 0));
    const hourRows = d.hours.map((h) => `<tr class="${h.status === "current" ? "is-now" : ""}${h.status === "future" ? " is-future" : ""}">
      <td>${esc(h.label)}</td><td><span class="shift-chip tone-${TONE[h.shift]}">${h.shift}</span></td>
      <td class="num">${h.value == null ? "-" : nf(h.value)}</td>
      <td class="share">${h.value == null ? "" : `<span class="meter tone-${TONE[h.shift]}"><i style="width:${Math.round((h.value / max) * 100)}%"></i></span>`}</td>
      <td>${h.status === "current" ? '<span class="now-tag">now</span>' : ""}</td></tr>`).join("");
    const sections = (d.sections || []).map((sec) => card(sec.title, table(sec.columns, sec.rows, { empty: "No rows yet today." }))).join("");
    return `${staleBanner(d)}
      <div class="dd-stats">
        ${stat("Today (06:00 → now)", nf(s.Total), { tone: "hero", sub: d.unit })}
        ${stat("Shift A · 06-14", nf(s.A), { tone: "a" })}
        ${stat("Shift B · 14-22", nf(s.B), { tone: "b" })}
        ${stat("Shift C · 22-06", nf(s.C), { tone: "c" })}
        ${stat("Peak hour", d.peak ? nf(d.peak.value) : "-", { sub: d.peak ? d.peak.label : "no data yet" })}
        ${stat("Average / hour", d.perHour == null ? "-" : nf(d.perHour), { sub: "hours so far" })}
      </div>
      ${(s.Total || 0) === 0 && d.hours.every((h) => !h.value) ? card("By hour (IST)", zeroState(d)) : card("By hour (IST)", `${Charts.bars(items, { unit: d.unit })}<div class="dd-legend"><span class="tone-a">Shift A</span><span class="tone-b">Shift B</span><span class="tone-c">Shift C</span><span class="dd-note">Hours not reached yet stay empty.</span></div>`)}
      <div class="dd-grid">
        ${card("Hour by hour", `<div class="dd-scroll tall"><table class="dd-table hours"><thead><tr><th>Hour</th><th>Shift</th><th class="num">Value</th><th></th><th></th></tr></thead><tbody>${hourRows}</tbody></table></div>`)}
        <div class="dd-stack">${sections || card("Details", '<p class="dd-empty">No further breakdown for this metric.</p>')}</div>
      </div>`;
  }

  // ── CC Done: proper cycle counts + Bermuda totes + stations ──────────────
  function renderCc(d) {
    const s = d.shifts || {};
    const b = d.bermuda || { shifts: {}, hours: [], rows: [], total: 0 };
    const st = d.stations || { ran: {}, runningNow: 0, runningWindowMin: 10 };
    const items = d.hours.map((h, i) => ({
      label: h.label, value: h.value, tone: TONE[h.shift], current: h.status === "current", value2: h.value == null ? 0 : b.hours[i] || 0, tone2: "bermuda",
      tip: h.label + " (shift " + h.shift + "): " + (h.value == null ? "not reached yet" : nf(h.value) + " CC Done · " + nf(b.hours[i] || 0) + " Bermuda"),
    }));
    const max = Math.max(1, ...d.hours.map((h, i) => (h.value || 0) + (b.hours[i] || 0)));
    const hourRows = d.hours.map((h, i) => '<tr class="' + (h.status === "current" ? "is-now" : "") + (h.status === "future" ? " is-future" : "") + '">' +
      "<td>" + esc(h.label) + '</td><td><span class="shift-chip tone-' + TONE[h.shift] + '">' + h.shift + "</span></td>" +
      '<td class="num">' + (h.value == null ? "-" : nf(h.value)) + '</td><td class="num">' + (h.value == null ? "-" : nf(b.hours[i] || 0)) + '</td><td class="num">' + (h.value == null ? "-" : nf((d.shortQty && d.shortQty.hours[i]) || 0)) + "</td>" +
      '<td class="share">' + (h.value == null ? "" : '<span class="meter tone-' + TONE[h.shift] + '"><i style="width:' + Math.round(((h.value + (b.hours[i] || 0)) / max) * 100) + '%"></i></span>') + "</td>" +
      "<td>" + (h.status === "current" ? '<span class="now-tag">now</span>' : "") + "</td></tr>").join("");
    const stationRows = (d.sections[0] ? d.sections[0].rows : []).map((r) => ({ ...r, running: r.running ? "● running" : "" }));
    const stationCard = card("Stations", table(d.sections[0].columns, stationRows, { empty: "No station has run a cycle count yet today." }),
      { right: '<span class="dd-note">' + nf(st.ran.Day) + " ran today · " + nf(st.runningNow) + " running now</span>" });
    const bermudaCard = card("Bermuda totes (" + nf(b.total) + ")", b.rows.length
      ? table([["tote", "Tote"], ["station", "Station"], ["time", "Last check (IST)"], ["lines", "Lines (all SHORT)"], ["shortQty", "Qty short"], ["multi", "Shifts"]], b.rows, {})
      : '<p class="dd-empty">No Bermuda totes so far today.</p>', { right: b.rows.length ? '<button class="link" data-copy-bermuda>Copy table</button>' : "" });
    const pg = d.purged || { shifts: {}, total: 0, rows: [], shortQty: {} };
    const purgedCard = card("Purged totes (" + nf(pg.total) + ")", pg.rows.length
      ? table([["tote", "Tote"], ["station", "Station"], ["time", "Last check (IST)"], ["lines", "Lines"], ["shortQty", "Qty short"]], pg.rows, {})
      : '<p class="dd-empty">No purge-pulled tote has been confirmed empty in Quadron yet today.</p>', { right: pg.rows.length ? '<button class="link" data-copy-purged>Copy table</button>' : "" });
    const dn = d.done || { total: 0, rows: [] };
    const doneCard = card("CC Done totes (" + nf(dn.total) + ")", dn.rows.length
      ? '<input type="search" class="dd-filter" data-filter="done" placeholder="Filter by tote, station or wrong report" />' + table([["tote", "Tote"], ["station", "Station"], ["time", "Last check (IST)"], ["lines", "Lines"], ["shortQty", "Qty short"], ["flag", "Flag"], ["multi", "Shifts"]], dn.rows, {})
      : '<p class="dd-empty">No CC Done totes yet today.</p>', { cls: "dd-done", right: dn.rows.length ? '<button class="link" data-copy-done>Copy table</button>' : "" });
    const ms = d.multiShift || { total: 0, rows: [], bermudaInMultiple: 0 };
    const multiCard = ms.total
      ? card("Checked in more than one shift (" + nf(ms.total) + ")", table([["tote", "Tote"], ["A", "Shift A"], ["B", "Shift B"], ["C", "Shift C"]], ms.rows, {}), { right: '<span class="dd-note">counted in each shift · the day totals are the sum of the shifts</span>' })
      : "";
    return staleBanner(d) +
      '<div class="dd-stats">' +
        stat("CC Done today", nf(s.Total), { tone: "hero", sub: "proper cycle counts" }) +
        stat("Bermuda totes", nf(b.shifts.Total), { tone: "bermuda", sub: nf(b.total) + " distinct" + (b.shifts.Total !== b.total ? " · " + nf(b.shifts.Total - b.total) + " counted in 2 shifts" : "") }) +
        stat("Purged totes", nf((pg.shifts || {}).Total || 0), { tone: "purged", sub: nf((pg.shortQty || {}).Total || 0) + " units marked short · confirmed empty in Quadron" }) +
        stat("Wrongly reported", nf(dn.wrongReports || 0), { tone: dn.wrongReports ? "warn" : "", sub: "CC Done totes where every line matched" }) +
        stat("Qty marked short", nf((d.shortQty || { shifts: {} }).shifts.Total), { tone: "warn", sub: nf(b.shortQty ? b.shortQty.Total : 0) + " units in Bermuda totes" }) +
        stat("Checked in total", nf((d.checked || {}).Total), { sub: (d.multiShift ? nf(d.multiShift.distinctChecked) + " distinct · " + nf(d.multiShift.total) + " in 2+ shifts" : "CC Done + Bermuda") }) +
        stat("Stations ran today", nf(st.ran.Day), { sub: "A " + nf(st.ran.A) + " · B " + nf(st.ran.B) + " · C " + nf(st.ran.C) }) +
        stat("Running now", nf(st.runningNow), { tone: st.runningNow ? "a" : "", sub: "checked in the last " + st.runningWindowMin + " min" }) +
        stat("Peak hour", d.peak ? nf(d.peak.value) : "-", { sub: d.peak ? d.peak.label : "no data yet" }) +
      "</div>" +
      '<div class="dd-stats">' +
        stat("Shift A · 06-14", nf(s.A), { tone: "a", sub: "Bermuda " + nf(b.shifts.A) }) +
        stat("Shift B · 14-22", nf(s.B), { tone: "b", sub: "Bermuda " + nf(b.shifts.B) }) +
        stat("Shift C · 22-06", nf(s.C), { tone: "c", sub: "Bermuda " + nf(b.shifts.C) }) +
      "</div>" +
      card("By hour (IST)", Charts.bars(items, { unit: d.unit }) + '<div class="dd-legend"><span class="tone-a">CC Done · A</span><span class="tone-b">B</span><span class="tone-c">C</span><span class="tone-bermuda">Bermuda (stacked)</span><span class="dd-note">Hours not reached yet stay empty.</span></div>') +
      '<p class="dd-note def"><b>CC Done</b> = a checked tote where at least one line was found. <b>Bermuda</b> = a tote whose latest check marked every line SHORT (nothing found), so it is not counted as a cycle count. <b>Purged</b> = a tote called through the Manual Tote Puller with the Purge toggle on, for which Quadron then showed no inventory; it is not counted as CC Done or Bermuda. A tote re-counted properly later moves to CC Done.</p>' +
      '<div class="dd-grid">' +
        card("Hour by hour", '<div class="dd-scroll tall"><table class="dd-table hours"><thead><tr><th>Hour</th><th>Shift</th><th class="num">CC Done</th><th class="num">Bermuda</th><th class="num">Qty short</th><th></th><th></th></tr></thead><tbody>' + hourRows + "</tbody></table></div>") +
        '<div class="dd-stack" id="dd-bermuda-anchor">' + bermudaCard + '<div id="dd-purged-anchor">' + purgedCard + '</div>' + doneCard + multiCard + stationCard + "</div>" +
      "</div>";
  }

  // ── Outside totes ──────────────────────────────────────────────────────
  function renderOutside(d) {
    const chips = (list) => (list.length ? `<div class="chips">${list.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : '<p class="dd-empty">None.</p>');
    const copyBtn = (key) => `<button class="link" data-copy="${key}">Copy list</button>`;
    return `${staleBanner(d)}
      <div class="dd-stats">
        ${stat("Outside 24h+", nf(d.counts.h24plus), { tone: "danger", sub: "oldest first to chase" })}
        ${stat("Outside 12-24h", nf(d.counts.h12to24), { tone: "warn" })}
        ${stat("Total outside", nf(d.counts.total), { tone: "hero" })}
      </div>
      <div class="dd-grid even">
        ${card("Above 24 hours", chips(d.lists.h24plus), { right: copyBtn("h24plus") })}
        ${card("12 - 24 hours", chips(d.lists.h12to24), { right: copyBtn("h12to24") })}
      </div>
      <p class="dd-note">Outside Tote status only (never Bad Tracker). The list is a live snapshot of right now, refreshed every few minutes.</p>`;
  }

  // ── plumbing ───────────────────────────────────────────────────────────
  function render(modal, d) {
    const body = modal.body;
    const scroll = body.scrollTop;
    const html = d.kind === "locked" ? renderLocked(d) : d.metric === "ccDone" ? renderCc(d) : d.kind === "hourly" ? renderHourly(d) : renderOutside(d);
    body.innerHTML = `<div class="dd">${html}</div>`;
    body.scrollTop = scroll;
    wire(modal, d);
  }

  function wire(modal, d) {
    // Copy list copies the WHOLE table (header + every column), tab-separated so it pastes straight into
    // Excel / Sheets. Rows hidden by the filter box are left out, so a filtered view copies as filtered.
    const copyTable = (btn) => btn && btn.addEventListener("click", async () => {
      const table = btn.closest(".dd-card").querySelector("table");
      const clean = (t) => String(t).replace(/[\t\r\n]+/g, " ").trim();
      const lines = [...table.querySelectorAll("tr")].filter((tr) => tr.style.display !== "none").map((tr) => [...tr.children].map((c) => clean(c.innerText)).join("\t"));
      try {
        await navigator.clipboard.writeText(lines.join("\n"));
        Toast.show({ title: "Copied", message: (lines.length - 1) + " rows with all columns", tone: "ok", ms: 1800 });
      } catch (e) {
        Toast.show({ title: "Couldn't copy", tone: "warn" });
      }
    });
    copyTable(modal.body.querySelector("[data-copy-bermuda]"));
    copyTable(modal.body.querySelector("[data-copy-done]"));
    copyTable(modal.body.querySelector("[data-copy-purged]"));
    const gl = modal.body.querySelector("[data-go-locked]");
    if (gl) gl.addEventListener("click", () => { close(); location.hash = "#lockedToteInfo"; });
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
    if (pendingFocus === "bermuda" || pendingFocus === "purged") {
      const anchor = modal.body.querySelector(pendingFocus === "purged" ? "#dd-purged-anchor" : "#dd-bermuda-anchor");
      pendingFocus = null;
      if (anchor) anchor.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    modal.body.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText((d.lists[b.dataset.copy] || []).join("\n"));
        Toast.show({ title: "Copied", message: `${(d.lists[b.dataset.copy] || []).length} totes`, tone: "ok", ms: 1800 });
      } catch (e) {
        Toast.show({ title: "Couldn't copy", tone: "warn" });
      }
    }));
  }

  function close() {
    if (active) Modal.close();
  }

  // opts.focus: "bermuda" scrolls the CC Done popup straight to the Bermuda list.
  function open(metric, opts = {}) {
    const meta = META[metric];
    if (!meta) return;
    close();
    pendingFocus = opts.focus || null;
    filterText = "";
    const modal = Modal.open({ title: meta.title, subtitle: `${meta.blurb} · today since 06:00 IST`, icon: meta.icon, onClose: () => { if (active && active.off) active.off(); active = null; } });
    let hasData = false;
    const off = Live.subscribe("dashboard-detail:" + metric, (evt) => {
      if (!modal.isOpen()) return;
      if (evt.type === "data") {
        hasData = true;
        render(modal, evt.data);
        modal.setLive("live", `LIVE · ${Fmt.time(evt.checkedAt || Date.now())}`);
      } else if (evt.type === "checked" && hasData) {
        modal.setLive("live", `LIVE · ${Fmt.time(evt.checkedAt)}`);
      } else if (evt.type === "feed-error") {
        if (!hasData) modal.body.innerHTML = `<div class="dd-banner danger">Couldn't load this view: ${esc(evt.message)}. It retries automatically.</div>`;
        else modal.setLive("reconnecting", "STALE");
      }
    });
    active = { modal, off, metric };
    modal.setLive("connecting", "LOADING");
  }

  return { open, close, META };
})();
