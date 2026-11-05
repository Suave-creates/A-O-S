// Which screens ("panels") a user may open. The keys are the tab names the browser uses (data-tab).
//
//   users.panels = NULL  -> every panel (how all existing users keep working)
//   users.panels = JSON array of keys -> only those panels
//   role ADMIN           -> every panel, always (the Admin and Users tabs are admin-only on top of this)
//
// This is enforced on the SERVER (routes and live topics); hiding a tab in the browser is only a convenience.

const PANELS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "pickingMonitor", label: "Picking Monitor" },
  { key: "utilisation", label: "Tote Utilisation" },
  { key: "lockedToteInfo", label: "Locked Totes" },
  { key: "totePurge", label: "Tote Purge" },
  { key: "tracker", label: "Outside Totes" },
  { key: "asrsLocations", label: "Location Audit" },
  { key: "aisleOccupancy", label: "Aisle Occupancy" },
  { key: "cngValidator", label: "CNG Validator" },
  { key: "bulkInventoryCheck", label: "Bulk Tote Inv Check" },
  { key: "totePuller", label: "Manual Puller" },
  { key: "autoPuller", label: "Auto Puller" },
  { key: "pullerLogs", label: "Pull Logs" },
  { key: "onePagerReport", label: "One Pager Report" },
  { key: "asrsPerformance", label: "ASRS Performance" },
  { key: "lockedToteAnalytics", label: "Locked Tote Analytics" },
  { key: "alerts", label: "Alerts" },
];
const ALL_KEYS = PANELS.map((p) => p.key);

// A live topic is allowed when the user may open ANY of the panels listed. Topics not listed here (the
// connection indicators, per-user query/session streams, admin topics) are not panel-gated.
const TOPIC_PANELS = {
  alerts: ["alerts"],
  "dashboard.compaction": ["dashboard"], "dashboard.cc": ["dashboard"], "dashboard.aisle": ["dashboard"],
  "dashboard.outside": ["dashboard"], "dashboard.utilisation": ["dashboard"],
  "dashboard-detail": ["dashboard"],
  "picking.monitor": ["pickingMonitor"], "picking.pipeline": ["pickingMonitor"],
  "asrs-locations.current": ["asrsLocations"], "asrs-locations.marks": ["asrsLocations"],
  "aisle-occupancy.current": ["aisleOccupancy"],
  "locked-tote-info.current": ["lockedToteInfo"],
  "locked-tote-info.history": ["lockedToteInfo"],
  "locked-tote-info.latest": ["dashboard", "lockedToteInfo"], // the Dashboard's Locked Totes tile
  "tote-utilisation.history": ["utilisation"],
  "one-pager.current": ["onePagerReport"], "one-pager.bulk": ["onePagerReport"],
  "tote-purge.current": ["totePurge"],
  "auto.session": ["autoPuller", "dashboard"], // the operator's own session
  "auto.active": ["autoPuller", "dashboard"], // who is running Auto right now - the Dashboard tile and the Auto Puller banner
  operations: ["pullerLogs"], // Pull Logs (Manual + Auto sessions)
  // the latest run of each run-type screen, shared with everyone
  "dashboard.autoRefresh": ["dashboard"], // the Dashboard's central auto refresh: settings + countdown
  "shared.tracker": ["tracker"], "shared.cngValidator": ["cngValidator"], "shared.bulkInventoryCheck": ["bulkInventoryCheck"],
};

// Unknown / junk entries are dropped; duplicates removed; order follows the panel list.
function normalizePanels(list) {
  const set = new Set(Array.isArray(list) ? list : []);
  return ALL_KEYS.filter((k) => set.has(k));
}

// DB value (NULL | JSON text) -> null (= all) | array of valid keys.
function parseStored(value) {
  if (value == null || value === "") return null;
  try {
    const v = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(v) ? normalizePanels(v) : null;
  } catch (e) {
    return null;
  }
}

// The panels a user may actually open (always an array).
function effectivePanels(user) {
  if (!user || user.role === "ADMIN" || user.panels == null) return [...ALL_KEYS];
  return normalizePanels(user.panels);
}

// canAccess(user, "totePurge") / canAccess(user, "lockedToteInfo", "dashboard") - any one is enough.
function canAccess(user, ...keys) {
  if (!user) return false;
  if (user.role === "ADMIN" || user.panels == null) return true;
  return keys.some((k) => user.panels.includes(k));
}

function canSeeTopic(user, topic) {
  const base = String(topic || "").split(":")[0]; // "dashboard-detail:ccDone" -> "dashboard-detail"
  const need = TOPIC_PANELS[base];
  return !need || canAccess(user, ...need);
}

module.exports = { PANELS, ALL_KEYS, TOPIC_PANELS, normalizePanels, parseStored, effectivePanels, canAccess, canSeeTopic };
