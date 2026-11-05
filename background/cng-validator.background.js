// ═══════════════════════════════════════════════════════════════════════════
// CNG Inv Validator — merged background logic (was: standalone extension's
// background.js). Loaded into the ASO Test service worker via importScripts()
// from index.js, so everything here shares that worker's global scope.
//
// Rev. 2 — the original standalone extension captured Quadron/Grafana auth
// itself, by sniffing request headers via chrome.webRequest and requiring an
// open, logged-in tab for every fetch. ASO Test already solves this more
// simply elsewhere in index.js:
//   - getJWT(host)            — reads the Quadron JWT straight out of cookies
//                                (falls back to an open tab only if needed)
//   - getGrafanaSession(host) — reads the grafana_session cookie directly
//   - callGrafanaDS/buildGrafanaBody — SW fetch first, tab-relay fallback
//   - fetchInventoryDashboard — the exact Quadron dump endpoint this tab needs,
//                                already using the pattern above
// This revision drops the duplicate sniffer/storage/hard-tab-requirement and
// calls into those existing functions instead, so auth here now matches
// "auto auth" behaviour used by every other tab (Manual/Auto/Purge/Tracker/
// Cycle Count) — no separate login step, no dependency on chrome.webRequest.
//
// Also removed on merge: its own `chrome.action.onClicked` listener (ASO
// Test's own click handler already opens ui/app.html) and its own standalone
// `chrome.runtime.onMessage` listener for "AUTH_STATUS" (ASO Test's single
// onMessage listener always responds for every message type, including a
// catch-all for unrecognized ones — a second independent listener would race
// it and could lose). Rev. 3 dropped AUTH_STATUS entirely — this tab no
// longer shows its own auth chips; it relies on the app's existing header
// indicators (#authStatus for Quadron, #grafanaStatusPill for Grafana),
// which already reflect the same getJWT()/getGrafanaSession() checks.
// ═══════════════════════════════════════════════════════════════════════════

const CNG_NEXS_REPORT = () => NEXS_BASE + "/nexs/api/ims/fetchDiscrepancyReport";

// ---- Helpers ------------------------------------------------------------
function cngSplitTote(id) {
  // "TS0000018492-6" -> { base:"TS0000018492", part:6 }
  const i = String(id).lastIndexOf("-");
  if (i < 0) return { base: String(id), part: null };
  const part = parseInt(id.slice(i + 1), 10);
  return { base: id.slice(0, i), part: Number.isNaN(part) ? null : part };
}
const cngSanitize = (b) => String(b).replace(/[^A-Za-z0-9]/g, "");

// ---- Quadron: full dump via the existing dashboard fetcher ---------------
// fetchInventoryDashboard already does cookie-JWT auth + SW-fetch-first /
// tab-fallback (see index.js) — this just indexes its result the way the
// validator needs (base -> { part -> { qty, sku } }).
function cngIndexQuadronRows(json) {
  const rows = Array.isArray(json) ? json : (json.content || json.data || json.rows || json.items || []);
  const map = new Map();
  for (const r of rows) {
    const { base, part } = cngSplitTote(r.toteId);
    const md = (r.materialDetails && r.materialDetails[0]) || {};
    if (!map.has(base)) map.set(base, {});
    map.get(base)[part] = { qty: md.quantity ?? 0, sku: md.sku ?? null };
  }
  return { map, rowCount: rows.length };
}

// ---- Grafana: batched SQL, via the existing callGrafanaDS/buildGrafanaBody
async function cngFetchGrafanaBatch(host, bases) {
  const cleaned = bases.map(cngSanitize).filter(Boolean);
  if (!cleaned.length) return {};
  const likeClause = cleaned.map((b) => `container like '${b}-%'`).join(" or ");
  const sql =
    `use lenskart_wes\n\n` +
    `select container, count(*) as qty from tote_details ` +
    `where ${likeClause} group by container`;

  const now = Date.now();
  const body = buildGrafanaBody("rerQ11pVk", "mssql", 1, sql, now - 6 * 3600 * 1000, now);
  const json = await callGrafanaDS(host, body);

  const frame = json?.results?.A?.frames?.[0];
  const out = {}; // base -> { part -> count }
  if (!frame) return out;
  const names = frame.schema.fields.map((f) => f.name);
  const ci = names.indexOf("container");
  const qi = names.indexOf("qty");
  const containers = frame.data.values[ci] || [];
  const qtys = frame.data.values[qi] || [];
  for (let i = 0; i < containers.length; i++) {
    const { base, part } = cngSplitTote(containers[i]);
    if (!out[base]) out[base] = {};
    out[base][part] = qtys[i];
  }
  return out;
}

// ---- Nexs: per-partition imsCount — SW fetch (cookies) first, tab-relay
//      fallback, same shape as fetchBlockedInv above for the Purge tab.
async function cngFetchNexsPartition(facility, base, part) {
  const loc = `${facility}-ASRS-${base}_PR${part}`;
  const url =
    `${CNG_NEXS_REPORT()}?page=0&sortBy=barcode&facility=${facility}` +
    `&listType=all&location=${encodeURIComponent(loc)}` +
    `&sortOrder=DESC&size=1&totalCountRequired=true`;
  const headers = {
    accept: "application/json, text/plain, */*",
    "facility-code": facility,
    "source-domain": NEXS_BASE
  };
  try {
    const r = await fetch(url, { method: "GET", headers, credentials: "include" });
    if (r.ok) { const j = await r.json(); return j?.data?.imsCount ?? null; }
  } catch (e) { /* fall through to tab relay */ }
  try {
    const tabs = await chrome.tabs.query({ url: `${NEXS_BASE}/*` });
    if (tabs && tabs.length) {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        world: "MAIN",
        args: [url, headers],
        func: async (url, headers) => {
          try {
            const r = await fetch(url, { method: "GET", headers, credentials: "include" });
            if (!r.ok) return { __err: "HTTP " + r.status };
            return await r.json();
          } catch (e) { return { __err: e.message || String(e) }; }
        }
      });
      const j = res && res[0] && res[0].result;
      if (j && !j.__err) return j?.data?.imsCount ?? null;
    }
  } catch (e) { /* no open Nexs tab either — leave as missing */ }
  return null;
}

async function cngRunPool(tasks, size, onTick) {
  const results = new Array(tasks.length);
  let idx = 0;
  let done = 0;
  async function worker() {
    while (idx < tasks.length) {
      const my = idx++;
      try {
        results[my] = await tasks[my]();
      } catch (e) {
        results[my] = { __error: String(e.message || e) };
      }
      done++;
      if (onTick) onTick(done, tasks.length);
    }
  }
  const workers = Array.from({ length: Math.min(size, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ---- Orchestration -------------------------------------------------------
async function cngRunValidation(port, { totes, facility, grafanaChunk }) {
  const post = port._safePost || ((m) => port.postMessage(m));
  const cfg = await getConfig();
  const host = cfg.grafanaUrl || cfg.host || DEFAULTS.HOST;

  // 1) Quadron (single call, indexed) — same auth path as every other tab,
  //    no precondition on having a tab open.
  post({ type: "progress", phase: "quadron", msg: "Fetching Quadron inventory…", pct: 5 });
  const inv = await fetchInventoryDashboard(host, cfg.instanceCode);
  if (!inv.ok) {
    post({ type: "error", msg: "Quadron fetch failed: " + (inv.reason || "unknown error") });
    return;
  }
  const quadron = cngIndexQuadronRows(inv.data);
  post({ type: "progress", phase: "quadron", msg: `Quadron indexed (${quadron.rowCount} partitions).`, pct: 25 });

  // 2) Grafana (batched per chunk)
  post({ type: "progress", phase: "grafana", msg: "Querying Grafana (batched)…", pct: 30 });
  const grafana = {}; // base -> { part -> count }
  const chunkSize = grafanaChunk || 40;
  for (let i = 0; i < totes.length; i += chunkSize) {
    const slice = totes.slice(i, i + chunkSize);
    try {
      const part = await cngFetchGrafanaBatch(host, slice);
      Object.assign(grafana, part);
    } catch (e) {
      post({ type: "warn", msg: "Grafana chunk failed: " + (e.message || e) });
    }
    post({
      type: "progress",
      phase: "grafana",
      msg: `Grafana ${Math.min(i + chunkSize, totes.length)}/${totes.length}…`,
      pct: 30 + Math.round(25 * Math.min(i + chunkSize, totes.length) / totes.length)
    });
  }

  // 3) Determine partition set per tote (union of Quadron + Grafana)
  const partitionsFor = (base) => {
    const set = new Set();
    const q = quadron.map.get(base);
    if (q) Object.keys(q).forEach((p) => set.add(Number(p)));
    if (grafana[base]) Object.keys(grafana[base]).forEach((p) => set.add(Number(p)));
    return [...set].filter((p) => !Number.isNaN(p)).sort((a, b) => a - b);
  };

  // 4) Nexs (per partition, pooled)
  const nexsTasks = [];
  const taskMeta = [];
  for (const base of totes) {
    for (const part of partitionsFor(base)) {
      taskMeta.push({ base, part });
      nexsTasks.push(() => cngFetchNexsPartition(facility, base, part));
    }
  }
  post({ type: "progress", phase: "nexs", msg: `Querying Nexs (${nexsTasks.length} partitions)…`, pct: 55 });
  const nexsResults = await cngRunPool(nexsTasks, 6, (done, total) => {
    post({
      type: "progress",
      phase: "nexs",
      msg: `Nexs ${done}/${total} partitions…`,
      pct: 55 + Math.round(40 * done / total)
    });
  });

  // base -> { part -> imsCount }
  const nexs = {};
  taskMeta.forEach((m, i) => {
    if (!nexs[m.base]) nexs[m.base] = {};
    const v = nexsResults[i];
    nexs[m.base][m.part] = v && v.__error ? null : v;
  });

  // 5) Reconcile
  post({ type: "progress", phase: "reconcile", msg: "Reconciling…", pct: 98 });
  const rows = totes.map((base) => {
    const parts = partitionsFor(base);
    const partRows = parts.map((p) => {
      const q = quadron.map.get(base)?.[p]?.qty ?? null;
      const g = grafana[base]?.[p] ?? null;
      const n = nexs[base]?.[p] ?? null;
      return { part: p, quadron: q, nexs: n, grafana: g, match: cngAllEqual([q, n, g]) };
    });
    const sum = (arr, k) => {
      const vals = arr.map((r) => r[k]).filter((v) => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };
    const qT = sum(partRows, "quadron");
    const nT = sum(partRows, "nexs");
    const gT = sum(partRows, "grafana");
    return {
      base,
      quadron: qT,
      nexs: nT,
      grafana: gT,
      verdict: cngVerdictOf([qT, nT, gT]),
      partitions: partRows
    };
  });

  post({ type: "done", rows });
}

function cngAllEqual(vals) {
  const present = vals.filter((v) => v != null);
  if (present.length < 2) return null; // not enough to compare
  return present.every((v) => v === present[0]);
}
function cngVerdictOf(vals) {
  const present = vals.filter((v) => v != null);
  if (present.length === 0) return "MISSING";
  if (present.length < 3) return "PARTIAL";
  return present.every((v) => v === present[0]) ? "MATCH" : "MISMATCH";
}

// ---- Messaging: "validator" port (independent of onMessage, no conflict) -
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "validator") return;
  let alive = true;
  port.onDisconnect.addListener(() => { alive = false; });

  // Never let a disconnected port throw an uncaught error.
  const safePost = (m) => {
    if (!alive) return;
    try { port.postMessage(m); } catch (_) { alive = false; }
  };
  port._safePost = safePost; // cngRunValidation posts through this

  port.onMessage.addListener((msg) => {
    if (msg.type === "RUN") {
      // Keep the worker alive across long network waits (Chrome kills idle SWs).
      const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
      cngRunValidation(port, msg)
        .catch((e) => {
          console.error("[cng-validator] runValidation failed:", e);
          safePost({ type: "error", msg: "Run failed: " + String((e && (e.stack || e.message)) || e) });
        })
        .finally(() => clearInterval(keepAlive));
    }
  });
});
