// Feeds that need a user for Query Manager attribution / capability role
// checks run as the first ADMIN (same convention as the NexS dump
// auto-refresh in index.js - there is no service account in this app).

const db = require("../platform/db");

const TTL_MS = 5 * 60 * 1000;
let user = null;
let at = 0;

async function getSystemUser() {
  if (user && Date.now() - at < TTL_MS) return user;
  const rows = await db.query("SELECT id, role FROM users WHERE role = 'ADMIN' AND deleted_at IS NULL ORDER BY id LIMIT 1");
  if (!rows[0]) throw new Error("no ADMIN user exists to attribute live refreshes to");
  user = rows[0];
  at = Date.now();
  return user;
}

module.exports = { getSystemUser };
