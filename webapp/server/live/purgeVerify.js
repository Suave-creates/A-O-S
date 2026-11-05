// Wires purge tracking (features/tote-puller/purgeTracking.js) to Quadron and a timer:
//   - the Manual Puller engine takes the baseline the moment a purge session's calling finishes
//   - a server timer then watches the pending totes (a Quadron inventory read only when one is due, see readIsDue)
// Nothing here runs from a browser.

const config = require("../config");
const { fetchCapabilitySource } = require("../integrations/capabilities/capabilitySource");
const { getSystemUser } = require("./systemUser");
const tracking = require("../features/tote-puller/purgeTracking");
const { defaultEngine } = require("../features/tote-puller/totePullEngine");

let timer = null;
let running = false;

const fetchInventory = async () => fetchCapabilitySource({ user: await getSystemUser(), capabilityName: "GET_QUADRON_INVENTORY" });

function registerPurgeVerifier() {
  defaultEngine.onPurgeSessionDone = (sessionId) => tracking.afterSession(sessionId, { fetchInventory });
  if (timer || !(config.purgeVerifyEveryMs > 0)) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tracking.runPass({ fetchInventory });
    } catch (e) {
      console.warn("[purgeVerify] pass failed:", e.message || String(e));
    } finally {
      running = false;
    }
  }, config.purgeVerifyEveryMs);
  timer.unref();
}

module.exports = { registerPurgeVerifier };
