// Server-side execution of GET_NEXS_BLOCKED_INVENTORY_BATCH: same URL shape,
// per-PID failure isolation and bounded concurrency as before, with the
// session coming from nexsAuth.js's shared single-login cookie.
//
// ON-DEMAND ONLY (2026-09-22, operator-requested: "only trigger it when
// nexs functions are needed... else nexs will stay stale"). NexS allows
// only ONE active session per account (unlike Grafana/Concinity's shared
// account, which supports many concurrent devices) - so this module never
// runs speculatively or on a timer. It is reached only when Tote Purge or
// Outside Tote Analysis actually dispatches this capability (see
// purgeEngine.js/trackerEngine.js), and the connection-status badge
// deliberately does NOT call nexsAuth.getValidToken() itself (see
// connectionStatus.routes.js's own comment) - a login is only ever
// attempted here, when the data is genuinely needed.

const https = require("node:https");
const defaultNexsAuth = require("../logins/nexsAuth");

const NEXS_BATCH_CONCURRENCY = 5;

function defaultDoRequest(url, { headers, signal }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "GET", headers, signal }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          /* non-JSON response - parsed stays null, caller handles it */
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// One already-validated pid/facilityCode pair - mirrors the runtime's own
// fetchOneNexsBlockedInventory() request contract exactly (same fixed URL
// shape, same headers). `token` is nexsAuth's own
// raw JWT; sent as the cookie `jwt-token=<jwt>`.
async function fetchOne(token, nexsOrigin, pid, facilityCode, signal, doRequest) {
  const url = `${nexsOrigin}/nexs/cid/api/v1/warehouseInventory/getConsolidatedInvInfo/${encodeURIComponent(pid)}`;
  const { status, body } = await doRequest(url, {
    headers: { Accept: "application/json, text/plain, */*", "facility-code": facilityCode, Cookie: `jwt-token=${token}` },
    signal,
  });

  if (status === 401 || status === 403) {
    const err = new Error(`NexS HTTP ${status}`);
    err.code = "UNAUTHORIZED"; // tells nexsAuth.withAuth() to invalidate the cached session and retry once
    throw err;
  }
  if (status < 200 || status >= 300) throw new Error(`NexS HTTP ${status}`);
  return (body && body.data) || {};
}

// Called by capabilityManager.js's dispatchDirectly() exactly like a
// registry capability's own buildPayload/validateResult - payload is
// exactly what nexsBlockedInventoryBatch.buildPayload(nexsOrigin, params)
// already produces: {nexsOrigin, pids, facilityCode}. appUserId is part of
// the uniform directExecute(appUserId, payload, signal) contract but is
// unused here: nexsAuth.js's login is a SHARED single account, not a
// per-user credential.
async function execute(appUserId, payload, signal, deps = {}) {
  const { nexsOrigin, pids, facilityCode } = payload || {};
  const nexsAuth = deps.nexsAuth || defaultNexsAuth;
  const doRequest = deps.doRequest || defaultDoRequest;

  // Dedup + trim - same safety net as the runtime's own handler, regardless
  // of what the caller sent.
  const seen = new Set();
  const uniquePids = [];
  for (const raw of Array.isArray(pids) ? pids : []) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const p = raw.trim();
    if (!seen.has(p)) {
      seen.add(p);
      uniquePids.push(p);
    }
  }
  const cleanFacility = facilityCode || "NXS1";

  const results = [];
  for (let i = 0; i < uniquePids.length; i += NEXS_BATCH_CONCURRENCY) {
    const batch = uniquePids.slice(i, i + NEXS_BATCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((pid) =>
        nexsAuth
          .withAuth((token) => fetchOne(token, nexsOrigin, pid, cleanFacility, signal, doRequest), deps)
          .then((data) => ({
            pid,
            status: "ok",
            totalInventory: Number(data.totalInventory) || 0,
            blockedInventory: Number(data.blockedInventory) || 0,
            availableInventory: Number(data.availableInventory) || 0,
            error: null,
          }))
          .catch((e) => {
            if (e.name === "AbortError" || e.name === "TimeoutError") throw e; // stop the whole batch - never a per-PID failure
            return { pid, status: "failed", totalInventory: 0, blockedInventory: 0, availableInventory: 0, error: e.message || String(e) };
          })
      )
    );
    results.push(...batchResults);
  }

  return { results, requestedCount: (pids || []).length, uniqueCount: uniquePids.length, fetchedAt: new Date().toISOString() };
}

module.exports = { execute, fetchOne, defaultDoRequest };
