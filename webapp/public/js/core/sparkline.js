// Tiny dependency-free inline-SVG sparkline renderer. No charting library
// added - matches this app's existing zero-dependency vanilla-JS frontend
// (see utilisation.js's own gaugeSvg() for the same inline-SVG convention).
// Pure function: given real numeric points, returns an SVG string. Never
// called with fabricated data - every caller either has real history or
// skips rendering a sparkline entirely (see dashboard.js's "not enough
// data yet" handling).
const Sparkline = (() => {
  function render(points, { width = 120, height = 32, type = "line", color = "var(--accent)" } = {}) {
    const vals = (points || []).filter((v) => typeof v === "number" && Number.isFinite(v));
    if (vals.length < 2) return "";

    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = max - min || 1;
    const stepX = width / (vals.length - 1);
    const y = (v) => height - ((v - min) / range) * height;

    if (type === "bar") {
      const barW = Math.max(2, (width / vals.length) * 0.6);
      const bars = vals
        .map((v, i) => {
          const x = i * stepX - barW / 2 + stepX / 2;
          const h = Math.max(1, height - y(v));
          return `<rect x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" rx="1" />`;
        })
        .join("");
      return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${bars}</svg>`;
    }

    const pointsAttr = vals.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const areaPoints = `0,${height} ${pointsAttr} ${width},${height}`;
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <polygon points="${areaPoints}" fill="${color}" opacity="0.12" />
      <polyline points="${pointsAttr}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>`;
  }

  return { render };
})();
