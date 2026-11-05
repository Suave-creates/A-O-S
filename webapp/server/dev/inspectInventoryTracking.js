// Read-only SCHEMA/METADATA-ONLY inspection of the pre-existing
// `inventory_tracking` table found in production_tracker. Deliberately reads
// no row data whatsoever (no SELECT * / SELECT col ... / COUNT(*)) - only
// SHOW CREATE TABLE and information_schema metadata. No CREATE/ALTER/DROP/
// INSERT/UPDATE/DELETE. Never prints credentials.
//
// Usage: node --env-file=.env server/dev/inspectInventoryTracking.js

const mysql = require("mysql2/promise");

const TABLE = "inventory_tracking";

async function main() {
  const required = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("Missing required env vars:", missing.join(", "));
    process.exitCode = 1;
    return;
  }

  const useSsl = String(process.env.DB_SSL || "false").toLowerCase() === "true";
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: useSsl ? {} : undefined,
    connectTimeout: 10000,
  });

  try {
    const schema = process.env.DB_NAME;

    console.log(`── SHOW CREATE TABLE ${TABLE} ────────────────────────────`);
    const [createRows] = await conn.query(`SHOW CREATE TABLE \`${TABLE}\``);
    console.log(createRows[0]["Create Table"]);

    console.log(`\n── Columns (information_schema.COLUMNS) ──────────────────`);
    const [columns] = await conn.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA, COLUMN_DEFAULT
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [schema, TABLE]
    );
    columns.forEach((c) =>
      console.log(
        `  ${c.COLUMN_NAME.padEnd(28)} ${c.COLUMN_TYPE.padEnd(20)} nullable=${c.IS_NULLABLE} key=${c.COLUMN_KEY || "-"} default=${c.COLUMN_DEFAULT ?? "NULL"} extra=${c.EXTRA || "-"}`
      )
    );

    console.log(`\n── Indexes (SHOW INDEX) ───────────────────────────────────`);
    const [indexes] = await conn.query(`SHOW INDEX FROM \`${TABLE}\``);
    indexes.forEach((i) =>
      console.log(
        `  ${i.Key_name.padEnd(24)} col=${i.Column_name.padEnd(20)} unique=${i.Non_unique === 0} seq=${i.Seq_in_index}`
      )
    );

    console.log(`\n── Foreign keys (information_schema.KEY_COLUMN_USAGE) ────`);
    const [fks] = await conn.query(
      `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [schema, TABLE]
    );
    if (fks.length === 0) console.log("  (none)");
    fks.forEach((f) =>
      console.log(`  ${f.CONSTRAINT_NAME}: ${f.COLUMN_NAME} -> ${f.REFERENCED_TABLE_NAME}.${f.REFERENCED_COLUMN_NAME}`)
    );

    console.log(`\n── Table metadata (information_schema.TABLES) ────────────`);
    const [[meta]] = await conn.query(
      `SELECT ENGINE, TABLE_ROWS, CREATE_TIME, UPDATE_TIME, TABLE_COLLATION, AUTO_INCREMENT
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [schema, TABLE]
    );
    console.log("  Engine          :", meta.ENGINE);
    console.log("  Approx row count:", meta.TABLE_ROWS, "(InnoDB estimate, not an exact COUNT(*))");
    console.log("  Created         :", meta.CREATE_TIME);
    console.log("  Last updated    :", meta.UPDATE_TIME);
    console.log("  Collation       :", meta.TABLE_COLLATION);
    console.log("  Next AUTO_INCREMENT:", meta.AUTO_INCREMENT);
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
});
