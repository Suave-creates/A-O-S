// Server-side execution of GET_NEXS_BLOCKED_INVENTORY (one PID). Same request
// contract as the batch capability (see nexsBlockedInventoryBatchDirect.js,
// whose fetchOne() this reuses) - ported from the ASO Browser Runtime's
// executeGetNexsBlockedInventory(). On-demand only, like every NexS call:
// the account allows a single active session, so nothing here ever runs on a
// timer.

const defaultNexsAuth = require("../logins/nexsAuth");
const { fetchOne, defaultDoRequest } = require("./nexsBlockedInventoryBatchDirect");

async function execute(appUserId, payload, signal, deps = {}) {
  const { nexsOrigin, pid, facilityCode } = payload || {};
  const nexsAuth = deps.nexsAuth || defaultNexsAuth;
  const doRequest = deps.doRequest || defaultDoRequest;

  if (typeof pid !== "string" || !pid.trim()) throw new Error("Rejected: pid is required and must be a non-empty string");
  const cleanPid = pid.trim();
  const cleanFacility = (typeof facilityCode === "string" && facilityCode.trim()) || "NXS1";

  const data = await nexsAuth.withAuth((token) => fetchOne(token, nexsOrigin, cleanPid, cleanFacility, signal, doRequest), deps);
  return { pid: cleanPid, data, fetchedAt: new Date().toISOString() };
}

module.exports = { execute };
