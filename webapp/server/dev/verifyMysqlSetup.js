// Read-only pre-flight check for the SQLite -> MySQL migration.
//
// Runs ONLY SELECT / SHOW / information_schema queries - no CREATE, ALTER,
// DROP, or TRUNCATE. Never prints DB_PASSWORD (or any env var value that
// wasn't explicitly whitelisted below). Safe to run against the real
// production_tracker database as many times as needed while we're still at
// the verification stage.
//
// Usage: node --env-file=.env server/dev/verifyMysqlSetup.js

const mysql = require("mysql2/promise");

async function main() {
  const required = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("Missing required env vars:", missing.join(", "));
    console.error("Add real values to webapp/.env (not in chat) and re-run.");
    process.exitCode = 1;
    return;
  }

  const useSsl = String(process.env.DB_SSL || "false").toLowerCase() === "true";

  console.log(`Connecting to ${process.env.DB_HOST}:${process.env.DB_PORT} as "${process.env.DB_USER}" (ssl=${useSsl})...`);

  let conn;
  try {
    conn = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: useSsl ? {} : undefined,
      connectTimeout: 10000,
    });
  } catch (e) {
    console.error("CONNECTION FAILED:", e.message);
    process.exitCode = 1;
    return;
  }

  try {
    console.log("Connected OK.\n");

    const [[identity]] = await conn.query(
      "SELECT DATABASE() AS db, CURRENT_USER() AS whoami, VERSION() AS version"
    );
    console.log("── Identity ─────────────────────────────────────────────");
    console.log("  Resolved database :", identity.db);
    console.log("  Connected as      :", identity.whoami);
    console.log("  MySQL version     :", identity.version);

    if (identity.db !== process.env.DB_NAME) {
      console.log(`  ⚠ WARNING: connection resolved to "${identity.db}", expected "${process.env.DB_NAME}"`);
    } else {
      console.log(`  ✓ Confirmed connected to the intended database ("${process.env.DB_NAME}")`);
    }

    const [tables] = await conn.query("SHOW TABLES");
    console.log("\n── Contents of the target database ──────────────────────");
    if (tables.length === 0) {
      console.log(`  ✓ '${identity.db}' is empty - 0 tables/objects found.`);
    } else {
      console.log(`  ⚠ '${identity.db}' is NOT empty - ${tables.length} table(s) found:`);
      tables.forEach((row) => console.log("     -", Object.values(row)[0]));
      console.log("  Nothing has been modified. Report this before proceeding.");
    }

    const [grantRows] = await conn.query("SHOW GRANTS FOR CURRENT_USER()");
    const grants = grantRows.map((r) => Object.values(r)[0]);
    console.log("\n── Grants for current user ───────────────────────────────");
    grants.forEach((g) => console.log("  -", g));

    const canCreate = grants.some((g) => /\bALL PRIVILEGES\b/i.test(g) || /\bCREATE\b/i.test(g));
    const canAlter = grants.some((g) => /\bALL PRIVILEGES\b/i.test(g) || /\bALTER\b/i.test(g));
    const canIndex = grants.some((g) => /\bALL PRIVILEGES\b/i.test(g) || /\bINDEX\b/i.test(g));
    const canReferences = grants.some((g) => /\bALL PRIVILEGES\b/i.test(g) || /\bREFERENCES\b/i.test(g));
    const canCreateDb = grants.some((g) => /\bALL PRIVILEGES\b.*ON \*\.\*/i.test(g) || /\bCREATE\b.*ON \*\.\*/i.test(g));

    console.log("\n── Inferred capability for the planned migration ────────");
    console.log("  CREATE TABLE      :", canCreate ? "likely yes" : "UNCONFIRMED - review grants above");
    console.log("  ALTER TABLE       :", canAlter ? "likely yes" : "UNCONFIRMED - review grants above");
    console.log("  CREATE INDEX      :", canIndex ? "likely yes" : "UNCONFIRMED - review grants above");
    console.log("  FOREIGN KEY (REFERENCES):", canReferences ? "likely yes" : "UNCONFIRMED - review grants above");
    console.log("  CREATE DATABASE (global):", canCreateDb ? "likely yes" : "no global CREATE seen - may still be able to create schema-scoped objects only");

    const testDbName = process.env.TEST_DB_NAME || `${process.env.DB_NAME}_test`;
    const [existing] = await conn.query(
      "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
      [testDbName]
    );
    console.log(`\n── Test database ("${testDbName}") ─────────────────────`);
    console.log(existing.length > 0 ? "  Already exists." : "  Does not exist yet.");
    console.log(
      canCreateDb
        ? "  Current user appears to have global CREATE - creating it should be possible."
        : "  Current user does NOT appear to have global CREATE - creating a new database may require the DBA to provision it, or a schema-scoped grant already covering this name."
    );
  } finally {
    await conn.end();
  }
}

main();
