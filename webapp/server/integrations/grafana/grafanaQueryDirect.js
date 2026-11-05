// Direct-login pilot (2026-09-05) - shared server-side plumbing for running
// ONE Grafana MSSQL query when config.grafanaAuthMode === "direct", instead
// of relaying through the ASO Browser Runtime. Every Grafana capability
// (GET_GRAFANA_LOCKED_TOTES, _SUPERVISOR_DUMP, _CC_METRICS, ...) already
// POSTs the exact same shape to the exact same endpoint - only the SQL/
// datasource (baked into each capability's own buildPayload()) and the
// response row-shaping differ - so this module owns only the shared part:
// building the request body, attaching the session cookie, POSTing, and
// handing back Grafana's raw response for each capability's own
// *Direct.js to shape (mirrors quadronInventoryDirect.js's own split
// between "talk to the service" and "shape the rows").
//
// Ported field-for-field from the runtime's own already-verified
// buildGrafanaRequestBody()/executeGetGrafanaLockedTotes() (runtime/
// background/capabilities.js) - same URL, same body shape, same headers.
// The only thing that actually changes is where the session comes from:
// grafanaAuth.js's own stored-credential login instead of the browser's
// own `credentials:"include"` cookie jar.

const https = require("node:https");
const defaultGrafanaAuth = require("../logins/grafanaAuth");
const config = require("../../config");

// ── Reliability: bounded concurrency + retry of transient failures ─────────
// A dashboard refresh fans out into dozens of MSSQL queries (24 hourly counts
// x several metrics). Unbounded, that overloads Grafana and shows up as random
// "Data unavailable". So: (1) at most N queries in flight process-wide (the
// rest wait their turn), and (2) a transient failure (network reset, timeout,
// HTTP 429/5xx, a SQL-side error) is retried a couple of times with backoff
// before the section is allowed to fail.
const MAX_CONCURRENCY = Math.max(1, Number(config.grafanaMaxConcurrency) || 6);
const RETRIES = 2;
const BACKOFF_MS = [400, 1200];
let active = 0;
const waiting = [];

function acquireSlot(signal) {
  return new Promise((resolve, reject) => {
    const grant = () => { active += 1; resolve(); };
    if (active < MAX_CONCURRENCY) return grant();
    const entry = { grant, reject };
    waiting.push(entry);
    if (signal) {
      signal.addEventListener("abort", () => {
        const i = waiting.indexOf(entry);
        if (i >= 0) { waiting.splice(i, 1); reject(signal.reason || Object.assign(new Error("Aborted"), { name: "AbortError" })); }
      }, { once: true });
    }
  });
}
function releaseSlot() {
  active -= 1;
  const next = waiting.shift();
  if (next) next.grant();
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "ENOTFOUND", "UND_ERR_SOCKET"]);
function isTransient(e) {
  if (!e || e.name === "AbortError" || e.name === "TimeoutError") return false; // cancellation/timeout is the caller's decision
  if (e.code === "UNAUTHORIZED") return false; // grafanaAuth.withAuth() owns the one re-login retry
  if (e.code && TRANSIENT_CODES.has(e.code)) return true;
  if (e.cause && e.cause.code && TRANSIENT_CODES.has(e.cause.code)) return true;
  if (/socket hang up|other side closed/i.test(String(e.message))) return true;
  if (e.grafanaTransient) return true;
  return /Grafana HTTP (429|5\d\d)(?!\d)/.test(String(e.message));
}
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withReliability(fn, signal, deps = {}) {
  const sleep = deps.sleep || defaultSleep;
  await acquireSlot(signal);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= RETRIES || !isTransient(e)) throw e;
        await sleep(BACKOFF_MS[attempt] + Math.floor(Math.random() * 200));
      }
    }
  } finally {
    releaseSlot();
  }
}

// Same self-signed-cert host as Concinity/Quadron (192.168.24.230) - see
// concinityAuth.js's/quadronInventoryDirect.js's own identical comment.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// Mirrors buildGrafanaRequestBody() in runtime/background/capabilities.js
// exactly (same field names, same intervalMs/maxDataPoints, same range
// shape).
function buildGrafanaRequestBody(datasourceUid, datasourceType, datasourceId, rawSql, fromMs, toMs) {
  return {
    queries: [
      {
        refId: "A",
        datasource: { type: datasourceType, uid: datasourceUid },
        rawSql,
        format: "table",
        datasourceId,
        intervalMs: 60000,
        maxDataPoints: 636,
      },
    ],
    range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), raw: { from: "now-6h", to: "now" } },
    from: String(fromMs),
    to: String(toMs),
  };
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
            /* non-JSON response - parsed stays null, caller handles it */
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

// payload is exactly what a Grafana capability's own buildPayload(grafanaOrigin)
// already produces: {grafanaOrigin, datasourceUid, datasourceType, datasourceId,
// rawSql, fromMs, toMs}. Returns Grafana's raw response body (the caller's
// own *Direct.js shapes it into {rows,...} - this module never assumes a
// particular SQL result shape). Login is grafanaAuth.js's own SHARED
// single account (2026-09-22) - no longer per-caller, so there is no
// appUserId parameter here anymore.
async function runQuery(payload, signal, deps = {}) {
  const { grafanaOrigin, datasourceUid, datasourceType, datasourceId, rawSql, fromMs, toMs } = payload || {};
  const grafanaAuth = deps.grafanaAuth || defaultGrafanaAuth;
  const doRequest = deps.doRequest || defaultDoRequest;

  return withReliability(() => grafanaAuth.withAuth(
    async (sessionCookie) => {
      const url = `${grafanaOrigin}/grafana/api/ds/query`; // fixed path, never taken from the payload
      const bodyStr = JSON.stringify(buildGrafanaRequestBody(datasourceUid, datasourceType, datasourceId, rawSql, fromMs, toMs));
      const { status, body } = await doRequest(url, {
        headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: sessionCookie },
        body: bodyStr,
        signal,
      });

      if (status === 401) {
        const err = new Error("Grafana session expired or not logged in");
        err.code = "UNAUTHORIZED"; // tells grafanaAuth.withAuth() to invalidate the cached session and retry once
        throw err;
      }
      if (status < 200 || status >= 300) throw new Error(`Grafana HTTP ${status}`);
      // Grafana answers HTTP 200 even when the SQL itself failed (deadlock,
      // timeout, bad SQL) - the failure is inside results.A. Treating that as
      // "no rows" would silently show zeros, so it is surfaced (and retried,
      // since these are usually transient).
      const inner = body && body.results && body.results.A;
      if (inner && (inner.error || (typeof inner.status === "number" && inner.status >= 400))) {
        const err = new Error(`Grafana query error: ${String(inner.error || `status ${inner.status}`).slice(0, 200)}`);
        err.grafanaTransient = true;
        throw err;
      }
      return body;
    },
    deps
  ), signal, deps);
}

// Zips the first frame of refId "A" into row objects keyed by each column's own
// schema field NAME (never a hardcoded index) - SELECT * style queries must not
// depend on column order.
function frameRowsByName(data) {
  const f = data && data.results && data.results.A && data.results.A.frames && data.results.A.frames[0];
  if (!f || !f.schema || !Array.isArray(f.schema.fields)) return [];
  const names = f.schema.fields.map((x) => x.name);
  const cols = (f.data && f.data.values) || [];
  const n = (cols[0] || []).length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = {};
    names.forEach((nm, ci) => (o[nm] = cols[ci] ? cols[ci][i] : undefined));
    out.push(o);
  }
  return out;
}

// runQuery + frameRowsByName in one call - what every multi-query capability
// (CC metrics, per-shift/per-hour scalars, ...) actually wants.
async function runQueryRows(payload, signal, deps = {}) {
  return frameRowsByName(await runQuery(payload, signal, deps));
}

module.exports = { runQuery, runQueryRows, frameRowsByName, buildGrafanaRequestBody, withReliability, isTransient };
