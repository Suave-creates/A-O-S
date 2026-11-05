// The Auto Puller "is anyone watching?" pop-up, on every tab (operator decision 2026-11-04). The Auto Puller is
// one shared line; every so often (the interval set when it was started) the server asks everyone with the Auto
// Puller panel to acknowledge. The first person to press "Keep running" answers for everyone; if nobody does
// within the answer window, the server stops Auto by itself - this page only shows the question.
//
// Data: the "auto.active" live topic (an in-memory summary, pushed every few seconds). The one setInterval here
// only repaints the countdown while the pop-up is open - it never calls the API.
const AutoReminder = (() => {
  let off = null;
  let tick = null;
  let current = null; // the summary being asked about
  let answered = null; // askedAt this page already answered, so it stays closed until the next question
  let el = null;

  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function build() {
    el = document.createElement("div");
    el.className = "ar-overlay hidden";
    el.setAttribute("role", "alertdialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-labelledby", "arTitle");
    el.innerHTML = `
      <div class="ar-card">
        <div class="ar-ico"><i class="ico" data-i="zap"></i></div>
        <h3 id="arTitle">Auto Puller is still running</h3>
        <p class="ar-who" id="arWho"></p>
        <p class="ar-ask">Is anyone watching it? Auto stops automatically in <b id="arLeft">1:00</b> unless someone keeps it running.</p>
        <div class="ar-actions">
          <button type="button" class="ar-stop" id="arStop"><i class="ico" data-i="stop"></i>Stop Auto</button>
          <button type="button" class="primary" id="arKeep"><i class="ico" data-i="check"></i>Keep running</button>
        </div>
        <p class="ar-err hidden" id="arErr"></p>
      </div>`;
    document.body.appendChild(el);
    el.querySelector("#arKeep").addEventListener("click", () => act("ack"));
    el.querySelector("#arStop").addEventListener("click", () => act("stop"));
  }

  function hide() {
    if (!el) return;
    el.classList.add("hidden");
    if (tick) { clearInterval(tick); tick = null; }
  }

  function paint() {
    if (!current || !current.reminder || !current.reminder.deadline) return hide();
    const left = current.reminder.deadline - Date.now();
    el.querySelector("#arLeft").textContent = mmss(left); // at 0:00 the server stops Auto; the next push closes this
  }

  function show(s) {
    if (!el) build();
    current = s;
    el.querySelector("#arWho").innerHTML = `Shared session${s.by ? ` started by <b>${esc(s.by)}</b>` : ""} &middot; ${s.called || 0} called, ${s.queued || 0} queued`;
    el.querySelector("#arErr").classList.add("hidden");
    el.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    const wasHidden = el.classList.contains("hidden");
    el.classList.remove("hidden");
    paint();
    if (!tick) tick = setInterval(paint, 1000);
    if (wasHidden) el.querySelector("#arKeep").focus();
  }

  async function act(kind) {
    if (!current) return;
    const s = current;
    el.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      await Api.post(`/auto-engine/sessions/${encodeURIComponent(s.sessionId)}/${kind}`);
      answered = s.reminder && s.reminder.askedAt;
      hide();
    } catch (e) {
      const err = el.querySelector("#arErr");
      err.textContent = e.message;
      err.classList.remove("hidden");
      el.querySelectorAll("button").forEach((b) => { b.disabled = false; });
    }
  }

  function onData(d) {
    const s = ((d && d.sessions) || [])[0];
    const asked = s && s.reminder && s.reminder.askedAt;
    if (!asked || asked === answered) { current = s || null; return hide(); }
    show(s);
  }

  function start() {
    if (off) return;
    off = Live.subscribe("auto.active", (evt) => { if (evt.type === "data") onData(evt.data); });
  }

  function stop() {
    if (off) { off(); off = null; }
    hide();
  }

  return { start, stop };
})();
