// Local stand-in for the real, already-deployed Google Apps Script web app -
// FOR OFFLINE DEVELOPMENT/TESTING ONLY. It is never used in production; the
// real backend always talks to the actual Apps Script URL configured in
// .env. This exists so Phase 1 can be exercised end-to-end (including
// exercising the TIMEOUT and CANCELLED paths) without live ASRS network
// access or a real Script Key.
//
// Run with: npm run dev:mock-apps-script
// Then point .env's APPS_SCRIPT_URL at http://127.0.0.1:5055/exec

const http = require("node:http");

const PORT = process.env.MOCK_PORT || 5055;
const SECRET = process.env.MOCK_SCRIPT_KEY || ""; // leave blank to match the real script's current no-op auth
// Applied to every response unless a request overrides it with ?delayMs=.
// Set this to something larger than APPS_SCRIPT_TIMEOUT_MS to test the
// TIMEOUT status, or larger than a few seconds to have time to manually
// trigger a cancel while the query is RUNNING.
const DEFAULT_DELAY_MS = Number(process.env.MOCK_DELAY_MS || 0);

function sampleRows() {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const large = i % 3 === 0;
    const toteId = (large ? "TL" : "TS") + String(1000000000 + i).slice(-10);
    const pid = i % 2 === 0 ? 100000 + i : 1000000 + i; // alternate Frame (<=999999) / Lens (>999999)
    rows.push({ pid: String(pid), toteId, location: toteId, inventoryCount: 5 + (i % 20) });
  }
  return rows;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action");
  const secret = url.searchParams.get("secret") || "";
  const delayMs = url.searchParams.has("delayMs")
    ? Number(url.searchParams.get("delayMs"))
    : DEFAULT_DELAY_MS;

  if (SECRET && secret !== SECRET) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, reason: "Unauthorised" }));
  }

  const send = () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (action === "getAsrsDump") {
      res.end(JSON.stringify({ ok: true, rows: sampleRows(), generatedAt: new Date().toISOString() }));
    } else if (action === "ping") {
      res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    } else {
      res.end(JSON.stringify({ ok: false, reason: "Unknown action: " + action }));
    }
  };

  // ?delayMs=N lets you manually test cancellation/timeout against a slow
  // response without touching any real system.
  if (delayMs > 0) setTimeout(send, delayMs);
  else send();
});

server.listen(PORT, () => {
  console.log(`[mock-apps-script] listening on http://127.0.0.1:${PORT}/exec`);
});
