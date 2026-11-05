// CLI entry point for the migration runner. Used identically on the laptop
// and the company server: `npm run migrate` (env vars determine the target).
const migrate = require("./migrate");

migrate()
  .then((result) => {
    console.log("[migrate] Done.", JSON.stringify(result));
    process.exit(0);
  })
  .catch((e) => {
    console.error("[migrate] Migration failed:", e.message);
    process.exit(1);
  });
