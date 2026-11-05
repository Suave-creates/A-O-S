(() => {
  const loginView = document.getElementById("loginView");
  const appView = document.getElementById("appView");
  const appShell = document.getElementById("appShell");
  const sidebar = document.getElementById("sidebar");
  const sidebarNav = document.getElementById("sidebarNav");
  const sidebarCollapseBtn = document.getElementById("sidebarCollapseBtn");
  const sidebarMobileToggle = document.getElementById("sidebarMobileToggle");
  const sidebarOverlay = document.getElementById("sidebarOverlay");
  const sidebarProfileBtn = document.getElementById("sidebarProfileBtn");
  const sidebarProfileMenu = document.getElementById("sidebarProfileMenu");
  const sidebarAvatar = document.getElementById("sidebarAvatar");
  const sidebarProfileName = document.getElementById("sidebarProfileName");
  const sidebarProfileRole = document.getElementById("sidebarProfileRole");
  const localDevBadge = document.getElementById("localDevBadge");
  const adminTabBtn = document.getElementById("adminTabBtn");

  let currentUser = null;
  let pullerLogsHandle = null;
  let onePagerReportMounted = false;

  // The exact set of valid tab names, derived from the nav markup itself
  // (never hand-duplicated) - used to validate a URL hash before trusting it.
  const VALID_TABS = [...sidebarNav.querySelectorAll(".tab-btn")].map((b) => b.dataset.tab);

  // Gliding highlight: one element slides to the open screen's menu item, tinted with that item's section colour
  // (the sidebar animation in aos.css). Hidden if the open item is not shown (e.g. no access).
  const glider = document.createElement("span");
  glider.className = "nav-glider off";
  glider.setAttribute("aria-hidden", "true");
  sidebarNav.prepend(glider);
  sidebarNav.classList.add("has-glider");
  function moveGlider() {
    const btn = sidebarNav.querySelector(".tab-btn.active");
    const visible = !!btn && btn.offsetParent !== null;
    glider.classList.toggle("off", !visible);
    if (!visible) return;
    glider.style.setProperty("--sec", getComputedStyle(btn).getPropertyValue("--sec"));
    glider.style.height = btn.offsetHeight + "px";
    glider.style.transform = "translateY(" + btn.offsetTop + "px)";
    if (!glider.classList.contains("ready")) requestAnimationFrame(() => glider.classList.add("ready"));
  }
  window.addEventListener("resize", moveGlider);
  sidebar.addEventListener("transitionend", (e) => { if (e.target === sidebar && e.propertyName === "width") moveGlider(); });

  // ── Tab navigation (unchanged mechanism: hide all .tab-panel, show
  // #tab-{name}; unchanged .tab-btn/.active semantics - only the container
  // markup around the buttons changed, per the Phase 0 shell redesign).
  // Additive: the current tab is now reflected in location.hash so a
  // refresh or browser back/forward preserves/restores it - this did not
  // exist before (showTab() was purely in-memory), and is the minimum
  // needed to satisfy "refresh preserves active module" without adding any
  // routing framework. ──────────────────────────────────────────────────
  // Tracks which tab was active before this call, so Dashboard's own
  // FAST_REFRESH_MS poll (see dashboard.js) can be stopped the moment the
  // operator navigates away - it must never keep polling every 2s in the
  // background for the rest of the shift just because the tab was opened
  // once.
  let currentTab = null;

  // Which tabs this user may open: the panels the server grants (/auth/me, /auth/login), plus Admin / Users for
  // admins. The server enforces this on every request too - this only decides what is shown.
  const isAdminUser = () => !!currentUser && currentUser.role === "ADMIN";
  function allowedTab(name) {
    if (!currentUser) return false;
    if (name === "admin" || name === "users") return isAdminUser();
    return isAdminUser() || (currentUser.panels || []).includes(name);
  }
  const firstAllowedTab = () => (allowedTab("dashboard") ? "dashboard" : VALID_TABS.find(allowedTab) || "dashboard");

  function applyPanelAccess() {
    document.querySelectorAll(".tab-btn").forEach((b) => { b.style.display = allowedTab(b.dataset.tab) ? "" : "none"; });
    document.querySelectorAll(".nav-group, .nav-section").forEach((g) => {
      g.style.display = [...g.querySelectorAll(".tab-btn")].some((b) => b.style.display !== "none") ? "" : "none";
    });
    // in-screen shortcuts to Pull Logs only for people who can open it
    document.querySelectorAll(".pl-link-card").forEach((c) => { c.style.display = allowedTab("pullerLogs") ? "" : "none"; });
  }

  function showTab(name, { updateHash = true } = {}) {
    if (!VALID_TABS.includes(name) || !allowedTab(name)) name = firstAllowedTab();
    const previousTab = currentTab;
    currentTab = name;
    document.querySelectorAll(".tab-panel").forEach((el) => el.classList.add("hidden"));
    document.querySelectorAll(".tab-btn").forEach((el) => {
      el.classList.remove("active");
      el.removeAttribute("aria-current");
    });
    document.getElementById("tab-" + name).classList.remove("hidden");
    const activeBtn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
    activeBtn.classList.add("active");
    activeBtn.setAttribute("aria-current", "page");
    // Shell context for the AOS Ink styles (aos.css): which screen is up, and the top-bar "Section / Page" crumb.
    document.body.dataset.screen = name;
    const section = activeBtn.closest(".nav-section");
    const sectionLabel = section ? section.querySelector(".nav-section-label") : null;
    document.getElementById("topbarSection").textContent = sectionLabel ? sectionLabel.textContent : "AOS";
    document.getElementById("topbarPage").textContent = activeBtn.querySelector(".nav-label").textContent;
    moveGlider();
    if (updateHash && location.hash.slice(1) !== name) {
      history.pushState({ tab: name }, "", "#" + name);
    }
    closeMobileSidebar();
    if (name === "onePagerReport") mountOnce();
    // Screen lifecycle: leaving a tab unsubscribes its live topics, entering
    // subscribes - a screen that isn't on display costs the server nothing.
    if (previousTab && previousTab !== name) {
      stopScreen(previousTab);
      NexsConnect.release(previousTab); // the user left: NexS is dropped once nothing is using it
    }
    // Opening a tab shows the data everyone shares as it is (operator decision 2026-11-04: what anyone loaded is
    // seen by everyone until a manual or auto refresh) - it never triggers a read itself; only the first viewer of
    // a topic with nothing yet causes its first read (server side).
    startScreen(name);
  }

  // Which components run (subscribe to live topics) while each tab is open.
  function screensFor(name) {
    if (name === "dashboard") return [Dashboard];
    if (name === "pickingMonitor") return [PickingMonitor];
    if (name === "utilisation") return [Utilisation];
    if (name === "alerts") return [Alerts];
    if (name === "users") return [Users];
    if (name === "lockedToteInfo") return [LockedToteInformation];
    if (name === "totePurge") return [TotePurge];
    if (name === "asrsLocations") return [AsrsLocations];
    if (name === "aisleOccupancy") return [AisleOccupancy];
    if (name === "autoPuller") return [AutoTotePuller];
    if (name === "onePagerReport") return [OnePagerReport];
    if (name === "asrsPerformance") return [AsrsPerformance];
    if (name === "lockedToteAnalytics") return [LockedToteAnalytics];
    // run-type screens: they follow the latest run anyone made (shared until someone runs again)
    if (name === "tracker") return [TrackerPanel];
    if (name === "cngValidator") return [CNGValidatorPanel];
    if (name === "bulkInventoryCheck") return [BulkInventoryCheck];
    if (name === "admin") return [Admin];
    if (name === "pullerLogs") {
      // The one pull log: Manual + Auto sessions (live topic "operations", or a date range from /pull-logs).
      if (!pullerLogsHandle) {
        const el = (id) => document.getElementById(id);
        pullerLogsHandle = OperationLog.mount({
          container: el("pullerLogsContainer"),
          stats: el("pullerLogsStats"),
          kindSeg: el("pullerLogsKind"),
          rangeSeg: el("pullerLogsRange"),
          from: el("pullerLogsFrom"),
          to: el("pullerLogsTo"),
          apply: el("pullerLogsApply"),
          rangeNote: el("pullerLogsRangeNote"),
          search: el("pullerLogsSearch"),
          exportBtn: el("pullerLogsExportBtn"),
          more: el("pullerLogsMore"),
        });
        document.getElementById("pullerLogsRefreshBtn").addEventListener("click", () => pullerLogsHandle.refresh());
      }
      return [pullerLogsHandle];
    }
    return [];
  }
  const startScreen = (name) => screensFor(name).forEach((s) => s.start && s.start());
  const stopScreen = (name) => screensFor(name).forEach((s) => s.stop && s.stop());

  function mountOnce() {
    if (!onePagerReportMounted) {
      OnePagerReport.mount();
      onePagerReportMounted = true;
    }
  }

  // Event delegation - one listener for the whole nav rather than one per
  // button (the nav is static HTML, never regenerated, but delegation
  // keeps this robust and matches the shell's own performance guidance).
  sidebarNav.addEventListener("click", (e) => {
    const groupHead = e.target.closest(".nav-group-head");
    if (groupHead) {
      groupHead.closest(".nav-group").classList.toggle("collapsed");
      groupHead.setAttribute("aria-expanded", String(!groupHead.closest(".nav-group").classList.contains("collapsed")));
      return;
    }
    const btn = e.target.closest(".tab-btn");
    if (btn) showTab(btn.dataset.tab);
  });

  window.addEventListener("popstate", () => {
    showTab(location.hash.slice(1) || "dashboard", { updateHash: false });
  });

  // ── Sidebar collapse (desktop) - persisted, restored on load ──────────
  const COLLAPSE_KEY = "aso_sidebar_collapsed";

  function applyCollapsed(collapsed) {
    sidebar.classList.toggle("collapsed", collapsed);
    appShell.classList.toggle("sidebar-collapsed", collapsed);
    sidebarCollapseBtn.setAttribute("aria-expanded", String(!collapsed));
    sidebarCollapseBtn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  }

  function loadCollapsedPref() {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "true";
    } catch (e) {
      return false;
    }
  }
  function saveCollapsedPref(collapsed) {
    try {
      localStorage.setItem(COLLAPSE_KEY, String(collapsed));
    } catch (e) {
      /* ignore - non-fatal, just won't persist across reloads */
    }
  }

  applyCollapsed(loadCollapsedPref());

  sidebarCollapseBtn.addEventListener("click", () => {
    const collapsed = !sidebar.classList.contains("collapsed");
    applyCollapsed(collapsed);
    saveCollapsedPref(collapsed);
  });

  // ── Mobile drawer ───────────────────────────────────────────────────────
  function openMobileSidebar() {
    sidebar.classList.add("mobile-open");
    sidebarOverlay.classList.remove("hidden");
    sidebarMobileToggle.setAttribute("aria-expanded", "true");
  }
  function closeMobileSidebar() {
    sidebar.classList.remove("mobile-open");
    sidebarOverlay.classList.add("hidden");
    sidebarMobileToggle.setAttribute("aria-expanded", "false");
  }
  sidebarMobileToggle.addEventListener("click", () => {
    if (sidebar.classList.contains("mobile-open")) closeMobileSidebar();
    else openMobileSidebar();
  });
  sidebarOverlay.addEventListener("click", closeMobileSidebar);

  // ── Profile menu (logout) ──────────────────────────────────────────────
  function closeProfileMenu() {
    sidebarProfileMenu.classList.add("hidden");
    sidebarProfileBtn.setAttribute("aria-expanded", "false");
  }
  sidebarProfileBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = sidebarProfileMenu.classList.contains("hidden");
    sidebarProfileMenu.classList.toggle("hidden", !willOpen);
    sidebarProfileBtn.setAttribute("aria-expanded", String(willOpen));
  });
  document.addEventListener("click", (e) => {
    if (!sidebarProfileMenu.classList.contains("hidden") && !sidebarProfileMenu.contains(e.target) && e.target !== sidebarProfileBtn) {
      closeProfileMenu();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeProfileMenu();
      closeMobileSidebar();
    }
  });

  async function checkSession() {
    try {
      currentUser = await Api.get("/auth/me");
      window.currentUserRole = () => currentUser && currentUser.role;
      window.currentUserId = () => currentUser && currentUser.employeeId;
      renderLoggedIn();
    } catch (e) {
      renderLoggedOut();
    }
  }

  function renderLoggedIn() {
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");

    // Real authenticated session data only - no hard-coded name/email
    // anywhere in this shell. The user model has no email field today, so
    // the profile's secondary line shows role (real data) rather than a
    // fabricated address - see the Phase 0 report for this deviation from
    // the reference mockup.
    sidebarAvatar.textContent = (currentUser.employeeId || "?").trim().charAt(0).toUpperCase();
    sidebarProfileName.textContent = currentUser.employeeId;
    sidebarProfileRole.textContent = currentUser.role;

    // Purely a reflection of server-side state (/auth/me's own localDev
    // field, itself only ever set from req.isLocalDevSession inside
    // requireAuth's STRICT LOCAL DEVELOPMENT AUTH MODE branch) - never a
    // switch, never something set from the UI. pendingSyncCount/lastSyncAt
    // (Local-First Phase 1) are likewise read-only reflections of the local
    // outbox - see server/lib/outbox.js/syncMeta.js - never something the
    // UI can trigger; syncing only ever happens via `npm run
    // sync-local-to-company`, run by hand on the company network.
    localDevBadge.classList.toggle("hidden", !currentUser.localDev);
    if (currentUser.localDev) {
      const lastSync = currentUser.lastSyncAt
        ? new Date(currentUser.lastSyncAt).toLocaleTimeString()
        : "Never";
      localDevBadge.textContent = `LOCAL DEV ● ${currentUser.pendingSyncCount} pending sync ● Last sync: ${lastSync}`;
    }
    applyPanelAccess();
    // Mounted once, in the persistent shell, shows consistently on every
    // tab without any per-page setup, since the shell never unmounts.
    ConnectionStatus.mount(document.getElementById("connectionStatusBar"));
    ConnectionStatus.start();
    if (allowedTab("alerts")) AlertsTray.start(); // the alert panel + nav badge; alerting runs while the app is open
    if (allowedTab("autoPuller")) AutoReminder.start(); // the shared Auto Puller's "is anyone watching?" pop-up, on every tab

    const initialTab = allowedTab(location.hash.slice(1)) ? location.hash.slice(1) : firstAllowedTab();
    showTab(initialTab, { updateHash: false });
  }

  function renderLoggedOut() {
    currentUser = null;
    AutoReminder.stop();
    appView.classList.add("hidden");
    loginView.classList.remove("hidden");
  }

  // Enter or the button submits. The button pulses while the server checks; only an accepted login plays the
  // sign-in transition (LoginFx), and the app is shown when it reaches the zoom.
  document.getElementById("loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = document.getElementById("loginBtn");
    if (btn.disabled) return;
    const employeeId = document.getElementById("employeeId").value.trim();
    const password = document.getElementById("password").value;
    const errBox = document.getElementById("loginError");
    errBox.classList.add("hidden");
    btn.disabled = true;
    btn.classList.add("is-busy");
    try {
      currentUser = await Api.post("/auth/login", { employeeId, password });
      document.getElementById("password").value = "";
      await LoginFx.play(currentUser.employeeId).catch(() => {}); // a visual hiccup must never block sign-in
      renderLoggedIn();
      appView.classList.add("lx-arrive");
      setTimeout(() => appView.classList.remove("lx-arrive"), 900);
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
      document.getElementById("lxCard").classList.remove("lx-shake");
      void document.getElementById("lxCard").offsetWidth; // restart the shake
      document.getElementById("lxCard").classList.add("lx-shake");
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-busy");
    }
  });

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    closeProfileMenu();
    try { await Api.post("/auth/logout"); } catch (e) { /* ignore */ }
    renderLoggedOut();
  });

  window.ASO = { get currentUser() { return currentUser; } };

  checkSession();
})();
