// Server-side execution of PULL_QUADRON_TOTE - the one MUTATING capability.
// Ported from the ASO Browser Runtime's executePullQuadronTote() /
// classifyQuadronPullResult(): same URL, same body, same verdict
// classification. The Bearer token now comes from concinityAuth.js's shared
// login instead of an open browser tab.
//
// A 401/403 is tagged UNAUTHORIZED so concinityAuth.withAuth() re-logs in and
// retries ONCE - safe for a write, since an auth rejection means Quadron did
// not act on the request. Any other non-2xx that carries a classifiable body
// (e.g. 404 "tote not available") is a real outcome, not a failure.

const https = require("node:https");
const defaultConcinityAuth = require("../logins/concinityAuth");
const { decodeJwtSub } = require("./quadronInventoryDirect");
const { TOTE_ID_REGEX } = require("./pullQuadronTote");

// Same self-signed-cert host and request-scoped agent as quadronInventoryDirect.js.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// Mirrors the legacy extension's classifyResult(): the same message-text
// matching against the four real Quadron outcomes. null = unrecognized.
function classifyQuadronPullResult(status, ok, data) {
  const raw = (data && (data.message || data.error)) || "";
  const lo = String(raw).toLowerCase();
  const rawMessage = raw || `HTTP ${status}`;
  if (ok && data && data.success) return { verdict: "INSERTED", rawMessage };
  if (lo.includes("already in the queue") || lo.includes("already in queue") || lo.includes("in movement") || lo.includes("is in movement")) {
    return { verdict: "ALREADY_QUEUED", rawMessage };
  }
  if (lo.includes("released from quadron") || lo.includes("released")) return { verdict: "RELEASED", rawMessage };
  if (
    lo.includes("not available") ||
    lo.includes("not found") ||
    lo.includes("does not exist") ||
    lo.includes("no data") ||
    status === 404 ||
    !data ||
    lo === ""
  ) {
    return { verdict: "NOT_AVAILABLE", rawMessage };
  }
  return null;
}

function defaultDoRequest(url, { headers, body, signal }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        agent: insecureAgent,
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        signal,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            /* non-JSON body - parsed stays null, classifier treats it as NOT_AVAILABLE */
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function postPull(token, { quadronOrigin, toteId, zone, instanceCode }, signal, doRequest) {
  const url = `${quadronOrigin}/quadron/dashboard/pull-crate`; // fixed path, never taken from the payload
  const { status, body } = await doRequest(url, {
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
    body: JSON.stringify({ container: toteId, station: String(zone) }),
    signal,
  });
  if (status === 401 || status === 403) {
    const err = new Error(`Quadron HTTP ${status}`);
    err.code = "UNAUTHORIZED";
    throw err;
  }
  return { status, body };
}

async function execute(appUserId, payload, signal, deps = {}) {
  const { toteId, zone, instanceCode } = payload || {};
  if (!TOTE_ID_REGEX.test(String(toteId || ""))) throw new Error(`Rejected: toteId "${toteId}" is not a valid tote id`);
  if (!zone) throw new Error("Rejected: zone is required");

  const concinityAuth = deps.concinityAuth || defaultConcinityAuth;
  const doRequest = deps.doRequest || defaultDoRequest;
  const { status, body } = await concinityAuth.withAuth((token) => postPull(token, payload, signal, doRequest), deps);

  const ok = status >= 200 && status < 300;
  const verdict = classifyQuadronPullResult(status, ok, body);
  if (!verdict) {
    throw new Error(`Unrecognized Quadron response (status ${status}) - not one of INSERTED/ALREADY_QUEUED/RELEASED/NOT_AVAILABLE`);
  }
  return { ...verdict, toteId, zone: String(zone), instanceCode: instanceCode || "LK-069", completedAt: new Date().toISOString() };
}

module.exports = { execute, classifyQuadronPullResult };
