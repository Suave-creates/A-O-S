// The shared Connection Status model - the ONE source of truth for "is
// Grafana/Concinity/NexS usable right now", consumed by the header component
// and the grouped operation log (same shared status - never a second,
// independent system).
//
// Every service is reached through ONE shared service-account login held by
// the backend (server/integrations/logins/), so "Connected" means the backend
// currently holds, or can obtain, a valid session for that service:
//   - Grafana / Concinity: a successful getValidToken() (cached almost
//     always, so cheap on every poll). Their shared accounts tolerate many
//     concurrent devices, so verifying/refreshing on every poll is fine.
//   - NexS: deliberately PASSIVE (operator-requested 2026-09-22: "only
//     trigger it when nexs functions are needed... else nexs will stay
//     stale"). NexS allows only ONE active session per account, so this
//     badge must never itself cause a login - it only reports whether a
//     session happens to be cached from a genuine prior use (Tote Purge /
//     Outside Tote Analysis). "Disconnected" simply means NexS hasn't been
//     used recently - not an error to chase.
// The display text is just "Connected"/"Disconnected" (operator instruction
// 2026-09-22: "just show connected and disconnected no via via").

const config = require("../../config");
const defaultGrafanaAuth = require("./grafanaAuth");
const defaultConcinityAuth = require("./concinityAuth");
const defaultNexsAuth = require("./nexsAuth");

const CONNECTED = Object.freeze({ connected: true, identity: "Connected" });
const DISCONNECTED = Object.freeze({ connected: false, identity: "Disconnected" });

async function activeLoginStatus(authModule) {
  try {
    await authModule.getValidToken();
    return { ...CONNECTED };
  } catch (e) {
    return { ...DISCONNECTED };
  }
}

async function getConnectionStatus({ grafanaAuth = defaultGrafanaAuth, concinityAuth = defaultConcinityAuth, nexsAuth = defaultNexsAuth } = {}) {
  const [grafana, concinity] = await Promise.all([activeLoginStatus(grafanaAuth), activeLoginStatus(concinityAuth)]);
  return {
    grafana,
    concinity,
    nexs: nexsAuth.hasCachedSession() ? { ...CONNECTED } : { ...DISCONNECTED },
  };
}

// Purge's real prerequisite gate (purgeEngine.js) - NEVER the cosmetic header
// flag above. Read-only and passive: it only checks that the shared account
// for each service is configured, and never logs in (a NexS login would
// kick out any other active session on the account).
function getServiceReadiness(cfg = config) {
  return {
    nexsReady: !!(cfg.nexsDirectUsername && cfg.nexsDirectPassword),
    quadronReady: !!(cfg.concinityDirectUsername && cfg.concinityDirectPassword),
  };
}

module.exports = { getConnectionStatus, getServiceReadiness };
