// Confirm step of the mutation flow (DESIGN.md §10.10): a modal that states what will happen, to how many items
// and in which system, and whose primary button names the action ("Pull 42 totes"), never "OK". Resolves true
// only on that button; Cancel, Esc, the backdrop and the X all resolve false. Generic: callers supply the wording.
//   const go = await MutationFlow.confirm({ title, actionLabel, lines: [...], warnings: [{ label, text }] });
const MutationFlow = (() => {
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function confirm({ title, actionLabel, lines = [], warnings = [] }) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (answer) => {
        if (settled) return;
        settled = true;
        resolve(answer);
      };
      const m = Modal.open({ title, icon: "alert", size: "sm", onClose: () => done(false) });
      m.body.innerHTML =
        lines.map((l) => `<p>${esc(l)}</p>`).join("") +
        warnings.map((w) => `<p class="note purge-confirm"><b>${esc(w.label)}</b> ${esc(w.text)}</p>`).join("") +
        `<div class="mutation-actions"><button type="button" class="link" data-cancel>Cancel</button>` +
        `<button type="button" class="primary danger-btn" data-go>${esc(actionLabel)}</button></div>`;
      m.body.querySelector("[data-cancel]").addEventListener("click", () => m.close());
      m.body.querySelector("[data-go]").addEventListener("click", () => {
        done(true);
        m.close();
      });
      m.body.querySelector("[data-cancel]").focus(); // the irreversible action is never the default focus
    });
  }

  // The verdict key a result row is labelled and coloured by. A skipped pull is "FAILED" only when the server says
  // nothing was pulled; with no resolution (older sessions) it stays SKIPPED, i.e. uncertain.
  function resultKey(r) {
    if (r.verdict) return r.verdict;
    return r.terminal === "SKIPPED" && r.resolution === "failed" ? "FAILED" : r.terminal;
  }

  return { confirm, resultKey };
})();
