// Display formatting shared by the screens, so every table reads the same way: one date/time style, one
// "no value" mark. Dates are shown in the viewer's local time (the site runs on IST), 24-hour, no year
// when it is the current year - short enough to stay on one line in a table cell.
const Fmt = (() => {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (n) => String(n).padStart(2, "0");
  function toDate(v) {
    if (v == null || v === "") return null;
    const d = v instanceof Date ? v : new Date(typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // "15 Oct, 18:22" (adds the year only for another year)
  function when(v) {
    const d = toDate(v);
    if (!d) return "";
    const year = d.getFullYear() === new Date().getFullYear() ? "" : " " + d.getFullYear();
    return d.getDate() + " " + MONTHS[d.getMonth()] + year + ", " + two(d.getHours()) + ":" + two(d.getMinutes());
  }
  // "14:32" - time of day only, for freshness labels
  function time(v) {
    const d = toDate(v);
    return d ? two(d.getHours()) + ":" + two(d.getMinutes()) : "";
  }
  // "15 Oct 2026"
  function day(v) {
    const d = toDate(v);
    return d ? d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear() : "";
  }
  // A missing value says why it is missing; a bare dash reads as a broken cell (DESIGN.md §15).
  const nil = '<span class="nil">No data</span>';
  // Counts use Indian grouping (1,23,456) until the owner decides otherwise (DESIGN.md §18); exports stay unformatted.
  const nf = new Intl.NumberFormat("en-IN");
  function num(v) {
    return v == null || v === "" || !Number.isFinite(Number(v)) ? "" : nf.format(Number(v));
  }
  // Short Indian form for tight labels: 950, 32K, 1.2L, 3.4Cr (one decimal under 10, none above).
  function compact(v) {
    const n = Number(v);
    if (v == null || v === "" || !Number.isFinite(n)) return "";
    const short = (x) => (Math.abs(x) < 10 ? Number(x.toFixed(1)) : Math.round(x));
    // pick the unit after rounding, so 99,999 reads "1L" rather than "100K"
    for (const [size, suffix] of [[1e7, "Cr"], [1e5, "L"], [1e3, "K"]]) {
      if (Math.abs(short(n / size)) >= 1) return short(n / size) + suffix;
    }
    return String(Math.round(n));
  }
  // "87%", or "4.2%" below 10% where the decimal matters.
  function pct(v) {
    const n = Number(v);
    return v == null || v === "" || !Number.isFinite(n) ? "" : (Math.abs(n) < 10 && n % 1 ? n.toFixed(1) : Math.round(n)) + "%";
  }
  // Largest two units: "2 h 14 m", "45 s".
  function duration(ms) {
    const s = Math.floor(Number(ms) / 1000);
    if (!Number.isFinite(s) || s < 0) return "";
    if (s < 60) return s + " s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " m";
    const h = Math.floor(m / 60);
    return h < 24 ? h + " h " + (m % 60) + " m" : Math.floor(h / 24) + " d " + (h % 24) + " h";
  }
  return { when, time, day, nil, num, compact, pct, duration };
})();
