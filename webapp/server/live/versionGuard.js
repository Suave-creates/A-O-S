// Heavy-read guard: the tote-utilisation history query pulls ~5 MB of JSON per
// row (JSON_EXTRACT still reads the document), so running it on every tick
// would hammer MySQL and exhaust the pool. Ask a cheap question first (row
// count + newest timestamp - no JSON touched) and only re-read when that
// answer changed. One cache for everyone: the history is site-wide.

const db = require("../platform/db");

function versionGuarded(readVersion, read) {
  let hit = null; // { version, data }
  return async (ctx) => {
    const version = await readVersion();
    if (hit && hit.version === version) return hit.data;
    const data = await read(ctx);
    hit = { version, data };
    return data;
  };
}

const utilisationVersion = async () => {
  const rows = await db.query("SELECT COUNT(*) AS n, MAX(created_at) AS newest FROM tote_utilisation_results");
  return `${rows[0].n}|${rows[0].newest}`;
};

module.exports = { versionGuarded, utilisationVersion };
