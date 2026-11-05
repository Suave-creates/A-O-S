// Generic KPI card renderer for the Control Center dashboard. Every field is
// optional and independently nullable - a KPI with no real backing data
// renders "—" / omits the trend/status rather than fabricating a value.
// Callers own all domain semantics (what counts as "good" vs "bad" for a
// given metric); this module only renders what it's given.
//
// spec = {
//   label: string,
//   value: string|number|null,      // null -> "—" empty state
//   trendText: string|null,         // e.g. "+3.1pp" or "-2"
//   trendClass: string|null,        // e.g. "trend-up trend-good"
//   status: {text, kind} | null,    // kind: ok|warn|danger|muted
//   freshness: {state, text} | null // state: live|degraded|stale|off
// }
const KpiCard = (() => {
  function escHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const FRESH_DOT = { live: "●", degraded: "◐", stale: "○", off: "—" };

  function freshnessHtml(freshness) {
    if (!freshness) return "";
    const dot = FRESH_DOT[freshness.state] || FRESH_DOT.off;
    return `<span class="freshness-badge fb-${freshness.state}"><span class="fb-dot">${dot}</span>${escHtml(freshness.text)}</span>`;
  }

  // split = { cells: [{ k, v, tone, sub?, now? }] } - the headline broken into parts (the A / B / C shifts, 24h+ vs
  // 12-24h, P0 / P1 / P2 ...): one row per part with a bar sized against the largest part. v is a number.
  // meta = [[label, value], ...] - small facts under the split (stations running, units short ...).
  function splitHtml(split) {
    const cells = (split && split.cells) || [];
    if (!cells.length) return "";
    const max = Math.max(1, ...cells.map((c) => Number(c.v) || 0));
    const rows = cells.map((c) => {
      const v = Number(c.v) || 0;
      return `<div class="sp-row tone-${escHtml(c.tone)}${c.now ? " now" : ""}"><span class="sp-k"${c.sub ? ` title="${escHtml(c.sub)}"` : ""}>${escHtml(c.k)}${c.now ? '<b class="sp-now">now</b>' : ""}</span><span class="sp-track"><i style="width:${v ? Math.max(4, Math.round((v / max) * 100)) : 0}%"></i></span><span class="sp-v">${escHtml(Fmt.num(v))}</span></div>`;
    }).join("");
    return `<div class="kpi-split${cells.length > 3 ? " wide" : ""}">${rows}</div>`;
  }
  const metaHtml = (meta) => (meta && meta.length ? `<div class="kpi-meta">${meta.map(([k, v]) => `<span class="km"><i>${escHtml(k)}</i><b>${escHtml(v)}</b></span>`).join("")}</div>` : "");

  // spec extras (all optional): icon (icon-set name), tone (ok|warn|danger|blue|purple),
  // spark (array of real numbers - drawn only with 2+ points), sub (small caption).
  function render(spec) {
    const hasValue = spec.value != null && spec.value !== "";
    const valueHtml = hasValue
      ? `<span class="kpi-value">${escHtml(spec.value)}</span>`
      : `<span class="kpi-value kpi-empty">${escHtml(spec.emptyText || "No data yet")}</span>`;
    const trendHtml = hasValue && spec.trendText ? `<span class="kpi-trend ${escHtml(spec.trendClass || "")}">${escHtml(spec.trendText)}</span>` : "";
    const statusHtml = spec.status
      ? `<span class="kpi-status-pill status-pill status-${escHtml(spec.status.kind === "ok" ? "COMPLETED" : spec.status.kind === "warn" ? "PENDING" : spec.status.kind === "danger" ? "FAILED" : "VALIDATION_UNAVAILABLE")}">${escHtml(spec.status.text)}</span>`
      : "<span></span>";
    const iconHtml = spec.icon ? `<span class="kpi-ico"><i class="ico" data-i="${escHtml(spec.icon)}"></i></span>` : "";
    const spark = hasValue && spec.spark && typeof Sparkline !== "undefined" ? Sparkline.render(spec.spark, { width: 160, height: 34, color: "currentColor" }) : "";
    return `
      <div class="kpi-head">${iconHtml}<div class="kpi-label">${escHtml(spec.label)}</div></div>
      <div class="kpi-value-row">${valueHtml}${trendHtml}</div>
      ${splitHtml(spec.split)}
      ${[].concat(spec.sub || []).map((line) => `<div class="kpi-sub">${escHtml(line)}</div>`).join("")}
      ${metaHtml(spec.meta)}
      ${spark ? `<div class="kpi-spark">${spark}</div>` : ""}
      <div class="kpi-foot">${statusHtml}${freshnessHtml(spec.freshness)}</div>
    `;
  }

  // "1,234" / "12.5%" -> { n: 1234, fmt(n) } so a changed number can count up.
  function parseNumeric(text) {
    const m = /^(-?[\d,]*\.?\d+)(.*)$/.exec(String(text).trim());
    if (!m) return null;
    const raw = m[1];
    const decimals = (raw.split(".")[1] || "").length;
    return { n: Number(raw.replace(/,/g, "")), suffix: m[2], decimals, grouped: raw.includes(",") };
  }
  function formatNumeric(p, n) {
    const body = p.grouped ? n.toLocaleString(undefined, { minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals }) : n.toFixed(p.decimals);
    return body + p.suffix;
  }

  const reduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Re-renders the card; when the headline value changed since the last
  // render (not the first one) the number counts up/down to the new value and
  // the value pulses, so a live change is noticed.
  function mount(container, spec) {
    const next = spec.value == null ? "" : String(spec.value);
    const prev = container.dataset.kpiValue;
    const changed = prev !== undefined && prev !== next;
    container.innerHTML = render(spec);
    container.dataset.kpiValue = next;
    if (spec.tone) container.dataset.tone = spec.tone; else delete container.dataset.tone;
    if (!changed) return;
    const el = container.querySelector(".kpi-value:not(.kpi-empty)");
    if (!el) return;
    if (typeof Live !== "undefined") Live.flash(el, "kpi-changed");
    const from = parseNumeric(prev), to = parseNumeric(next);
    if (!from || !to || from.suffix !== to.suffix || reduced()) return;
    const t0 = performance.now(), DUR = 700;
    (function step(now) {
      const t = Math.min(1, (now - t0) / DUR);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = formatNumeric(to, from.n + (to.n - from.n) * eased);
      if (t < 1) requestAnimationFrame(step); else el.textContent = next;
    })(t0);
  }

  return { render, mount, freshnessHtml };
})();
