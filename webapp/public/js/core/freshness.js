// Freshness badge (DESIGN.md §9.1): one shared way to say whether a screen's data is live, updating, stale,
// unavailable or simply not connected. The time shown is always the last successful fetch reported by the
// server, never the browser clock at render. Generic on purpose - callers pass the source name and wording.
const Freshness = (() => {
  const STATES = ["live", "refreshing", "stale", "unavailable", "idle", "neutral"];
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // opts: { state, at (last good fetch), label (neutral/idle wording), reason (unavailable), source, cadence }
  function describe(opts) {
    const state = STATES.includes(opts.state) ? opts.state : "neutral";
    const time = opts.at ? Fmt.time(opts.at) : "";
    let text;
    if (state === "live") text = time ? "Live · " + time : "Live";
    else if (state === "refreshing") text = "Updating…";
    else if (state === "stale") text = time ? "Stale · last good " + time : "Stale";
    else if (state === "unavailable") text = "Unavailable" + (opts.reason ? " · " + opts.reason : "");
    else text = opts.label || "";
    const detail = [opts.source && "Source: " + opts.source, time && "Fetched " + time, opts.cadence].filter(Boolean).join(" · ");
    return { state, text, detail };
  }

  // Renders into an existing element (kept in the page header). An empty text hides the badge.
  // Only a change of state is announced (via the shell's polite live region); routine refreshes stay silent.
  function mount(el, opts) {
    const d = describe(opts);
    const changed = el.dataset.freshState !== d.state;
    el.dataset.freshState = d.state;
    const region = document.getElementById("shellLive");
    if (changed && opts.announce && region && d.text) region.textContent = opts.announce + ": " + d.text;
    el.className = "fresh-badge fresh-" + d.state;
    el.innerHTML = d.text ? '<i class="fresh-ico" aria-hidden="true"></i><span>' + esc(d.text) + "</span>" : "";
    if (d.detail) el.title = d.detail;
    else el.removeAttribute("title");
    return d;
  }

  return { mount, describe };
})();
