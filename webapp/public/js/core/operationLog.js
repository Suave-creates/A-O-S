// Pull Logs: every Manual and Auto Tote Puller session, ONE row per session, expandable to every tote in it.
// Two sources:
//   - Live (default): the latest 100 sessions, pushed by the live topic "operations" (server/live/feeds.js).
//   - History: any IST date range (Today / Yesterday / 7 / 30 days / custom), read page by page from
//     GET /pull-logs/history - kind, outcome and the tote / employee search run on the server there, so a
//     tote is found across the whole range, not just the loaded page. Export writes the range as CSV.
// Each session carries kind MANUAL / AUTO (badge, coloured edge, filter, per-kind totals). Finding a tote
// expands the sessions that touched it and highlights its row. Read-only: nothing here calls a tote.
const OperationLog = (() => {
  const KIND_LABEL = { MANUAL: "Manual", AUTO: "Auto" };
  // pull results, grouped for the per-session bar: called / already queued / not available / anything else
  const RESULT_GROUP = { INSERTED: "ok", RELEASED: "ok", ALREADY_QUEUED: "queued", NOT_AVAILABLE: "na" };
  const PAGE = 50;
  const DAY_MS = 86400000;

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  const nf = (n) => Number(n || 0).toLocaleString();
  const verdictLabel = (v) => String(v || "").replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

  // IST calendar days as YYYY-MM-DD (the server reads ranges the same way)
  const istDay = (d) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const shiftDay = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
  const prettyDay = (day) => new Date(day + "T00:00:00Z").toLocaleDateString([], { timeZone: "UTC", day: "2-digit", month: "short" });

  function presetRange(range) {
    const today = istDay(new Date());
    if (range === "TODAY") return { from: today, to: today };
    if (range === "YESTERDAY") { const y = shiftDay(today, -1); return { from: y, to: y }; }
    if (range === "7D") return { from: shiftDay(today, -6), to: today };
    if (range === "30D") return { from: shiftDay(today, -29), to: today };
    return null;
  }

  // "Today" / "Yesterday" / "Mon, 27 Oct" - sessions are grouped under these.
  function dayLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "Unknown date";
    const day = istDay(d);
    const today = istDay(new Date());
    if (day === today) return "Today";
    if (day === shiftDay(today, -1)) return "Yesterday";
    return d.toLocaleDateString([], { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short" });
  }

  function resultBar(counts) {
    const g = { ok: 0, queued: 0, na: 0, other: 0 };
    let total = 0;
    for (const [v, n] of Object.entries(counts || {})) { g[RESULT_GROUP[v] || "other"] += n; total += n; }
    if (!total) return "";
    const seg = (k) => (g[k] ? `<i class="pl-bar-${k}" style="flex:${g[k]}"></i>` : "");
    const tip = Object.entries(counts).map(([v, n]) => `${n} ${verdictLabel(v)}`).join(", ");
    return `<span class="pl-bar" title="${escHtml(tip)}">${seg("ok")}${seg("queued")}${seg("na")}${seg("other")}</span>`;
  }

  function summaryLine(counts) {
    return Object.entries(counts || {}).map(([v, n]) => `${n} ${verdictLabel(v)}`).join(" &middot; ");
  }

  function detailsTable(entry, q) {
    if (!entry.details.length) return `<p class="note">No tote-level detail recorded for this session.</p>`;
    const auto = entry.kind === "AUTO";
    return `<table>
      <thead><tr><th>Tote ID</th>${auto ? "<th>Priority</th>" : ""}<th>Zone</th>${auto ? "<th>Instance</th>" : ""}<th>Attempt</th><th>Result</th><th>Reason</th></tr></thead>
      <tbody>${entry.details.map((d) => {
        const hit = q && String(d.toteId || "").toLowerCase().includes(q);
        return `<tr${hit ? ' class="pl-hit"' : ""}>
          <td><button type="button" class="pl-find" data-find="${escHtml(d.toteId)}" title="Show every session with this tote">${escHtml(d.toteId)}</button></td>
          ${auto ? `<td>${d.priorityAtSelection ? `<span class="chip">${escHtml(d.priorityAtSelection)}</span>` : "-"}</td>` : ""}
          <td>${escHtml(d.zone ?? "-")}</td>
          ${auto ? `<td>${escHtml(d.instanceCode ?? "-")}</td>` : ""}
          <td>${d.attempt ?? "-"}</td>
          <td><span class="status-pill status-${escHtml(d.verdict)}">${escHtml(verdictLabel(d.verdict))}</span></td>
          <td class="pl-reason">${escHtml(d.reason || "")}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>`;
  }

  function renderEntry(entry, open, q) {
    const kind = entry.kind || "MANUAL";
    const via = entry.system ? entry.system.charAt(0).toUpperCase() + entry.system.slice(1) : "-";
    return `<div class="oplog-entry pl-${kind.toLowerCase()}${open ? " open" : ""}">
      <div class="oplog-row" data-toggle="${escHtml(entry.auditLogId)}" role="button" tabindex="0" aria-expanded="${open}">
        <span class="pl-kind ${kind.toLowerCase()}">${KIND_LABEL[kind] || kind}</span>
        <span class="oplog-time">${escHtml(Fmt.when(entry.timestamp))}</span>
        <button type="button" class="oplog-user pl-find" data-find="${escHtml(entry.employeeId)}" title="Show this person's sessions">${escHtml(entry.employeeId)}</button>
        <span class="oplog-mode">${nf(entry.totalItems)} tote${entry.totalItems === 1 ? "" : "s"}${entry.mode ? " &middot; " + escHtml(entry.mode) : ""}</span>
        ${entry.purpose === "PURGE" ? '<span class="oplog-purge">PURGE</span>' : ""}
        <span class="oplog-summary">${resultBar(entry.statusCounts)}<span>${summaryLine(entry.statusCounts)}</span></span>
        <span class="status-pill status-${escHtml(entry.overallStatus)}">${escHtml(entry.overallStatus)}</span>
        <span class="oplog-caret"><i class="ico" data-i="${open ? "chevdown" : "chevright"}"></i></span>
      </div>
      ${open ? `<div class="oplog-details">
        <div class="pl-detail-head"><p class="note oplog-via">Run through ${escHtml(via)} as ${escHtml(entry.accountIdentity)}</p>
          ${entry.details.length ? `<button type="button" class="ghost pl-copy" data-copy="${escHtml(entry.auditLogId)}"><i class="ico" data-i="file"></i>Copy tote IDs</button>` : ""}</div>
        ${detailsTable(entry, q)}</div>` : ""}
    </div>`;
  }

  // els: { container, stats, kindSeg, rangeSeg, from, to, apply, rangeNote, search, exportBtn, more } - start()/stop() subscribe/unsubscribe, so a screen that isn't
  // open costs the server nothing.
  function mount(els) {
    const { container, stats, kindSeg, rangeSeg, search, more } = els;
    const expanded = new Set(); // auditLogIds as strings (dataset values are strings)
    let live = null; // entries from the live feed
    let liveError = null;
    let hist = null; // { entries, nextBefore, summary, error, loading }
    let range = "LIVE";
    let custom = null; // { from, to }
    let kind = "ALL";
    let query = "";
    let off = null;
    let seq = 0; // drops answers to superseded history requests
    let debounce = null;

    const isLive = () => range === "LIVE";
    const currentRange = () => (range === "CUSTOM" ? custom : presetRange(range));
    const q = () => query.trim().toLowerCase();
    const matchesQuery = (e, s) => !s || String(e.employeeId || "").toLowerCase().includes(s) || e.details.some((d) => String(d.toteId || "").toLowerCase().includes(s));
    const toteHit = (e, s) => !!s && e.details.some((d) => String(d.toteId || "").toLowerCase().includes(s));

    // in Live the filters run here; in History the server already applied them
    function shownEntries() {
      if (!isLive()) return hist && hist.entries;
      if (!live) return null;
      const s = q();
      return live.filter((e) => (kind === "ALL" || e.kind === kind) && matchesQuery(e, s));
    }

    function filterParams(r) {
      const p = new URLSearchParams({ from: r.from, to: r.to, kind });
      if (query.trim()) p.set("q", query.trim());
      return p;
    }

    async function loadHistory(append) {
      const r = currentRange();
      if (!r) return;
      const my = ++seq;
      const p = filterParams(r);
      p.set("limit", PAGE);
      if (append && hist && hist.nextBefore != null) p.set("before", hist.nextBefore);
      if (!append) hist = { entries: null, nextBefore: null, summary: null, loading: true };
      else hist.loading = true;
      paint();
      try {
        const res = await Api.get("/pull-logs/history?" + p.toString());
        if (my !== seq) return;
        hist = {
          entries: append ? hist.entries.concat(res.entries) : res.entries,
          nextBefore: res.nextBefore,
          summary: res.summary || hist.summary,
          loading: false,
        };
      } catch (e) {
        if (my !== seq) return;
        hist = { ...(hist || {}), entries: (hist && hist.entries) || null, loading: false, error: e.message };
      }
      paint();
    }

    function paintStats() {
      if (!stats) return;
      const card = (cls, label, value, sub) => `<div class="dd-stat pl-stat ${cls}"><div class="dd-stat-k">${label}</div><div class="dd-stat-v">${value}</div><div class="dd-stat-s">${sub}</div></div>`;
      let s;
      let scope;
      if (isLive()) {
        if (!live) { stats.innerHTML = ""; return; }
        s = { sessions: live.length, totes: 0, manual: { sessions: 0, totes: 0 }, auto: { sessions: 0, totes: 0 }, stopped: 0 };
        for (const e of live) {
          const k = e.kind === "AUTO" ? s.auto : s.manual;
          k.sessions++;
          k.totes += Number(e.totalItems) || 0;
          s.totes += Number(e.totalItems) || 0;
          if (e.overallStatus === "STOPPED") s.stopped++;
        }
        scope = `latest ${nf(live.length)}`;
      } else {
        if (!hist || !hist.summary) { stats.innerHTML = ""; return; }
        s = hist.summary;
        const r = currentRange();
        scope = r.from === r.to ? prettyDay(r.from) : `${prettyDay(r.from)} – ${prettyDay(r.to)}`;
      }
      stats.innerHTML =
        card("", "Sessions", nf(s.sessions), scope) +
        card("", "Totes called", nf(s.totes), `across ${nf(s.sessions)} session${s.sessions === 1 ? "" : "s"}`) +
        card("manual", '<span class="pl-dot manual"></span>Manual', nf(s.manual.sessions), `${nf(s.manual.totes)} totes`) +
        card("auto", '<span class="pl-dot auto"></span>Auto', nf(s.auto.sessions), `${nf(s.auto.totes)} totes`) +
        card("stopped", "Stopped early", nf(s.stopped), "stopped before finishing");
    }

    function paintMore(shown) {
      if (!more) return;
      if (isLive()) {
        more.innerHTML = live && live.length ? `<span class="note">Live &middot; the latest ${nf(live.length)} sessions, updating by themselves. Pick a date range for older ones.</span>` : "";
        return;
      }
      if (!hist || !shown) { more.innerHTML = ""; return; }
      const total = hist.summary ? hist.summary.sessions : shown.length;
      more.innerHTML = `<span class="note">Showing ${nf(shown.length)} of ${nf(total)} session${total === 1 ? "" : "s"}</span>` +
        (hist.nextBefore != null ? `<button type="button" class="ghost" data-more ${hist.loading ? "disabled" : ""}>${hist.loading ? "Loading&hellip;" : `Load ${Math.min(PAGE, total - shown.length) || PAGE} more`}</button>` : "");
    }

    function paint() {
      paintStats();
      const err = isLive() ? liveError : hist && hist.error;
      const shown = shownEntries();
      paintMore(shown);
      if (err && !shown) { container.innerHTML = `<p class="error">${escHtml(err)}</p>`; return; }
      if (!shown) { container.innerHTML = `<p class="note">Loading&hellip;</p>`; return; }
      const s = q();
      if (!shown.length) {
        const why = isLive() && !live.length ? "No pull sessions logged yet."
          : s ? `Nothing matches “${escHtml(query.trim())}”${isLive() ? " in the latest sessions - pick a date range to search further back" : " in this range"}.`
            : isLive() ? "No sessions match these filters." : "No sessions in this range.";
        container.innerHTML = `<div class="dd-empty-state"><i class="ico" data-i="file"></i><h4>No sessions</h4><p>${why}</p></div>`;
        return;
      }
      // per-day totals of what is shown, for the day headers
      const days = new Map();
      for (const e of shown) {
        const d = dayLabel(e.timestamp);
        const t = days.get(d) || { n: 0, totes: 0 };
        t.n++;
        t.totes += Number(e.totalItems) || 0;
        days.set(d, t);
      }
      let html = "";
      let day = null;
      for (const e of shown) {
        const d = dayLabel(e.timestamp);
        if (d !== day) {
          day = d;
          const t = days.get(d);
          html += `<div class="pl-day"><span>${escHtml(d)}</span><span>${nf(t.n)} session${t.n === 1 ? "" : "s"} &middot; ${nf(t.totes)} totes</span></div>`;
        }
        html += renderEntry(e, expanded.has(String(e.auditLogId)) || toteHit(e, s), s);
      }
      container.innerHTML = html;
    }

    function setQuery(v) {
      query = v;
      if (search) search.value = v;
      if (isLive()) paint(); else loadHistory(false);
    }

    function setSeg(seg, btn) {
      seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === btn));
    }

    function setRange(next) {
      range = next;
      if (els.from) els.from.closest(".pl-custom").classList.toggle("hidden", range !== "CUSTOM");
      if (els.rangeNote) {
        const r = currentRange();
        els.rangeNote.textContent = isLive() ? "Latest 100 · live" : r ? (r.from === r.to ? prettyDay(r.from) : `${prettyDay(r.from)} – ${prettyDay(r.to)}`) : "";
      }
      if (els.exportBtn) els.exportBtn.title = isLive() ? "Download today's sessions as CSV, one row per tote" : "Download this range as CSV, one row per tote";
      if (isLive()) { hist = null; seq++; paint(); } else if (currentRange()) loadHistory(false); else paint();
    }

    container.addEventListener("click", (ev) => {
      const find = ev.target.closest("[data-find]");
      if (find) { ev.stopPropagation(); setQuery(find.dataset.find); return; }
      const copy = ev.target.closest("[data-copy]");
      if (copy) {
        const e = (shownEntries() || []).find((x) => String(x.auditLogId) === copy.dataset.copy);
        if (!e) return;
        const ids = e.details.map((d) => d.toteId).filter(Boolean);
        navigator.clipboard.writeText(ids.join("\n")).then(
          () => Toast.show({ title: "Copied", message: `${ids.length} tote ID${ids.length === 1 ? "" : "s"}`, tone: "ok", ms: 2500 }),
          () => Toast.show({ title: "Could not copy", message: "The browser blocked the clipboard.", tone: "danger" })
        );
        return;
      }
      const row = ev.target.closest("[data-toggle]");
      if (!row) return;
      const id = row.dataset.toggle;
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      paint();
    });
    container.addEventListener("keydown", (ev) => {
      if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches("[data-toggle]")) { ev.preventDefault(); ev.target.click(); }
    });
    if (more) more.addEventListener("click", (ev) => { if (ev.target.closest("[data-more]")) loadHistory(true); });

    if (kindSeg) {
      kindSeg.addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-kind]");
        if (!b) return;
        kind = b.dataset.kind;
        setSeg(kindSeg, b);
        if (isLive()) paint(); else loadHistory(false);
      });
    }
    if (rangeSeg) {
      rangeSeg.addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-range]");
        if (!b) return;
        setSeg(rangeSeg, b);
        if (b.dataset.range === "CUSTOM" && !custom) {
          const r = presetRange("7D");
          els.from.value = r.from;
          els.to.value = r.to;
          custom = r;
        }
        setRange(b.dataset.range);
      });
    }
    if (els.apply) {
      els.apply.addEventListener("click", () => {
        let from = els.from.value;
        let to = els.to.value || from;
        if (!from) { Toast.show({ title: "Pick a start date", tone: "warn" }); return; }
        if (to < from) { [from, to] = [to, from]; els.from.value = from; els.to.value = to; }
        custom = { from, to };
        setRange("CUSTOM");
      });
    }
    if (search) {
      search.addEventListener("input", () => {
        query = search.value;
        if (isLive()) { paint(); return; }
        clearTimeout(debounce);
        debounce = setTimeout(() => loadHistory(false), 350);
      });
    }
    if (els.exportBtn) {
      els.exportBtn.addEventListener("click", () => {
        const r = currentRange() || presetRange("TODAY"); // Live exports today
        const a = document.createElement("a");
        a.href = "/api/v1/pull-logs/export.csv?" + filterParams(r).toString();
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
    }

    function start() {
      if (off) return;
      paint();
      off = Live.subscribe("operations", (evt) => {
        if (evt.type === "data") { live = evt.data; liveError = null; if (isLive()) paint(); }
        else if (evt.type === "feed-error" && !live) { liveError = evt.message; if (isLive()) paint(); }
      });
    }
    function stop() { if (off) { off(); off = null; } }

    return { start, stop, refresh: () => (isLive() ? Live.refresh("operations") : loadHistory(false)) };
  }

  return { mount };
})();
