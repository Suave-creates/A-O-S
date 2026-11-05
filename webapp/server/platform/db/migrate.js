// Versioned migration runner for MySQL. Applies only pending files from
// server/platform/db/migrations/*.sql, in numeric order, tracked in a
// `schema_migrations` table. Safe to run repeatedly - already-applied
// versions are never re-run. The same files and this same runner are used
// on the laptop and on the company server; only DB_HOST/DB_NAME/DB_USER/
// DB_PASSWORD (env vars) differ between them.
//
// DDL statements (CREATE TABLE etc.) auto-commit in MySQL/InnoDB regardless
// of any transaction wrapper - true rollback of a partially-applied file is
// not possible. If a file fails partway through, this runner stops
// immediately, does NOT record that version as applied, and surfaces the
// exact error + which file/statement failed, so the state is inspectable
// rather than silently retried or "fixed."

const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");
const config = require("../../config");
const db = require("./index");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

// Final safety check (per explicit requirement): confirm the connection we
// are about to run DDL through is actually pointed at the database named in
// DB_NAME - not some other database on the same server.
async function verifyTargetDatabase() {
  const rows = await db.query("SELECT DATABASE() AS db");
  const actual = rows[0] && rows[0].db;
  if (!actual) {
    throw new Error("Could not determine the current database (SELECT DATABASE() returned NULL).");
  }
  if (actual !== config.dbName) {
    throw new Error(
      `Refusing to migrate: connection resolved to database "${actual}" but DB_NAME is configured as "${config.dbName}". Aborting without running any migration.`
    );
  }
  return actual;
}

async function ensureMigrationsTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INT UNSIGNED PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      applied_at  VARCHAR(32) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function appliedVersions() {
  const rows = await db.query("SELECT version FROM schema_migrations");
  return new Set(rows.map((r) => r.version));
}

async function applyMigrationFile(file) {
  const version = parseInt(file, 10);
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");

  // multipleStatements is needed only here (a migration file may contain
  // several CREATE TABLE statements) and only on this dedicated,
  // short-lived connection - never on the shared app pool used by routes.
  const conn = await mysql.createConnection({
    host: config.dbHost,
    port: config.dbPort,
    user: config.dbUser,
    password: config.dbPassword,
    database: config.dbName,
    ssl: config.dbSsl ? {} : undefined,
    multipleStatements: true,
  });

  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }

  await db.execute(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    [version, file, new Date().toISOString()]
  );
}

// Applies every pending migration. Returns { verifiedDatabase, applied: [...] }.
// Throws immediately (without recording anything) on the first failure.
async function migrate() {
  const verifiedDatabase = await verifyTargetDatabase();
  await ensureMigrationsTable();

  const applied = await appliedVersions();
  const files = listMigrationFiles();
  const pending = files.filter((f) => !applied.has(parseInt(f, 10)));

  if (pending.length === 0) {
    console.log(`[migrate] "${verifiedDatabase}" is up to date - no pending migrations.`);
    return { verifiedDatabase, applied: [] };
  }

  const appliedNow = [];
  for (const file of pending) {
    console.log(`[migrate] Applying ${file} to "${verifiedDatabase}"...`);
    try {
      await applyMigrationFile(file);
    } catch (e) {
      console.error(`[migrate] FAILED applying ${file}: ${e.message}`);
      console.error(
        `[migrate] Stopping. Versions applied so far this run: ${appliedNow.join(", ") || "(none)"}. ` +
          `Do not attempt automatic recovery - inspect schema_migrations and the database state before retrying.`
      );
      throw e;
    }
    appliedNow.push(file);
    console.log(`[migrate] Applied ${file}.`);
  }

  return { verifiedDatabase, applied: appliedNow };
}

module.exports = migrate;
