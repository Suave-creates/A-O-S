// Small non-blocking notifications (bottom-right). Used for things the
// operator should notice without a modal: a service connecting/disconnecting,
// the live stream dropping, a background refresh failing.
//   Toast.show({ title, message, tone: "ok"|"warn"|"danger"|"info", ms })
const Toast = (() => {
  const MAX = 4;

  function host() {
    return document.getElementById("toastHost");
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function dismiss(el) {
    if (!el || el.classList.contains("leaving")) return;
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 260);
  }

  function show({ title, message = "", tone = "info", ms = 4500 } = {}) {
    const h = host();
    if (!h || !title) return null;
    // Make room synchronously. (dismiss() only fades a toast out, so looping on it while the count stays
    // high never ends - that froze the page once when several alerts arrived together.)
    while (h.children.length >= MAX) h.firstElementChild.remove();
    const el = document.createElement("div");
    el.className = `toast ${tone}`;
    el.innerHTML = `<span class="toast-bar"></span><div><div class="toast-title">${esc(title)}</div>${message ? `<div class="toast-msg">${esc(message)}</div>` : ""}</div>`;
    el.addEventListener("click", () => dismiss(el));
    h.appendChild(el);
    if (ms > 0) setTimeout(() => dismiss(el), ms);
    return el;
  }

  return { show };
})();
