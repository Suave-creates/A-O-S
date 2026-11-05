// Server-side execution of GET_NEXS_DISCREPANCY_REPORT_BATCH (CNG Inv
// Validator - NexS leg). One GET per (facility, base tote, partition)
// against NexS's fetchDiscrepancyReport endpoint, reading data.imsCount -
// ported from the ASO Browser Runtime's executeGetNexsDiscrepancyReportBatch()
// with the same bounded concurrency and per-item failure isolation. The
// session is nexsAuth.js's shared single login; on-demand only.

const defaultNexsAuth = require("../logins/nexsAuth");
const { defaultDoRequest } = require("./nexsBlockedInventoryBatchDirect");

const NEXS_BATCH_CONCURRENCY = 5;

async function fetchOneCount(token, origin, base, part, facilityCode, signal, doRequest) {
  const location = `${facilityCode}-ASRS-${base}_PR${part}`;
  const url =
    `${origin}/nexs/api/ims/fetchDiscrepancyReport?page=0&sortBy=barcode&facility=${encodeURIComponent(facilityCode)}` +
    `&listType=all&location=${encodeURIComponent(location)}&sortOrder=DESC&size=1&totalCountRequired=true`;
  const { status, body } = await doRequest(url, {
    headers: { Accept: "application/json, text/plain, */*", "facility-code": facilityCode, "source-domain": origin, Cookie: `jwt-token=${token}` },
    signal,
  });
  if (status === 401 || status === 403) {
    const err = new Error(`NexS HTTP ${status}`);
    err.code = "UNAUTHORIZED"; // nexsAuth.withAuth() invalidates the cached session and retries once
    throw err;
  }
  if (status < 200 || status >= 300) throw new Error(`NexS HTTP ${status}`);
  return Number(((body && body.data) || {}).imsCount) || 0;
}

async function execute(appUserId, payload, signal, deps = {}) {
  const { nexsOrigin, items, facilityCode } = payload || {};
  const nexsAuth = deps.nexsAuth || defaultNexsAuth;
  const doRequest = deps.doRequest || defaultDoRequest;
  if (!Array.isArray(items) || items.length === 0) throw new Error("Rejected: items must be a non-empty array");
  const cleanFacility = (typeof facilityCode === "string" && facilityCode.trim()) || "NXS1";

  const results = [];
  for (let i = 0; i < items.length; i += NEXS_BATCH_CONCURRENCY) {
    const batch = items.slice(i, i + NEXS_BATCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((item) =>
        nexsAuth
          .withAuth((token) => fetchOneCount(token, nexsOrigin, item.base, item.part, cleanFacility, signal, doRequest), deps)
          .then((imsCount) => ({ base: item.base, part: item.part, status: "ok", imsCount, error: null }))
          .catch((e) => {
            if (e.name === "AbortError" || e.name === "TimeoutError") throw e; // stop the whole batch - never a per-item failure
            return { base: item.base, part: item.part, status: "failed", imsCount: null, error: e.message || String(e) };
          })
      )
    );
    results.push(...batchResults);
  }
  return { results, fetchedAt: new Date().toISOString() };
}

module.exports = { execute };
