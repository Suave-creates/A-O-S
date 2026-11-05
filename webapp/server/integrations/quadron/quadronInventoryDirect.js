// Direct-login pilot (2026-09-05) - server-side execution of
// GET_QUADRON_INVENTORY when config.concinityAuthMode === "direct", instead
// of relaying through the ASO Browser Runtime. Ported field-for-field from
// the runtime's own already-verified implementation
// (runtime/background/capabilities.js's executeGetQuadronInventory() +
// relayQuadronViaAuthenticatedTab()) - same URL, same headers, same
// partitioned-row aggregation. The only thing that actually changes is
// where the Authorization Bearer token comes from: concinityAuth.js's own
// stored-credential login instead of scanning an open browser tab's
// localStorage/sessionStorage for one.

const https = require("node:https");
const defaultConcinityAuth = require("../logins/concinityAuth");

const TOTE_REGEX = /^(TL|TS)[0-9]{10}$/;

// 192.168.24.230 uses a self-signed certificate - same host, same reasoning,
// same scoping as concinityAuth.js's own insecureAgent (confirmed with the
// operator there; every real capture of this host needed curl's --insecure
// too). A first live test of this module (2026-09-05) used the global
// `fetch`, which has no way to opt out of certificate verification, and
// failed with a bare "fetch failed" for exactly this reason - node:https
// with a private, request-scoped Agent (never applied globally) is what
// actually works here, mirroring concinityAuth.js exactly rather than
// inventing a second way to talk to the same host.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// "TS0000018492-6" -> { base:"TS0000018492", part:6 }. Mirrors
// splitPartitionedToteId() in runtime/background/capabilities.js exactly.
function splitPartitionedToteId(id) {
  const s = String(id || "");
  const i = s.lastIndexOf("-");
  if (i < 0) return { base: s, part: null };
  const part = parseInt(s.slice(i + 1), 10);
  return { base: s.slice(0, i), part: Number.isNaN(part) ? null : part };
}

function decodeJwtSub(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return "";
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.sub || "";
  } catch (e) {
    return "";
  }
}

// Aggregates partitioned rows (e.g. "TS0000018492-6") up to their base tote
// id, summing quantity across partitions - mirrors the runtime's own
// executeGetQuadronInventory() byBase logic exactly, including the same
// TOTE_REGEX row filter.
function normalizeRows(raw) {
  const rowsRaw = Array.isArray(raw) ? raw : (raw && (raw.content || raw.data || raw.rows || raw.items)) || [];
  const byBase = new Map();
  for (const r of rowsRaw) {
    const { base, part } = splitPartitionedToteId(r && r.toteId);
    if (!TOTE_REGEX.test(base)) continue;
    const md = (r.materialDetails && r.materialDetails[0]) || {};
    const qty = Number(md.quantity) || 0;
    const sku = md.sku ?? null;
    if (!byBase.has(base)) byBase.set(base, { toteId: base, quadronQty: 0, partitions: [] });
    const entry = byBase.get(base);
    entry.quadronQty += qty;
    if (part != null) entry.partitions.push({ part, qty, sku });
  }
  return [...byBase.values()];
}

// Same fixed path, same header set as the runtime's own injected fetch (see
// this file's header comment) - X-User-Info-Name is the token's own `sub`
// claim, exactly as the runtime derives it, not a separately-sourced value.
// node:https (not the global fetch - see insecureAgent's own comment above)
// so the self-signed cert can actually be bypassed, scoped to only this
// request via `agent`.
function defaultDoRequest(url, { headers, signal }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const req = https.request(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: "GET", agent: insecureAgent, headers, signal },
      (res) => {
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
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function fetchInventory(token, quadronOrigin, instanceCode, signal, { doRequest = defaultDoRequest } = {}) {
  const url = `${quadronOrigin}/wes/inventory/dashboard/data`; // fixed path, never taken from the payload
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
    signal,
  });

  if (status === 401 || status === 403) {
    const err = new Error(`Quadron HTTP ${status}`);
    err.code = "UNAUTHORIZED"; // tells concinityAuth.withAuth() to invalidate the cached token and retry once
    throw err;
  }
  if (status < 200 || status >= 300) throw new Error(`Quadron HTTP ${status}`);

  const rows = normalizeRows(body);
  return { rows, rowCount: rows.length, fetchedAt: new Date().toISOString() };
}

// Called by capabilityManager.js's dispatchDirectly() exactly like a
// registry capability's own buildPayload/validateResult - params carries
// the same quadronOrigin/instanceCode the runtime path's buildPayload()
// already produces (see quadronInventory.js). appUserId is part of the
// uniform directExecute(appUserId, payload, signal) contract but is unused
// here: concinityAuth.js's login is now its own SHARED single account
// (2026-09-22), not a per-user credential.
async function execute(appUserId, params, signal, deps = {}) {
  const { quadronOrigin, instanceCode } = params || {};
  const concinityAuth = deps.concinityAuth || defaultConcinityAuth;
  return concinityAuth.withAuth((token) => fetchInventory(token, quadronOrigin, instanceCode, signal, deps), deps);
}

module.exports = { execute, normalizeRows, splitPartitionedToteId, decodeJwtSub, defaultDoRequest, insecureAgent };
