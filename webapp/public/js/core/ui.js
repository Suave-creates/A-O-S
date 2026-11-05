// Shared visual polish applied to every screen without touching its markup:
// replaces the leading emoji of each panel title with an icon chip from the
// icon set (icons.css), so older panels match the redesigned ones.
const UI = (() => {
  const MAP = {
    "📦": "package", "📊": "chart", "🔒": "lock", "⛏": "filter", "🔍": "search", "🏢": "building", "🏭": "building",
    "🧾": "check", "🔧": "package", "📈": "trend", "🗺": "grid", "📋": "file", "✋": "hand", "⚡": "zap", "🛡": "shield",
    "📤": "outbound", "🗜": "compact", "✅": "checkcircle", "🔗": "link", "🔄": "refresh", "⏱": "clock",
  };

  function decorateTitle(h3) {
    if (h3.querySelector(".h-ico")) return;
    const text = h3.textContent.trim();
    const chars = Array.from(text);
    const first = chars[0];
    if (!first || first.codePointAt(0) < 0x2190) return;
    const key = first.replace(/️/g, "");
    const ico = MAP[key] || "layers";
    let rest = chars.slice(1).join("").replace(/^️/, "").trim();
    h3.innerHTML = "";
    const chip = document.createElement("span");
    chip.className = "h-ico";
    chip.innerHTML = `<i class="ico" data-i="${ico}"></i>`;
    h3.appendChild(chip);
    h3.appendChild(document.createTextNode(rest));
  }

  function decorateAll(root = document) {
    root.querySelectorAll(".panel > h3:first-child").forEach(decorateTitle);
  }

  document.addEventListener("DOMContentLoaded", () => decorateAll());
  return { decorateAll };
})();
