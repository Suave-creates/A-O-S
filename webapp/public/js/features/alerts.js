// Alerts page. Every alert lives here: GLOBAL (high escalation - also shown in the alert popup until
// acknowledged) and NORMAL (this page only). Acknowledge, add remarks, filter. Data is pushed by the
// server (shared "alerts" topic via AlertsTray); this screen never polls. The Analytics view summarises
// a period (today / 7 / 30 / 90 / 365 IST days) from GET /alerts/analytics.
const Alerts = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const listEl = $("alertsList");
  const summaryEl = $("alertsSummary");
  const rulesEl = $("alertsRules");
  const filtersEl = $("alertsFilters");

  let filter = { status: "OPEN", level: "ALL" };
  let off = null;
  const drafts = new Map(); // alert id -> unsaved remark text (survives live re-renders)
  let focusId = null;

  // Tabs: Open (not acknowledged), Acknowledged (acknowledged, no remark yet), Closed with remark (acknowledged and remarked).
  const statusTab = (a) => (a.status === "OPEN" ? "OPEN" : a.remark ? "CLOSED" : "ACKNOWLEDGED");

  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-");

  // The rule's own facts, shown under the title.
  function detailHtml(a) {
    const d = a.detail || {};
    if (a.ruleKey === "G1_TOTE_SHORT_QTY") {
      return `<div class="al-facts"><span><b>Tote</b> ${esc(d.tote)}</span><span><b>Station</b> ${esc(d.station || "-")}</span><span><b>Units short</b> ${esc(d.shortQty)}</span><span><b>Lines</b> ${esc(d.lines)}</span><span><b>Checked</b> ${esc(d.checkedAt)}</span><span class="al-thr">limit: more than ${esc(d.threshold)}</span></div>`;
    }
    if (a.ruleKey === "G2_STATION_SHORT_TOTES") {
      const totes = (d.totes || []).map((t) => `<span class="chip">${esc(t)}</span>`).join("");
      return `<div class="al-facts"><span><b>Station</b> ${esc(d.station)}</span><span><b>Hour</b> ${esc(d.hour)} IST</span><span><b>Marked short</b> ${esc(d.count)} totes</span>${(d.users || []).length ? `<span><b>By</b> ${esc(d.users.join(", "))}</span>` : ""}<span class="al-thr">limit: more than ${esc(d.threshold)} per hour (discrepancy station)</span></div><div class="chips al-totes">${totes}</div>`;
    }
    return "";
  }

  // A saved remark is shown as text (who/when) with ONE undo; with no remark there is the entry box.
  function remarkHtml(a, draft) {
    if (a.remark) {
      return `<div class="al-remark saved"><label>Remark</label><div class="al-remark-text">${esc(a.remark)}</div>
        <div class="al-remark-row"><span class="dd-note">Saved by ${esc(a.remarkBy)} ${esc(when(a.remarkAt))}</span>${a.undoAvailable ? `<button type="button" class="link" data-undo="${a.id}">Undo</button><span class="dd-note">(one time)</span>` : ""}</div></div>`;
    }
    return `<div class="al-remark"><label for="rm-${a.id}">Remark</label>
      <textarea id="rm-${a.id}" data-remark="${a.id}" rows="2" maxlength="1000" placeholder="What happened / what was done...">${esc(draft)}</textarea>
      <div class="al-remark-row"><button type="button" class="primary" data-save="${a.id}">Save remark</button></div></div>`;
  }

  function cardHtml(a) {
    const open = a.status === "OPEN";
    const draft = drafts.get(a.id) || "";
    return `<article class="al-card ${a.level === "GLOBAL" ? "global" : "normal"} ${open ? "open" : "ack"}${focusId === a.id ? " focus" : ""}" data-id="${a.id}">
      <div class="al-main">
        <div class="al-top">
          <span class="al-level ${a.level === "GLOBAL" ? "global" : "normal"}">${a.level === "GLOBAL" ? "GLOBAL" : "NORMAL"}</span>
          <h4>${esc(a.title)}</h4>
          <span class="status-pill ${open ? "status-FAILED" : "status-COMPLETED"}">${open ? "OPEN" : "ACKNOWLEDGED"}</span>
        </div>
        <div class="al-sub">Event ${esc(when(a.eventAt))} · raised ${esc(AlertsTray.ago(a.raisedAt))}${a.acknowledgedBy ? ` · acknowledged by <b>${esc(a.acknowledgedBy)}</b> ${esc(when(a.acknowledgedAt))}` : ""}</div>
        ${detailHtml(a)}
        ${remarkHtml(a, draft)}
      </div>
      ${open ? `<div class="al-side"><button type="button" class="primary" data-ack="${a.id}">Acknowledge</button></div>` : ""}
    </article>`;
  }

  let rulesSig = "";
  const isAdmin = () => !!(window.currentUserRole && window.currentUserRole() === "ADMIN");

  function ruleHtml(r) {
    const edit = isAdmin()
      ? `<div class="al-rule-edit"><label>More than <input type="number" min="0" max="100000" step="1" value="${esc(r.threshold)}" data-rule-thr="${esc(r.key)}"> ${esc(r.unit)}</label><label class="al-on"><input type="checkbox" data-rule-on="${esc(r.key)}" ${r.enabled ? "checked" : ""}> Enabled</label><button type="button" class="primary" data-rule-save="${esc(r.key)}">Save</button></div>`
      : `<div class="al-rule-edit"><span class="chip">${r.enabled ? "Enabled" : "Disabled"}</span></div>`;
    return `<li><span class="al-level ${r.level === "GLOBAL" ? "global" : "normal"}">${esc(r.level)}</span><div class="al-rule-body"><b>${esc(r.label)}</b><span>${esc(r.description)}</span><span class="dd-note">Default ${esc(r.default)} ${esc(r.unit)}${r.updatedBy ? " · last changed by " + esc(r.updatedBy) : ""}${isAdmin() ? "" : " · only admins can change limits"}</span>${edit}</div></li>`;
  }

  function render() {
    const state = AlertsTray.state;
    const all = state.alerts || [];
    const openGlobal = all.filter((a) => a.level === "GLOBAL" && a.status === "OPEN").length;
    const openNormal = all.filter((a) => a.level === "NORMAL" && a.status === "OPEN").length;
    const acked = all.filter((a) => a.status === "ACKNOWLEDGED").length;
    summaryEl.innerHTML = `
      <div class="dd-stat ${openGlobal ? "tone-danger" : ""}"><div class="dd-stat-k">Open · global</div><div class="dd-stat-v">${openGlobal}</div><div class="dd-stat-s">also in the alert popup</div></div>
      <div class="dd-stat"><div class="dd-stat-k">Open · normal</div><div class="dd-stat-v">${openNormal}</div><div class="dd-stat-s">this page only</div></div>
      <div class="dd-stat"><div class="dd-stat-k">Acknowledged</div><div class="dd-stat-v">${acked}</div><div class="dd-stat-s">last 7 days</div></div>`;

    filtersEl.querySelectorAll("[data-fs]").forEach((b) => b.classList.toggle("active", b.dataset.fs === filter.status));
    filtersEl.querySelectorAll("[data-fl]").forEach((b) => b.classList.toggle("active", b.dataset.fl === filter.level));

    const shown = all.filter((a) => statusTab(a) === filter.status && (filter.level === "ALL" || a.level === filter.level));
    // keep what the user is typing: capture drafts before re-rendering
    listEl.querySelectorAll("[data-remark]").forEach((t) => { if (t.value) drafts.set(Number(t.dataset.remark), t.value); });
    const hadFocus = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.remark;
    listEl.innerHTML = shown.length
      ? shown.map(cardHtml).join("")
      : `<div class="dd-empty-state"><i class="ico" data-i="alert"></i><h4>${filter.status === "OPEN" ? "No open alerts" : "Nothing here"}</h4><p>${state.engine && !state.engine.ok ? "The alert checks are failing right now: " + esc(state.engine.error) : filter.status === "OPEN" ? "Nothing needs attention right now." : "No alerts match these filters."}</p></div>`;
    if (hadFocus) { const t = listEl.querySelector(`[data-remark="${hadFocus}"]`); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
    if (focusId) { const c = listEl.querySelector(`[data-id="${focusId}"]`); if (c) c.scrollIntoView({ block: "center", behavior: "smooth" }); focusId = null; }

    // don't wipe a limit the admin is typing: only rebuild the rules card when its content changed
    const sig = JSON.stringify([isAdmin(), state.rules]);
    if (sig !== rulesSig && !rulesEl.contains(document.activeElement)) {
      rulesSig = sig;
      rulesEl.innerHTML = (state.rules || []).map(ruleHtml).join("") || '<li class="dd-empty">No rules loaded yet.</li>';
    }
  }

  filtersEl.addEventListener("click", (e) => {
    const s = e.target.closest("[data-fs]");
    const l = e.target.closest("[data-fl]");
    if (s) filter.status = s.dataset.fs;
    if (l) filter.level = l.dataset.fl;
    if (s || l) render();
  });

  rulesEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-rule-save]");
    if (!btn) return;
    const key = btn.dataset.ruleSave;
    const threshold = Number(rulesEl.querySelector(`[data-rule-thr="${key}"]`).value);
    const enabled = rulesEl.querySelector(`[data-rule-on="${key}"]`).checked;
    btn.disabled = true;
    try {
      await Api.put("/alerts/rules/" + key, { threshold, enabled });
      Toast.show({ title: "Rule saved", message: "Applied from the next check.", tone: "ok", ms: 2200 });
      rulesSig = "";
      await Live.refresh("alerts");
    } catch (err) {
      Toast.show({ title: "Couldn't save the rule", message: err.message, tone: "danger" });
    } finally {
      btn.disabled = false;
    }
  });

  listEl.addEventListener("click", async (e) => {
    const ack = e.target.closest("[data-ack]");
    if (ack) return AlertsTray.acknowledge(Number(ack.dataset.ack), ack);
    const undo = e.target.closest("[data-undo]");
    if (undo) {
      undo.disabled = true;
      try {
        await Api.post("/alerts/" + undo.dataset.undo + "/remark/undo");
        Toast.show({ title: "Remark undone", tone: "ok", ms: 1800 });
        await Live.refresh("alerts");
      } catch (err) {
        Toast.show({ title: "Couldn't undo", message: err.message, tone: "warn" });
        undo.disabled = false;
      }
      return;
    }
    const save = e.target.closest("[data-save]");
    if (!save) return;
    const id = Number(save.dataset.save);
    const text = listEl.querySelector(`[data-remark="${id}"]`).value.trim();
    if (!text) return Toast.show({ title: "Write a remark first", tone: "warn", ms: 2000 });
    save.disabled = true;
    try {
      await Api.post("/alerts/" + id + "/remark", { text });
      drafts.delete(id);
      Toast.show({ title: "Remark saved", tone: "ok", ms: 1800 });
      await Live.refresh("alerts");
    } catch (err) {
      Toast.show({ title: "Couldn't save the remark", message: err.message, tone: "danger" });
    } finally {
      save.disabled = false;
    }
  });

  // ── Analytics view ─────────────────────────────────────────────────────────────────────────────
  // Fetched when the view opens, when the period changes, and again only when the live alert list
  // actually changes (a new alert, an acknowledgement, a remark) - never on a timer.
  const listView = $("alertsListView");
  const anaView = $("alertsAnalyticsView");
  const anaEl = $("alertsAnalytics");
  const anaAtEl = $("alertsAnalyticsAt");
  const anaFiltersEl = $("alertsAnalyticsFilters");
  const viewSwitch = $("alertsViewSwitch");
  let view = "list";
  let period = "7d";
  let anaData = null;
  let anaSeq = 0;
  let liveSig = "";
  let refetchTimer = null;

  const nf = (n) => Fmt.num(n) || "0";
  const mins = (m) => (m == null ? "No data" : Fmt.duration(m * 60000) || "under 1 s");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayLabel = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
  const hh = (h) => String(h).padStart(2, "0");
  const stat = (k, v, { tone = "", sub = "" } = {}) => `<div class="dd-stat ${tone ? "tone-" + tone : ""}"><div class="dd-stat-k">${esc(k)}</div><div class="dd-stat-v">${v}</div>${sub ? `<div class="dd-stat-s">${esc(sub)}</div>` : ""}</div>`;
  const card = (title, inner) => `<section class="dd-card"><header><h4>${esc(title)}</h4></header>${inner}</section>`;
  const table = (head, rows, empty) => (rows.length ? `<div class="dd-scroll"><table class="dd-table"><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` : `<p class="dd-empty">${esc(empty)}</p>`);
  const levelLegend = '<div class="dd-legend"><span class="tone-global">Global</span><span class="tone-normal">Normal</span><span class="dd-note">IST days</span></div>';

  function renderAnalytics() {
    anaFiltersEl.querySelectorAll("[data-period]").forEach((b) => b.classList.toggle("active", b.dataset.period === period));
    const d = anaData;
    if (!d) {
      anaAtEl.textContent = "";
      anaEl.innerHTML = '<div class="modal-loading"><span class="spinner"></span>Loading analytics&hellip;</div>';
      return;
    }
    if (d.error) {
      anaAtEl.textContent = "";
      anaEl.innerHTML = `<div class="dd-empty-state"><i class="ico" data-i="alert"></i><h4>Analytics unavailable</h4><p>${esc(d.error)}</p></div>`;
      return;
    }
    anaAtEl.textContent = "Updated " + Fmt.time(d.generatedAt);
    const t = d.totals;
    const h = d.history;
    if (!t.total) {
      anaEl.innerHTML = `<div class="dd-empty-state"><i class="ico" data-i="chart"></i><h4>No alerts in this period</h4><p>Pick a longer period to see trends.</p></div>`;
      return;
    }
    const dayChart = d.byDay.length > 1
      ? card("Alerts per day", Charts.bars(d.byDay.map((x) => ({ label: dayLabel(x.day), value: x.GLOBAL, tone: "global", value2: x.NORMAL, tone2: "normal", tip: `${dayLabel(x.day)}: ${x.GLOBAL} global, ${x.NORMAL} normal` })), { unit: "alerts" }) + levelLegend)
      : "";
    const hourChart = card("By hour of day (IST)", Charts.bars(d.byHour.map((h) => ({ label: hh(h.hour), value: h.count, tone: "b", tip: `${hh(h.hour)}:00-${hh(h.hour + 1)}:00 - ${h.count} alerts` })), { height: 180, unit: "alerts" }));
    const ruleRows = d.byRule.map((r) => `<tr><td><span class="al-level ${r.level === "GLOBAL" ? "global" : "normal"}">${esc(r.level)}</span> ${esc(r.label)}</td><td class="num">${nf(r.total)}</td><td class="num">${nf(r.open)}</td><td class="num">${esc(mins(r.ack.medianMin))}</td><td class="num">${esc(mins(r.ack.p90Min))}</td></tr>`);
    const personRows = d.byPerson.map((p) => `<tr><td><b>${esc(p.employeeId)}</b></td><td class="num">${nf(p.acknowledged)}</td><td class="num">${esc(p.acknowledged ? mins(p.ack.medianMin) : "Not acknowledged")}</td><td class="num">${nf(p.remarks)}</td></tr>`);
    const stationRows = d.byStation.map((s) => `<tr><td><b>${esc(s.station)}</b></td><td class="num">${nf(s.count)}</td></tr>`);

    anaEl.innerHTML = `<div class="al-analytics">
      ${d.capped ? '<div class="dd-banner warn">This period has more alerts than can be summarised at once - the figures cover the most recent ones only.</div>' : ""}
      <div class="dd-stats">
        ${stat("Alerts raised", nf(t.total), { tone: "hero", sub: `${nf(t.global)} global · ${nf(t.normal)} normal` })}
        ${stat("Still open", nf(t.open), { tone: t.open ? "danger" : "", sub: "from this period" })}
        ${stat("Acknowledged", nf(t.acknowledged), { sub: `${Math.round((t.acknowledged / t.total) * 100)}% of raised` })}
        ${stat("Median time to acknowledge", esc(mins(d.ack.medianMin)), { sub: d.ack.count ? `90% within ${mins(d.ack.p90Min)}` : "nothing acknowledged yet" })}
        ${stat("With a remark", Math.round((t.withRemark / t.total) * 100) + "%", { sub: `${nf(t.withRemark)} of ${nf(t.total)}` })}
      </div>
      ${h ? `<div class="dd-stats">
        ${stat("Remarks saved", nf(h.remarksSaved), { sub: h.remarksUndone ? `${nf(h.remarksUndone)} undone` : "none undone" })}
        ${stat("Median time to first remark", esc(mins(h.firstRemark.medianMin)), { sub: h.firstRemark.count ? `90% within ${mins(h.firstRemark.p90Min)}` : "no remarks yet" })}
        ${stat("Grew after raising", nf(h.grew), { sub: "alerts whose count kept rising" })}
      </div>` : ""}
      ${dayChart}
      ${hourChart}
      ${card("By rule", table('<th>Rule</th><th class="num">Raised</th><th class="num">Open</th><th class="num">Median to ack</th><th class="num">90% within</th>', ruleRows, "No rules fired."))}
      <div class="dd-grid even">
        ${card("Who responded", table('<th>Employee</th><th class="num">Acknowledged</th><th class="num">Median to ack</th><th class="num">Remarks</th>', personRows, "No one has acknowledged or remarked yet."))}
        ${card("Stations with most alerts", table('<th>Station</th><th class="num">Alerts</th>', stationRows, "No station-level alerts in this period."))}
      </div>
      <p class="dd-note">Periods are whole IST days ending today, counted by when the event happened. Time to acknowledge / first remark runs from when the alert appeared in AOS. The per-day chart comes from the daily rollup, refreshed with each alert check (about every 2 minutes).</p>
    </div>`;
  }

  async function loadAnalytics() {
    const seq = ++anaSeq;
    if (!anaData || anaData.period !== period) { anaData = null; renderAnalytics(); }
    try {
      const d = await Api.get("/alerts/analytics?period=" + encodeURIComponent(period));
      if (seq !== anaSeq) return;
      anaData = d;
    } catch (err) {
      if (seq !== anaSeq) return;
      // keep the last good figures on screen; only a first load turns into the error state
      if (anaData && anaData.period === period && !anaData.error) return Toast.show({ title: "Couldn't update analytics", message: err.message, tone: "warn" });
      anaData = { period, error: err.message };
    }
    renderAnalytics();
  }

  function setView(v) {
    view = v;
    viewSwitch.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    listView.hidden = v !== "list";
    anaView.hidden = v !== "analytics";
    if (v === "analytics") loadAnalytics();
  }

  // Live push: re-render the list; refetch analytics only when the alert list itself changed.
  function onLive() {
    render();
    const sig = (AlertsTray.state.alerts || []).map((a) => `${a.id}:${a.status}:${a.remark ? 1 : 0}`).join(",");
    if (sig === liveSig) return;
    const first = !liveSig;
    liveSig = sig;
    if (first || view !== "analytics") return;
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(loadAnalytics, 1500);
  }

  viewSwitch.addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (b && b.dataset.view !== view) setView(b.dataset.view);
  });
  anaFiltersEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-period]");
    if (!b || b.dataset.period === period) return;
    period = b.dataset.period;
    loadAnalytics();
  });

  // Subscribed only while the Alerts tab is open (the shell keeps its own subscription for the popup).
  function start() {
    const hashId = Number((location.hash.match(/alert=(\d+)/) || [])[1]);
    if (hashId) {
      focusId = hashId;
      if (view !== "list") setView("list");
    }
    if (off) return;
    off = AlertsTray.subscribe(onLive);
    if (view === "analytics") loadAnalytics();
  }
  function stop() {
    if (off) { off(); off = null; }
    clearTimeout(refetchTimer);
    liveSig = "";
  }

  return { start, stop };
})();
