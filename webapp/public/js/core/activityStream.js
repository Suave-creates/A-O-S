// Bounded, newest-first activity stream. Caps its own backing array (not
// just the DOM) so long-running control-center sessions can't leak memory -
// same cap discipline as the existing Manual/Auto operation-log panels
// (session.log capped at 300 entries server-side; this is the client-side
// equivalent for events this page observes locally).
//
// This session's events come from whatever this page's own pollers/actions
// observe (query completions, session start/stop) - it is NOT a durable
// server-side audit feed yet (no live-push backend exists - see this
// session's Control Center plan). Labelled honestly in the mounting HTML,
// not here.
const ActivityStream = (() => {
  function escHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function timeStr(d) {
    return (d instanceof Date ? d : new Date(d)).toLocaleTimeString([], { hour12: false });
  }

  function create(container, { cap = 200 } = {}) {
    let entries = [];

    function render() {
      if (!entries.length) {
        container.innerHTML = `<div class="live-activity-empty">No activity observed yet this session.</div>`;
        return;
      }
      container.innerHTML = entries
        .map((e) => `<div class="activity-entry ${e.kind ? "act-" + e.kind : ""}"><span class="activity-time">${timeStr(e.time)}</span><span class="activity-msg">${escHtml(e.message)}</span></div>`)
        .join("");
    }

    function push(message, kind = null) {
      entries.unshift({ time: new Date(), message, kind });
      if (entries.length > cap) entries.length = cap;
      render();
    }

    function clear() {
      entries = [];
      render();
    }

    render();
    return { push, clear };
  }

  return { create };
})();
