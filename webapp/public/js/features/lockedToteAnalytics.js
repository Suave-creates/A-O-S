// Locked Tote Analytics - how cycle counts really happen (server: features/locked-tote-info/toteAnalytics*.js).
// One range at a time (today / yesterday / 7 / 30 days): headline tiles, class x outcome, day by day, GTP and
// reporting stations, and the tote lists (ghost, repeat tote, repeat SKU, pending, still locked, re-reported).
// Read on opening the tab and on Refresh; the server keeps closed days, so only today is read from Grafana.
const LockedToteAnalytics = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const nf = (n) => (n == null ? "—" : Fmt.num(n));
  const pc = (n) => (n == null ? "—" : `${n}%`);
  const when = (ms) => (ms == null ? "—" : Fmt.when(new Date(ms).toISOString()));
  const dur = (min) => (min == null ? "—" : min < 60 ? `${min} min` : min < 1440 ? `${(min / 60).toFixed(1)} h` : `${(min / 1440).toFixed(1)} d`);
  const dayName = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short" });

  const OUTCOME = { ALL_ALRIGHT: "All ALRIGHT", SHORT: "Short", EXCESS: "Excess", SHORT_EXCESS: "Short + Excess", BERMUDA: "Bermuda" };
  const CLS = { PROPER: "Proper CC", GHOST: "Ghost", PURGED: "Purged" };
  const VIA = { OUTSIDE: "Outside AOS", AOS_MANUAL: "AOS Manual", AOS_AUTO: "AOS Auto" };
  const clsChip = (c, via) => `<span class="lta-cls ${String(c || "").toLowerCase()}">${esc(CLS[c] || c || "")}${c === "GHOST" && via ? ` · ${esc(VIA[via] || via)}` : ""}</span>`;
  const outChip = (o) => `<span class="lta-out ${String(o || "").toLowerCase()}">${esc(OUTCOME[o] || o || "")}</span>`;

  // the tote lists: tab key -> heading, columns [label, value(row), csv(row)]
  const LISTS = {
    ghosts: { label: "Ghost totes", cols: [["Tote", (r) => `<b>${esc(r.tote)}</b>`, (r) => r.tote], ["Counted", (r) => when(r.ms), (r) => new Date(r.ms).toISOString()], ["GTP station", (r) => esc(r.station), (r) => r.station], ["User", (r) => esc(r.user), (r) => r.user], ["Called", (r) => esc(VIA[r.via] || r.via) + (r.pulledBy ? ` (${esc(r.pulledBy)})` : ""), (r) => VIA[r.via] || r.via], ["Outcome", (r) => outChip(r.outcome), (r) => OUTCOME[r.outcome]], ["Short qty", (r) => nf(r.shortQty), (r) => r.shortQty]] },
    repeatTotes: { label: "Repeat tote", cols: [["Tote", (r) => `<b>${esc(r.tote)}</b>`, (r) => r.tote], ["Counted", (r) => when(r.ms), (r) => new Date(r.ms).toISOString()], ["This count", (r) => clsChip(r.cls, r.via), (r) => CLS[r.cls]], ["Outcome", (r) => outChip(r.outcome), (r) => OUTCOME[r.outcome]], ["Counted before", (r) => when(r.prevMs), (r) => new Date(r.prevMs).toISOString()], ["Before", (r) => clsChip(r.prevCls) + " " + outChip(r.prevOutcome), (r) => `${CLS[r.prevCls]} / ${OUTCOME[r.prevOutcome]}`], ["Gap", (r) => dur(r.gapMin), (r) => r.gapMin], ["GTP station", (r) => esc(r.station), (r) => r.station]] },
    repeatSkus: { label: "Repeat SKU", cols: [["Tote", (r) => `<b>${esc(r.tote)}</b>`, (r) => r.tote], ["Counted", (r) => when(r.ms), (r) => new Date(r.ms).toISOString()], ["This count", (r) => clsChip(r.cls, r.via), (r) => CLS[r.cls]], ["Outcome", (r) => outChip(r.outcome), (r) => OUTCOME[r.outcome]], ["Reported SKU(s)", (r) => esc(r.skus.join(", ")), (r) => r.skus.join(" ")], ["Short in reported tote", (r) => esc(r.reportedTotes.join(", ")), (r) => r.reportedTotes.join(" ")], ["GTP station", (r) => esc(r.station), (r) => r.station]] },
    pending: { label: "Reported, not counted", cols: [["Tote", (r) => `<b>${esc(r.tote)}</b>`, (r) => r.tote], ["Reported", (r) => when(r.reportedMs), (r) => new Date(r.reportedMs).toISOString()], ["Waiting", (r) => dur(Math.round(r.ageMs / 60000)), (r) => Math.round(r.ageMs / 60000)], ["Reported by", (r) => esc(r.station), (r) => r.station], ["Reports", (r) => nf(r.reports), (r) => r.reports], ["Locked now", (r) => (r.locked ? `Yes${r.priority ? " · " + esc(r.priority) : ""}` : "No"), (r) => (r.locked ? r.priority || "Yes" : "No")]] },
    stillLocked: { label: "Counted, still locked", cols: [["Tote", (r) => `<b>${esc(r.tote)}</b>`, (r) => r.tote], ["Priority", (r) => esc(r.priority), (r) => r.priority], ["Counted", (r) => when(r.ms), (r) => new Date(r.ms).toISOString()], ["Outcome", (r) => outChip(r.outcome), (r) => OUTCOME[r.outcome]], ["Reported by", (r) => esc(r.reportStation), (r) => r.reportStation], ["Report to count", (r) => dur(r.reportToCcMin), (r) => r.reportToCcMin], ["GTP station", (r) => esc(r.station), (r) => r.station]] },
    reReported: { label: "Re-reported after CC", cols: [["Tote", (r) => `<b>${esc(r.tote)}</b>`, (r) => r.tote], ["Counted", (r) => when(r.countedMs), (r) => new Date(r.countedMs).toISOString()], ["Outcome", (r) => outChip(r.outcome), (r) => OUTCOME[r.outcome]], ["Reported again", (r) => when(r.reportedAgainMs), (r) => new Date(r.reportedAgainMs).toISOString()], ["By", (r) => esc(r.station), (r) => r.station]] },
  };

  let range = "7d";
  let data = null;
  let tab = "ghosts";
  let query = "";
  let loading = false;
  let mounted = false;

  function renderStatus() {
    const c = data.coverage;
    const f = data.fill || {};
    const parts = [`${dayName(data.range.from)}${data.range.from !== data.range.to ? " – " + dayName(data.range.to) : ""}`];
    if (c.missing.length) parts.push(`${c.days - c.missing.length} of ${c.days} days ready${f.running ? ` - reading history from Grafana (${f.done} of ${f.total}, one day every ~10 s), press Refresh in a while` : ""}`);
    else if (c.lookbackMissing) parts.push("the first days are still getting their 3-day look-back");
    if (data.summary.lockedAt) parts.push(`locked list as of ${Fmt.when(new Date(data.summary.lockedAt).toISOString())}`);
    $("ltaStatus").textContent = parts.join(" · ");
  }

  function renderKpis() {
    const s = data.summary;
    const tile = (c, label, value, sub) => `<div class="ot-kpi" style="--c:${c}"><span>${label}</span><b>${value}</b><small>${sub}</small></div>`;
    $("ltaKpis").innerHTML = [
      tile("var(--text)", "Reports", nf(s.reports), `${nf(s.reportedTotes)} totes reported SHORT`),
      tile("var(--blue)", "Counts at GTP", nf(s.checks), `${nf(s.purged)} purged`),
      tile("var(--ok)", "Proper CC", nf(s.proper), `reported → counted · ${s.checks ? pc(Math.round((s.proper / s.checks) * 1000) / 10) : "—"} of counts`),
      tile("var(--danger)", "Ghost totes", nf(s.ghost), `${pc(s.ghostPct)} of counts · ${nf(s.ghostOutside)} outside AOS`),
      tile("var(--purple)", "Repeat tote", nf(s.repeatTote), "same tote again within 48 h"),
      tile("var(--purple)", "Repeat SKU", nf(s.repeatSku), "reported SKU counted in another tote"),
      tile("var(--warn)", "Reported, not counted", nf(s.pending), "waiting for a cycle count"),
      tile("var(--text)", "Report → count", s.medianReportToCcMin == null ? "—" : dur(s.medianReportToCcMin), "typical (median) wait"),
      tile("var(--warn)", "False reports", nf(s.falseReports), `${pc(s.falseReportPct)} of proper counts found all ALRIGHT`),
      tile("var(--danger)", "Counted, still locked", nf(s.stillLocked), `${nf(s.reReported)} re-reported after a count`),
    ].join("");
  }

  function renderMatrix() {
    const outs = Object.keys(OUTCOME);
    const rows = ["PROPER", "GHOST", "PURGED"].map((cls) => {
      const m = data.matrix[cls] || {};
      const total = outs.reduce((a, o) => a + (m[o] || 0), 0);
      return `<tr><td class="lta-l">${clsChip(cls)}</td>${outs.map((o) => `<td>${nf(m[o] || 0)}</td>`).join("")}<td class="lta-t">${nf(total)}</td></tr>`;
    }).join("");
    $("ltaMatrix").innerHTML = `<thead><tr><th class="lta-l">Class</th>${outs.map((o) => `<th>${OUTCOME[o]}</th>`).join("")}<th>Total</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function renderDaily() {
    const rows = data.daily.map((d) => `<tr><td class="lta-l">${esc(dayName(d.day))}</td><td>${nf(d.reports)}</td><td>${nf(d.checks)}</td><td>${nf(d.proper)}</td><td>${nf(d.ghost)}</td><td>${d.checks ? pc(Math.round((d.ghost / d.checks) * 1000) / 10) : "—"}</td><td>${nf(d.repeatTote)}</td><td>${nf(d.repeatSku)}</td><td>${nf(d.falseReports)}</td></tr>`).join("");
    $("ltaDaily").innerHTML = `<thead><tr><th class="lta-l">Day</th><th>Reports</th><th>Counts</th><th>Proper</th><th>Ghost</th><th>Ghost %</th><th>Rep. tote</th><th>Rep. SKU</th><th>False rep.</th></tr></thead><tbody>${rows || `<tr><td colspan="9" class="lta-none">No days with data yet.</td></tr>`}</tbody>`;
  }

  function renderStations() {
    const gtp = data.gtpStations.map((g) => `<tr><td class="lta-l"><b>${esc(g.station)}</b></td><td>${nf(g.checks)}</td><td>${nf(g.proper)}</td><td>${nf(g.ghost)}</td><td>${pc(g.ghostPct)}</td><td>${nf(g.repeatTote)}</td><td>${nf(g.repeatSku)}</td></tr>`).join("");
    $("ltaGtp").innerHTML = `<thead><tr><th class="lta-l">Station</th><th>Counts</th><th>Proper</th><th>Ghost</th><th>Ghost %</th><th>Rep. tote</th><th>Rep. SKU</th></tr></thead><tbody>${gtp || `<tr><td colspan="7" class="lta-none">No counts.</td></tr>`}</tbody>`;
    const rep = data.reportingStations.map((r) => `<tr><td class="lta-l"><b>${esc(r.station)}</b></td><td>${nf(r.reports)}</td><td>${nf(r.counted)}</td><td>${nf(r.falseReports)}</td><td class="${r.falsePct >= 20 ? "lta-bad" : ""}">${pc(r.falsePct)}</td></tr>`).join("");
    $("ltaRep").innerHTML = `<thead><tr><th class="lta-l">Station</th><th>Reports</th><th>Counted</th><th>All ALRIGHT</th><th>False %</th></tr></thead><tbody>${rep || `<tr><td colspan="5" class="lta-none">No reports.</td></tr>`}</tbody>`;
  }

  function currentRows() {
    const all = (data && data.lists[tab]) || [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => [r.tote, r.station, r.user, r.reportStation, r.pulledBy].some((v) => v && String(v).toLowerCase().includes(q)));
  }

  function renderTabs() {
    $("ltaTabs").innerHTML = Object.entries(LISTS).map(([k, l]) => `<button type="button" data-t="${k}" class="${k === tab ? "active" : ""}">${l.label} <em>${nf((data && data.lists[k] || []).length)}</em></button>`).join("");
  }

  function renderList() {
    const def = LISTS[tab];
    const rows = currentRows();
    $("ltaList").innerHTML = `<thead><tr>${def.cols.map(([l], i) => `<th class="${i === 0 ? "lta-l" : ""}">${l}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${def.cols.map(([, v], i) => `<td class="${i === 0 ? "lta-l" : ""}">${v(r)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${def.cols.length}" class="lta-none">${query.trim() ? "Nothing matches." : "None in this range."}</td></tr>`}</tbody>`;
    const total = (data.lists[tab] || []).length;
    $("ltaListNote").textContent = total >= 400 ? "Showing the newest 400 - pick a shorter range to see all of them." : "";
  }

  function exportList() {
    if (!data) return;
    const def = LISTS[tab];
    const cell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [def.cols.map(([l]) => cell(l)).join(","), ...currentRows().map((r) => def.cols.map(([, , c]) => cell(c(r))).join(","))];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }));
    a.download = `locked-tote-analytics-${tab}-${data.range.from}_${data.range.to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  // fresh: Refresh was pressed - otherwise the last calculation (anyone's) is shown, until someone refreshes
  async function load(fresh = false) {
    if (loading) return;
    loading = true;
    $("ltaError").classList.add("hidden");
    $("ltaRefreshBtn").disabled = true;
    $("ltaStatus").textContent = range === "today" || range === "7d" || range === "30d" ? "Loading - today is read from Grafana, so this can take a few seconds…" : "Loading…";
    try {
      data = await Api.get(`/tote-analytics?range=${range}${fresh === true ? "&fresh=1" : ""}`);
      renderStatus();
      renderKpis();
      renderMatrix();
      renderDaily();
      renderStations();
      renderTabs();
      renderList();
    } catch (e) {
      $("ltaError").textContent = e.message;
      $("ltaError").classList.remove("hidden");
      $("ltaStatus").textContent = "";
    } finally {
      loading = false;
      $("ltaRefreshBtn").disabled = false;
    }
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    $("ltaRange").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-r]");
      if (!b || b.dataset.r === range) return;
      range = b.dataset.r;
      $("ltaRange").querySelectorAll("[data-r]").forEach((x) => x.classList.toggle("active", x === b));
      load();
    });
    $("ltaRefreshBtn").addEventListener("click", () => load(true));
    $("ltaTabs").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-t]");
      if (!b) return;
      tab = b.dataset.t;
      renderTabs();
      renderList();
    });
    $("ltaSearch").addEventListener("input", () => { query = $("ltaSearch").value; if (data) renderList(); });
    $("ltaCsvBtn").addEventListener("click", exportList);
  }

  function start() { mount(); load(); }
  function stop() {}

  return { start, stop };
})();
