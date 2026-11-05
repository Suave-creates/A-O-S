// Sign-in experience: the circuit-board backdrop behind the glass card, the show/hide password eye, and the
// transition after a successful sign-in (card dissolves -> the logo becomes a glowing tile -> the camera zooms
// through it into light -> the app fades in behind a "Welcome back" moment). Purely visual: app.js calls
// LoginFx.play() only after the server has accepted the login, and nothing here touches data.
// Reduced motion (or a click) skips straight to the app. A restored session never plays it.
const LoginFx = (() => {
  const reduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const SVG = "http://www.w3.org/2000/svg";

  // Circuit traces running in from both screen edges toward the card, each with a light pulse travelling
  // along it. Seeded so the layout is the same on every visit.
  function drawCircuit(svg) {
    if (!svg || svg.childNodes.length) return;
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    const g = document.createElementNS(SVG, "g");
    for (const side of [0, 1]) {
      for (let i = 0; i < 15; i++) {
        const y0 = 70 + i * 52 + rnd() * 18;
        const run = 140 + rnd() * 260;
        const rise = (rnd() - 0.5) * 140;
        const reach = 470 + rnd() * 120; // how close to the centre the trace gets
        const x0 = side ? 1600 : 0, dir = side ? -1 : 1;
        const x1 = x0 + dir * run, x2 = x1 + dir * Math.abs(rise), x3 = x0 + dir * reach;
        const d = `M${x0},${y0} H${x1} L${x2},${y0 + rise} H${x3}`;
        const base = document.createElementNS(SVG, "path");
        base.setAttribute("d", d); base.setAttribute("class", "lx-trace");
        const pulse = document.createElementNS(SVG, "path");
        pulse.setAttribute("d", d); pulse.setAttribute("class", "lx-pulse"); pulse.setAttribute("pathLength", "1000");
        pulse.style.animationDelay = (rnd() * 6).toFixed(2) + "s";
        pulse.style.animationDuration = (4 + rnd() * 4).toFixed(2) + "s";
        const node = document.createElementNS(SVG, "circle");
        node.setAttribute("cx", x3); node.setAttribute("cy", y0 + rise); node.setAttribute("r", 3); node.setAttribute("class", "lx-node");
        g.append(base, pulse, node);
      }
    }
    svg.appendChild(g);
  }

  function wireEye() {
    const btn = document.getElementById("lxPwToggle");
    const pw = document.getElementById("password");
    if (!btn || !pw) return;
    btn.addEventListener("click", () => {
      const show = pw.type === "password";
      pw.type = show ? "text" : "password";
      btn.setAttribute("aria-pressed", String(show));
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      pw.focus();
    });
  }

  function particles(host) {
    if (host.childNodes.length) return;
    for (let i = 0; i < 46; i++) {
      const s = document.createElement("i");
      s.style.left = (8 + Math.random() * 84).toFixed(1) + "%";
      s.style.top = (18 + Math.random() * 64).toFixed(1) + "%";
      s.style.setProperty("--s", (2 + Math.random() * 5).toFixed(1) + "px");
      s.style.animationDelay = (Math.random() * 0.8).toFixed(2) + "s";
      host.appendChild(s);
    }
  }

  // Resolves when the app should be revealed (behind the welcome); the welcome then clears itself.
  async function play(name) {
    const view = document.getElementById("loginView");
    const fx = document.getElementById("loginFx");
    if (reduced() || !fx) return;
    let skipped = false;
    const skip = () => { skipped = true; };
    fx.addEventListener("click", skip, { once: true });
    const step = async (ms) => { if (!skipped) await wait(ms); };

    document.getElementById("lxWelcomeName").textContent = name || "";
    particles(fx.querySelector(".lx-welcome-dots"));
    view.classList.add("lx-leaving");        // card dissolves, circuits surge
    fx.hidden = false;
    fx.className = "lx-fx";
    await step(380);
    fx.classList.add("is-tile");             // the logo becomes a glowing tile
    await step(900);
    fx.classList.add("is-zoom");             // fly through it into the light
    await step(720);
    view.classList.remove("lx-leaving");
    // the app arrives behind the welcome; the welcome lingers, then clears
    (async () => {
      fx.classList.add("is-welcome");
      await step(1500);
      fx.classList.add("is-out");
      await wait(450);
      fx.hidden = true;
      fx.className = "lx-fx";
    })();
  }

  function init() {
    drawCircuit(document.getElementById("lxCircuit"));
    wireEye();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  return { play };
})();
