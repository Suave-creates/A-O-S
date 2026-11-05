// Dev-only convenience: creates the two Phase 1 demo accounts the FIRST time
// the `users` table is empty. Deliberately separate from migrate.js (which
// only ever manages schema) and deliberately gated off in production - this
// must never run unattended against a real company deployment.

const config = require("../../config");
const db = require("./index");
const { hashPassword } = require("../session/passwords");

async function seedDevUsers() {
  if (config.isProduction) {
    console.log("[seed] NODE_ENV=production - skipping dev user seeding.");
    return;
  }

  const rows = await db.query("SELECT COUNT(*) AS n FROM users");
  if (rows[0].n > 0) return;

  await db.execute(
    "INSERT INTO users (employee_id, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
    [config.seedAdminId, hashPassword(config.seedAdminPassword), "ADMIN", new Date().toISOString()]
  );
  await db.execute(
    "INSERT INTO users (employee_id, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
    [config.seedUserId, hashPassword(config.seedUserPassword), "USER", new Date().toISOString()]
  );

  console.warn(
    `[seed] Created dev users ${config.seedAdminId} (ADMIN) and ${config.seedUserId} (USER). ` +
      `These use dev-only passwords from .env - change them before any real/shared use.`
  );
}

module.exports = seedDevUsers;
