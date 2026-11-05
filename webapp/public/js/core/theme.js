// Light / dark mode. The choice is remembered in this browser (localStorage); the inline script in
// index.html applies it before the first paint so the page never flashes the wrong theme.
const Theme = (() => {
  const KEY = "aso_theme";
  const root = document.documentElement;
  const btn = document.getElementById("themeToggle");

  const current = () => (root.getAttribute("data-theme") === "light" ? "light" : "dark");

  function apply(theme) {
    if (theme === "light") root.setAttribute("data-theme", "light"); else root.removeAttribute("data-theme");
    try { localStorage.setItem(KEY, theme); } catch (e) { /* not remembered - fine */ }
    if (btn) {
      const icon = btn.querySelector(".ico");
      if (icon) icon.setAttribute("data-i", theme === "light" ? "moon" : "sun"); // shows what a click switches TO
      btn.setAttribute("aria-label", theme === "light" ? "Switch to dark mode" : "Switch to light mode");
    }
  }

  if (btn) {
    apply(current()); // syncs the icon with what the head script applied
    btn.addEventListener("click", () => apply(current() === "light" ? "dark" : "light"));
  }
  return { current, apply };
})();
