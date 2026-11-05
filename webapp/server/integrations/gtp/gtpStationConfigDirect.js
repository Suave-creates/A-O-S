// Server-side execution of GET_GTP_STATION_CONFIG: one GET of the GTP station list with the shared Concinity
// login (same host, token and scoped self-signed-certificate handling as the Quadron inventory call).

const defaultConcinityAuth = require("../logins/concinityAuth");
const { defaultDoRequest, decodeJwtSub } = require("../quadron/quadronInventoryDirect");

// state "1" = the station is logged in and available. The upstream sends it as a string.
function normalize(body) {
  const items = Array.isArray(body) ? body : (body && body.items) || [];
  return items.filter((r) => r && r.id).map((r) => ({
    id: String(r.id),
    type: String(r.type || "UNKNOWN"),
    operationType: String(r.operationType || "NA"),
    userId: r.userId ? String(r.userId) : null,
    loggedIn: String(r.state) === "1",
    priorityWeight: r.priorityWeight == null ? null : Number(r.priorityWeight),
    category: r.category ? String(r.category) : null,
  }));
}

async function fetchConfig(token, origin, instanceCode, signal, { doRequest = defaultDoRequest } = {}) {
  const { status, body } = await doRequest(`${origin}/gtp/get-station-config-details`, {
    headers: {
      Accept: "application/json, text/plain, */*",
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store, must-revalidate, pre-check=0",
      Pragma: "no-cache",
      Expires: "0",
      "X-User-Info-Name": decodeJwtSub(token),
      "idempotency-key": "key-" + Date.now(),
      instanceCode: instanceCode || "LK-069",
    },
    signal,
  });
  if (status === 401 || status === 403) throw Object.assign(new Error(`GTP HTTP ${status}`), { code: "UNAUTHORIZED" });
  if (status < 200 || status >= 300) throw new Error(`GTP HTTP ${status}`);
  const stations = normalize(body);
  if (!stations.length) throw new Error("GTP returned no stations");
  return { stations, fetchedAt: new Date().toISOString() };
}

async function execute(appUserId, params, signal, deps = {}) {
  const { origin, instanceCode } = params || {};
  const auth = deps.concinityAuth || defaultConcinityAuth;
  return auth.withAuth((token) => fetchConfig(token, origin, instanceCode, signal, deps), deps);
}

module.exports = { execute, normalize };
