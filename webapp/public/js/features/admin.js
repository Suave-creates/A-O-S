const Admin = (() => {
  const body = document.getElementById("adminQueriesBody");

  const COLUMN_COUNT = 7;

  function runtimeOf(q) {
    const start = q.startedAt ? new Date(q.startedAt).getTime() : null;
    if (!start) return "";
    const end = q.completedAt || q.cancelledAt ? new Date(q.completedAt || q.cancelledAt).getTime() : Date.now();
    return Math.max(0, Math.round((end - start) / 1000)) + "s";
  }

  // Real persisted startedAt only (never derived from completedAt, never
  // client-generated) - "24 Aug 2026, 15:28:14" style local date/time.
  function startTimeOf(q) {
    return Fmt.when(q.startedAt) || Fmt.nil;
  }

  // A Cancel button is shown only when the query is genuinely still active
  // AND the operation has a real, verified cancel path - see
  // server/lib/cancellationSupport.js. Terminal statuses, and operations
  // that would only fake-cancel (status flips, real work keeps running),
  // both render "—", never a button that doesn't actually work.
  function isCancellable(q) {
    return ["QUEUED", "RUNNING", "CANCEL_REQUESTED"].includes(q.status) && !!q.cancellationSupported;
  }

  function render(rows) {
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="${COLUMN_COUNT}">No queries yet.</td></tr>`;
      return;
    }
    // The Cancel column is only worth its width while some query can actually be cancelled.
    body.closest("table").classList.toggle("no-cancel", !rows.some(isCancellable));
    Live.setHtml(body, rows.map((q) => {
      const cancellable = isCancellable(q);
      return `<tr>
        <td>${q.queryId}</td>
        <td>${q.user}</td>
        <td>${q.operation}</td>
        <td><span class="status-pill status-${q.status}">${q.status}</span></td>
        <td>${runtimeOf(q)}</td>
        <td class="when">${startTimeOf(q)}</td>
        <td>${cancellable ? `<button class="link danger" data-cancel="${q.queryId}" data-op="${q.operation}">Cancel</button>` : ""}</td>
      </tr>`;
    }).join(""));

    body.querySelectorAll("[data-cancel]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        // A NexS blocked-inventory batch is one chunk of a running Tote Purge (2026-11-04: two chunks cancelled here
        // by mistake left 1,000 PIDs unevaluated) - ask first.
        if (btn.dataset.op === "GET_NEXS_BLOCKED_INVENTORY_BATCH" &&
            !confirm("This is one chunk of a running Tote Purge (up to 500 PIDs). Cancelling it does not stop the purge - those PIDs are retried once at the end, or reported as not evaluated. Cancel it anyway?")) return;
        // Disable immediately, never assume success - refresh() below always
        // re-fetches the real backend state afterward, whether the cancel
        // request succeeded, lost the race to a completion that beat it
        // there (409 "already <status>"), or failed outright.
        btn.disabled = true;
        btn.textContent = "Cancelling…";
        try { await Api.post(`/admin/queries/${btn.dataset.cancel}/cancel`); } catch (e) { alert(e.message); }
        Live.refresh("admin.queries"); // the live feed also repaints within seconds
      });
    });
  }

  // Live: the server pushes the active-queries table (topic "admin.queries",
  // ADMIN only); the Admin tab subscribes only while it is open.
  let off = null;
  function start() {
    if (off) return;
    off = Live.subscribe("admin.queries", (evt) => {
      if (evt.type === "data") render(evt.data);
      else if (evt.type === "feed-error" && !body.dataset.liveHtml) body.innerHTML = `<tr><td colspan="${COLUMN_COUNT}">${evt.message}</td></tr>`;
    });
  }
  function stop() {
    if (off) { off(); off = null; }
  }

  document.getElementById("refreshAdminBtn").addEventListener("click", () => Live.refresh("admin.queries"));

  return { start, stop, refresh: () => Live.refresh("admin.queries") };
})();
