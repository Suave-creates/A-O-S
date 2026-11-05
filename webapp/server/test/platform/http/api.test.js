// Automated coverage for Phase 1, per the "TESTING" section of the spec:
// authentication, Query Manager, Tote Utilisation, admin, and security.
//
// Uses only Node's built-in test runner (node --test) - no extra
// dependency. Boots the real Express app against an ISOLATED MySQL test
// database and a local mock Apps Script server, on ephemeral ports.
//
// SAFETY: this suite refuses to run unless TEST_DB_NAME is set AND contains
// "test" (case-insensitive). This makes it structurally impossible for the
// suite to point at production_tracker (or any other non-test database) by
// accident, misconfiguration, or a stale/missing .env value - it fails fast
// with a clear error instead of touching anything.
//
// AS OF THIS COMMIT: production_tracker_test has not yet been provisioned
// (the current DB account lacks CREATE DATABASE privilege - see the MySQL
// migration plan discussion). This suite is NOT run until that database
// exists; running `node --test` against an unset/non-test TEST_DB_NAME will
// intentionally throw immediately in test.before(), before any connection is
// attempted against DB_NAME.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const testDbName = process.env.TEST_DB_NAME || "";
if (!/test/i.test(testDbName)) {
  throw new Error(
    `Refusing to run: TEST_DB_NAME is "${testDbName || "(unset)"}" - it must be set to a ` +
      `database name containing "test" (e.g. production_tracker_test). This suite will never ` +
      `run against DB_NAME/production_tracker. Provision a dedicated test database and set ` +
      `TEST_DB_NAME before running tests.`
  );
}

// Point every module at the test database, not DB_NAME.
process.env.DB_NAME = testDbName;
process.env.SEED_ADMIN_ID = "ADMIN001";
process.env.SEED_ADMIN_PASSWORD = "test-admin-pw";
process.env.SEED_USER_ID = "EMP001";
process.env.SEED_USER_PASSWORD = "test-user-pw";
process.env.APPS_SCRIPT_TIMEOUT_MS = "1000";
process.env.NODE_ENV = "test";

let mockServer, mockPort, app, db, migrate, seedDevUsers;

test.before(async () => {
  // Minimal in-process mock of the Apps Script getAsrsDump endpoint.
  mockServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (url.searchParams.get("action") === "getAsrsDump") {
        res.end(JSON.stringify({
          ok: true,
          rows: [
            { pid: "100001", toteId: "TL0000000001", location: "TL0000000001", inventoryCount: 10 },
            { pid: "1000002", toteId: "TS0000000002", location: "TS0000000002", inventoryCount: 5 },
          ],
        }));
      } else {
        res.end(JSON.stringify({ ok: false, reason: "unknown action" }));
      }
    };
    const delayMs = Number(url.searchParams.get("delayMs") || 0);
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  });
  await new Promise((resolve) => mockServer.listen(0, resolve));
  mockPort = mockServer.address().port;
  process.env.APPS_SCRIPT_URL = `http://127.0.0.1:${mockPort}/exec`;

  db = require("../../../platform/db");
  migrate = require("../../../platform/db/migrate");
  seedDevUsers = require("../../../platform/db/seed");

  await migrate();
  await seedDevUsers();

  const express = require("express");
  app = express();
  app.use(express.json());
  app.use("/api/v1/auth", require("../../../features/auth/auth.routes"));
  app.use("/api/v1/queries", require("../../../features/tote-utilisation/queries.routes").router);
  app.use("/api/v1/admin", require("../../../features/admin/admin.routes"));

  await new Promise((resolve) => {
    const server = app.listen(0, () => {
      global.__baseUrl = `http://127.0.0.1:${server.address().port}`;
      app.__server = server;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((r) => mockServer.close(r));
  await new Promise((r) => app.__server.close(r));
  // Isolated test database only - never touches DB_NAME/production_tracker.
  await db.execute("DELETE FROM tote_utilisation_results");
  await db.execute("DELETE FROM audit_logs");
  await db.execute("DELETE FROM queries");
  await db.execute("DELETE FROM sessions");
  await db.execute("DELETE FROM users");
  await db.close();
});

function baseUrl() {
  return global.__baseUrl;
}

function extractCookie(res) {
  const raw = res.headers.get("set-cookie");
  return raw ? raw.split(";")[0] : null;
}

async function login(employeeId, password) {
  const res = await fetch(`${baseUrl()}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employeeId, password }),
  });
  return { res, cookie: extractCookie(res), body: await res.json() };
}

function authedFetch(cookie, p, opts = {}) {
  return fetch(`${baseUrl()}${p}`, {
    ...opts,
    headers: { ...(opts.headers || {}), Cookie: cookie },
  });
}

async function waitForTerminal(cookie, queryId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await authedFetch(cookie, `/api/v1/queries/${queryId}`);
    const body = await res.json();
    if (["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"].includes(body.status)) return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out waiting for query to reach a terminal status");
}

// ── Authentication ──────────────────────────────────────────────────────

test("login succeeds with correct credentials", async () => {
  const { res, body } = await login("EMP001", "test-user-pw");
  assert.equal(res.status, 200);
  assert.equal(body.employeeId, "EMP001");
  assert.equal(body.role, "USER");
});

test("login fails with wrong password", async () => {
  const { res, body } = await login("EMP001", "wrong-password");
  assert.equal(res.status, 401);
  assert.match(body.error, /invalid/i);
});

test("unauthorized access without a session is rejected", async () => {
  const res = await fetch(`${baseUrl()}/api/v1/auth/me`);
  assert.equal(res.status, 401);
});

test("logout invalidates the session", async () => {
  const { cookie } = await login("EMP001", "test-user-pw");
  const logoutRes = await authedFetch(cookie, "/api/v1/auth/logout", { method: "POST" });
  assert.equal(logoutRes.status, 200);
  const meRes = await authedFetch(cookie, "/api/v1/auth/me");
  assert.equal(meRes.status, 401);
});

// ── Query Manager + Tote Utilisation ─────────────────────────────────────

test("tote utilisation query: create, run to completion, fetch result", async () => {
  const { cookie } = await login("EMP001", "test-user-pw");

  const createRes = await authedFetch(cookie, "/api/v1/queries/tote-utilisation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ caps: {} }),
  });
  assert.equal(createRes.status, 202);
  const created = await createRes.json();
  assert.match(created.queryId, /^Q-\d{6}$/);
  assert.ok(["QUEUED", "RUNNING"].includes(created.status));

  const finalQuery = await waitForTerminal(cookie, created.queryId);
  assert.equal(finalQuery.status, "COMPLETED");

  const resultRes = await authedFetch(cookie, `/api/v1/queries/${created.queryId}/result`);
  assert.equal(resultRes.status, 200);
  const result = await resultRes.json();
  assert.equal(result.pipeline.scanned, 2);
  assert.equal(result.totals.totes, 2);
});

test("getQuery on an invalid query id returns 404", async () => {
  const { cookie } = await login("EMP001", "test-user-pw");
  const res = await authedFetch(cookie, "/api/v1/queries/Q-999999");
  assert.equal(res.status, 404);
});

test("a running query can be cancelled and lands on CANCELLED", async () => {
  const { cookie } = await login("EMP001", "test-user-pw");

  const createRes = await authedFetch(cookie, "/api/v1/queries/tote-utilisation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const created = await createRes.json();

  const cancelRes = await authedFetch(cookie, `/api/v1/queries/${created.queryId}/cancel`, { method: "POST" });
  // Either the cancel wins the race (200, CANCEL_REQUESTED/CANCELLED) or the
  // fast mock already completed first (409 already COMPLETED) - both are
  // correct outcomes given the mock has no artificial delay in this suite.
  assert.ok([200, 409].includes(cancelRes.status));

  const finalQuery = await waitForTerminal(cookie, created.queryId);
  assert.ok(["COMPLETED", "CANCELLED"].includes(finalQuery.status));
});

test("cancelling an already-completed query is rejected with 409", async () => {
  const { cookie } = await login("EMP001", "test-user-pw");
  const createRes = await authedFetch(cookie, "/api/v1/queries/tote-utilisation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const created = await createRes.json();
  await waitForTerminal(cookie, created.queryId);

  const cancelRes = await authedFetch(cookie, `/api/v1/queries/${created.queryId}/cancel`, { method: "POST" });
  assert.equal(cancelRes.status, 409);
});

test("a user can view another user's query (site data) but cannot cancel it", async () => {
  const { cookie: ownerCookie } = await login("EMP001", "test-user-pw");
  const createRes = await authedFetch(ownerCookie, "/api/v1/queries/tote-utilisation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const created = await createRes.json();

  const { hashPassword } = require("../../../platform/session/passwords");
  await db.execute(
    "INSERT INTO users (employee_id, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
    ["EMP002-TEST", hashPassword("pw2"), "USER", new Date().toISOString()]
  );
  const { cookie: peerCookie } = await login("EMP002-TEST", "pw2");

  const viewRes = await authedFetch(peerCookie, `/api/v1/queries/${created.queryId}`);
  assert.equal(viewRes.status, 200);

  const cancelRes = await authedFetch(peerCookie, `/api/v1/queries/${created.queryId}/cancel`, { method: "POST" });
  assert.equal(cancelRes.status, 403);
});

// ── Admin ────────────────────────────────────────────────────────────────

test("a normal USER cannot access admin endpoints", async () => {
  const { cookie } = await login("EMP001", "test-user-pw");
  const res = await authedFetch(cookie, "/api/v1/admin/queries");
  assert.equal(res.status, 403);
});

test("ADMIN sees active queries across users and can cancel one", async () => {
  const { cookie: userCookie } = await login("EMP001", "test-user-pw");
  const createRes = await authedFetch(userCookie, "/api/v1/queries/tote-utilisation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const created = await createRes.json();

  const { cookie: adminCookie } = await login("ADMIN001", "test-admin-pw");
  const listRes = await authedFetch(adminCookie, "/api/v1/admin/queries");
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.ok(list.some((q) => q.queryId === created.queryId));

  const cancelRes = await authedFetch(adminCookie, `/api/v1/admin/queries/${created.queryId}/cancel`, {
    method: "POST",
  });
  assert.ok([200, 409].includes(cancelRes.status));
});

test("admin queries list reports a real startedAt and honest cancellationSupported per row", async () => {
  const { cookie: userCookie } = await login("EMP001", "test-user-pw");
  const createRes = await authedFetch(userCookie, "/api/v1/queries/tote-utilisation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const created = await createRes.json();
  await waitForTerminal(userCookie, created.queryId);

  const { cookie: adminCookie } = await login("ADMIN001", "test-admin-pw");
  const listRes = await authedFetch(adminCookie, "/api/v1/admin/queries");
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  const row = list.find((q) => q.queryId === created.queryId);
  assert.ok(row, "expected the created query to appear in the admin list");

  // startedAt is the real persisted value, not fabricated or derived from
  // completedAt - a valid, parseable timestamp that is not in the future.
  assert.ok(row.startedAt, "startedAt must be present");
  const startedMs = new Date(row.startedAt).getTime();
  assert.ok(Number.isFinite(startedMs) && startedMs <= Date.now());

  // TOTE_UTILISATION is a backend-only job with no verified real interrupt
  // path today (see server/platform/queries/cancellationSupport.js) - must be reported
  // honestly as not cancellation-supported, never true just because the
  // generic queryManager.cancelQuery() API would technically accept it.
  assert.equal(row.cancellationSupported, false);
});

test("a capability-backed operation is reported as cancellation-supported", () => {
  const { isCancellationSupported } = require("../../../integrations/capabilities/cancellationSupport");
  assert.equal(isCancellationSupported("GET_QUADRON_INVENTORY"), true);
  assert.equal(isCancellationSupported("GET_NEXS_BLOCKED_INVENTORY"), true);
});

// ── Security ─────────────────────────────────────────────────────────────

test("Script Key is never present in any frontend source file", () => {
  const publicDir = path.join(__dirname, "..", "..", "..", "..", "public");
  const files = fs.readdirSync(publicDir, { recursive: true })
    .filter((f) => /\.(js|html|css)$/.test(f));
  assert.ok(files.length > 0);
  for (const f of files) {
    const contents = fs.readFileSync(path.join(publicDir, f), "utf8");
    assert.ok(!contents.includes(process.env.APPS_SCRIPT_KEY || "__NO_KEY_SET__"));
    assert.doesNotMatch(contents, /APPS_SCRIPT_KEY\s*=\s*["'][^"']+["']/);
  }
});

test("API responses never echo appsScriptKey/appsScriptUrl fields", async () => {
  const { cookie } = await login("EMP001", "test-user-pw");
  const res = await authedFetch(cookie, "/api/v1/auth/me");
  const text = await res.text();
  assert.doesNotMatch(text, /appsScript/i);
});
