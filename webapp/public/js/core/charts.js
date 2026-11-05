// Small dependency-free SVG/HTML chart helpers for the detail popups. They only
// ever draw numbers they are given: a null value is an empty slot (a future
// hour), never a zero bar.
const Charts = (() => {
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const nf = (n) => (n == null ? "No data" : Fmt.num(n));

  // Vertical bars. items: [{label, value|null, tone: "a"|"b"|"c"|"muted", current?: bool, tip?: string,
  //                          value2?: number, tone2?: "bermuda"}]  (value2 stacks on top of value)
  // Responsive via viewBox; x labels thin out automatically on narrow data.
  function bars(items, { height = 220, unit = "" } = {}) {
    const W = 960, padL = 36, padR = 8, padT = 14, padB = 30;
    const innerW = W - padL - padR, innerH = height - padT - padB;
    const vals = items.filter((i) => typeof i.value === "number").map((i) => i.value + (i.value2 || 0));
    const max = Math.max(1, ...vals);
    const niceMax = niceCeil(max);
    const slot = innerW / items.length;
    const bw = Math.min(30, slot * 0.64);

    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map((f) => {
        const y = padT + innerH - innerH * f;
        return `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" class="ch-grid"/><text x="${padL - 6}" y="${y + 4}" class="ch-axis" text-anchor="end">${nf(Math.round(niceMax * f))}</text>`;
      })
      .join("");

    const cols = items
      .map((it, i) => {
        const x = padL + slot * i + (slot - bw) / 2;
        const label = i % Math.ceil(items.length / 24) === 0 ? `<text x="${x + bw / 2}" y="${height - 10}" class="ch-axis" text-anchor="middle">${esc(it.label)}</text>` : "";
        if (it.value == null) {
          return `<g class="ch-col ch-future"><rect x="${x}" y="${padT + innerH - 3}" width="${bw}" height="3" rx="1.5"/><title>${esc(it.label)} - not reached yet</title></g>${label}`;
        }
        const h = Math.max(it.value > 0 ? 2 : 0, (it.value / niceMax) * innerH);
        const y = padT + innerH - h;
        const h2 = it.value2 > 0 ? Math.max(2, (it.value2 / niceMax) * innerH) : 0;
        const stacked = h2 ? `<rect class="ch-seg2 tone-${it.tone2 || "bermuda"}" x="${x}" y="${y - h2}" width="${bw}" height="${h2}" rx="3" style="animation-delay:${Math.min(i * 18, 360)}ms"/>` : "";
        const topY = y - h2;
        return `<g class="ch-col tone-${it.tone || "a"}${it.current ? " ch-current" : ""}">
          <rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="3" style="animation-delay:${Math.min(i * 18, 360)}ms"/>${stacked}
          ${it.value > 0 && bw >= 16 ? `<text x="${x + bw / 2}" y="${topY - 4}" class="ch-val" text-anchor="middle">${nf(it.value + (it.value2 || 0))}</text>` : ""}
          <title>${esc(it.tip || `${it.label}: ${nf(it.value)} ${unit}`)}</title></g>${label}`;
      })
      .join("");

    return `<svg class="chart chart-bars" viewBox="0 0 ${W} ${height}" role="img" preserveAspectRatio="xMidYMid meet">${grid}${cols}</svg>`;
  }

  function niceCeil(v) {
    if (v <= 5) return 5;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / pow;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * pow;
  }

  // Ring gauge 0..1 (null -> empty ring with "-").
  function ring(fraction, { size = 120, label = "", tone = "auto" } = {}) {
    const r = 46, c = 2 * Math.PI * r;
    const has = typeof fraction === "number" && Number.isFinite(fraction);
    const f = has ? Math.max(0, Math.min(1, fraction)) : 0;
    const t = tone === "auto" ? (!has ? "muted" : f >= 0.85 ? "warn" : f >= 0.5 ? "ok" : f >= 0.25 ? "accent" : "danger") : tone;
    return `<div class="ring tone-${t}" style="width:${size}px;height:${size}px">
      <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="${r}" class="ring-bg"/><circle cx="60" cy="60" r="${r}" class="ring-fg" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 60 60)"/></svg>
      <div class="ring-text"><b>${has ? (fraction * 100).toFixed(1) + "%" : "-"}</b>${label ? `<span>${esc(label)}</span>` : ""}</div></div>`;
  }

  // Horizontal meter 0..100 (percent number).
  function meter(percent, { tone = "auto" } = {}) {
    const has = typeof percent === "number" && Number.isFinite(percent);
    const p = has ? Math.max(0, Math.min(100, percent)) : 0;
    const t = tone === "auto" ? (!has ? "muted" : p >= 90 ? "danger" : p >= 75 ? "warn" : "ok") : tone;
    return `<span class="meter tone-${t}"><i style="width:${p}%"></i></span>`;
  }

  return { bars, ring, meter, niceCeil };
})();
