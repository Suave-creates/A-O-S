// ASRS Performance - the One Pager kept day by day (server: features/one-pager-report/asrsPerformance.js).
// One month at a time: MTD totals and daily averages, and every day in a table (newest first, under the
// MTD and average rows). Read on opening the tab and on demand - the data changes once a day (06:05 IST),
// so nothing here is live. Read-only.
const AsrsPerformance = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // figure key -> its tile label; pct: a 0-100 percentage
  const META = {
    picked: { label: "Orders picked" },
    ccDone: { label: "CC done" },
    discrepancies: { label: "Discrepancies" },
    compaction: { label: "Compaction" },
    lockedTotal: { label: "Locked totes" },
    outsideTotal: { label: "Outside totes" },
    utilPct: { label: "Utilisation", pct: true },
  };
  const SOURCE = { AUTO: "Auto", CATCHUP: "Catch-up", BACKFILL: "Rebuilt" };

  let month = null; // YYYY-MM
  let data = null;
  let loading = false;
  let mounted = false;

  const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const istYesterday = () => new Date(Date.parse(istToday() + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
  const shiftMonth = (m, n) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
  const monthName = (m) => new Date(m + "-01T00:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", month: "long", year: "numeric" });
  const fmt = (v, pct) => (v == null ? "—" : pct ? Number(v).toFixed(1) + "%" : Fmt.num(Math.round(v)));

  function renderKpis() {
    const s = data.summary;
    const tile = (colour, label, value, sub) => `<div class="ot-kpi ap-kpi" style="--c:${colour}"><span>${label}</span><b>${value}</b><small>${sub}</small></div>`;
    const flow = (k, colour, extra) => tile(colour, `${META[k].label} · MTD`, fmt(s.total[k]), `avg ${fmt(s.avg[k])} a day${extra || ""}`);
    const level = (k, colour, sub) => tile(colour, `${META[k].label} · daily avg`, fmt(s.avg[k], META[k].pct), sub);
    const recorded = data.days.length - data.missing.length;
    $("apKpis").innerHTML = [
      flow("picked", "var(--orange)", ` · JIT ${fmt(s.total.pickedJit)} · NJIT ${fmt(s.total.pickedNjit)} · FR0 ${fmt(s.total.pickedFr0)} · FR0-Bulk ${fmt(s.total.pickedBulk)} items`),
      flow("ccDone", "#0e8a8a"),
      flow("discrepancies", "var(--danger)"),
      flow("compaction", "var(--purple)", ` · freed ${fmt(s.total.toteFreed)} MTD`),
      level("lockedTotal", "var(--danger)", `P0 avg ${fmt(s.avg.lockedP0)}`),
      level("outsideTotal", "var(--warn)", `over 24 h avg ${fmt(s.avg.outside24)}`),
      level("utilPct", "var(--ok)", `totes in ASRS avg ${fmt(s.avg.totesInAsrs)}`),
      tile("var(--blue)", "Days saved", `${recorded}<em>/${data.days.length}</em>`, data.missing.length ? `${data.missing.length} missing` : "every day so far"),
    ].join("");
  }

  // the table's column groups; each group's first column carries a divider (.ap-sep)
  const GROUPS = [
    { label: "Production", cols: [["picked", "T Picked"], ["pickedJit", "JIT"], ["pickedNjit", "NJIT"], ["pickedFr0", "FR0"], ["pickedBulk", "FR0-Bulk"]] },
    { label: "Cycle Count", cols: [["ccDone", "CC Done"], ["bermuda", "Bermuda"], ["shortQty", "Qty Short"], ["discrepancies", "Tote Reported"]] },
    { label: "Compaction", cols: [["compaction", "Compaction"], ["toteFreed", "T Freed"]] },
    { label: "Utilisation", cols: [["utilPct", "Util %"]] },
    { label: "Locked", cols: [["lockedTotal", "Locked Totes"]] },
    { label: "Outside", cols: [["outsideTotal", "Outside Totes"]] },
  ];
  const COLS = GROUPS.flatMap((g) => g.cols.map(([k, l], i) => ({ k, l, sep: i === 0 })));
  const LEVEL = new Set(["lockedTotal", "outsideTotal", "utilPct"]); // averaged, never totalled

  function renderTable() {
    const s = data.summary;
    const head = `<thead>
      <tr class="ap-grouphead"><th class="ap-date" rowspan="2">Date</th>${GROUPS.map((g) => `<th class="ap-sep ap-g" colspan="${g.cols.length}">${g.label}</th>`).join("")}<th rowspan="2">Saved</th></tr>
      <tr class="ap-colhead">${COLS.map((c) => `<th class="${c.sep ? "ap-sep" : ""}">${c.l}</th>`).join("")}</tr>
    </thead>`;
    const cells = (m, getter) => COLS.map((c) => `<td class="${c.sep ? "ap-sep" : ""}">${getter(c.k, m)}</td>`).join("");
    // newest day first, under the MTD / average rows
    const rows = data.days.slice().reverse().map((d) => {
      const date = new Date(d.date + "T00:00:00Z").toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "2-digit" });
      if (!d.m) return `<tr class="ap-missing"><td class="ap-date">${esc(date)}</td><td colspan="${COLS.length}">not saved yet</td><td></td></tr>`;
      return `<tr><td class="ap-date">${esc(date)}</td>${cells(d.m, (k, m) => fmt(m[k], k === "utilPct"))}<td><span class="ap-src ${(d.source || "").toLowerCase()}" title="${esc(d.capturedAt ? "saved " + Fmt.when(d.capturedAt) : "")}">${esc(SOURCE[d.source] || d.source || "")}</span></td></tr>`;
    }).join("");
    // today so far, from the newest One Pager generated for today - not part of the MTD or the averages
    const t = data.today;
    const todayRow = !t ? "" : t.m
      ? `<tr class="ap-today"><td class="ap-date">Today <small>so far</small></td>${cells(t.m, (k, m) => fmt(m[k], k === "utilPct"))}<td><span class="ap-src today" title="from the One Pager generated ${esc(Fmt.when(t.generatedAt))} - not in the MTD or averages until it is saved tomorrow">${esc(Fmt.time(t.generatedAt))}</span></td></tr>`
      : `<tr class="ap-today ap-missing"><td class="ap-date">Today <small>so far</small></td><td colspan="${COLS.length}">no One Pager generated for today yet - generate one and press Refresh</td><td></td></tr>`;
    const summary = `<tbody class="ap-summary">
      <tr class="ap-total"><td class="ap-date">MTD total</td>${cells(null, (k) => (LEVEL.has(k) ? "" : fmt(s.total[k])))}<td></td></tr>
      <tr class="ap-avg"><td class="ap-date">Daily average</td>${cells(null, (k) => fmt(s.avg[k], k === "utilPct"))}<td></td></tr>
    </tbody>`;
    $("apTable").innerHTML = head + summary + `<tbody>${todayRow}${rows || (todayRow ? "" : `<tr><td colspan="${COLS.length + 2}" class="ap-none">No days in this month yet.</td></tr>`)}</tbody>`;
  }

  function renderStatus() {
    const parts = ["Saved automatically every morning at 06:05 IST for the day before"];
    if (data.filling) parts.push("filling in missing days now - press Refresh in a minute");
    else if (data.missing.length) parts.push(`${data.missing.length} day${data.missing.length === 1 ? "" : "s"} missing`);
    $("apStatus").textContent = parts.join(" · ");
    $("apFillBtn").innerHTML = data.filling ? '<i class="ico" data-i="refresh"></i>Refresh' : '<i class="ico" data-i="refresh"></i>Fill missing days';
    $("apFillBtn").disabled = data.filling ? false : !data.missing.length;
  }

  async function load() {
    if (loading) return;
    loading = true;
    $("apError").classList.add("hidden");
    $("apMonthLabel").textContent = monthName(month);
    $("apNextBtn").disabled = month >= istToday().slice(0, 7);
    try {
      data = await Api.get(`/asrs-performance/month?month=${month}`);
      renderStatus();
      renderKpis();
      renderTable();
    } catch (e) {
      $("apError").textContent = e.message;
      $("apError").classList.remove("hidden");
      $("apStatus").textContent = "";
    } finally {
      loading = false;
    }
  }

  async function fill() {
    if (data && data.filling) { load(); return; } // the button reads Refresh while a fill runs
    try {
      await Api.post("/asrs-performance/fill", { month });
      Toast.show({ title: "Filling in missing days", message: "Each day reads Grafana, so this takes a little while. Press Refresh to see progress.", tone: "ok" });
      load();
    } catch (e) {
      Toast.show({ title: "Could not start", message: e.message, tone: "danger" });
    }
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    month = istYesterday().slice(0, 7); // on the 1st, the month that just ended
    $("apPrevBtn").addEventListener("click", () => { month = shiftMonth(month, -1); load(); });
    $("apNextBtn").addEventListener("click", () => { month = shiftMonth(month, 1); load(); });
    $("apFillBtn").addEventListener("click", fill);
    $("apCsvBtn").addEventListener("click", () => { window.location.href = `/api/v1/asrs-performance/export.csv?month=${month}`; });
  }

  // read fresh each time the tab opens - the figures change once a day
  function start() { mount(); load(); }
  function stop() {}

  return { start, stop };
})();
