// Local-First Phase 1 - development-only, file-backed persistence
// primitive. Used ONLY when config.localStoreMode === "local"
// (ASO_LOCAL_DEV=true + NODE_ENV=development - see server/config.js).
// Nothing in the production (MySQL) path imports this file, and this file
// never imports MySQL, capabilityManager, runtime/, or any pull/capability
// module - it is pure local file I/O.
//
// Stores one JSON document per named collection under
// webapp/.local-dev-data/ (gitignored - see .gitignore). This is dev-scale
// data (a handful of local sessions between office visits), not a
// high-frequency store, so a full-document rewrite per write is simpler
// and safer than incremental append/patch logic. Every write goes to a
// temp file first, then an atomic rename() over the real file - on the
// same filesystem, rename() is atomic, so a crash mid-write can never
// leave a half-written file in place of the previous good one: a reader
// only ever sees the old file or the fully-written new one.

const fs = require("node:fs");
const path = require("node:path");

// ASO_LOCAL_STORE_DIR exists ONLY so the test suite can point this at a
// throwaway temp directory instead of the real webapp/.local-dev-data/ -
// it is never set in .env, .env.local-dev, or any documented runtime
// configuration. Production code always resolves the real path below.
const BASE_DIR = process.env.ASO_LOCAL_STORE_DIR || path.join(__dirname, "..", "..", "..", ".local-dev-data");

function ensureBaseDir() {
  fs.mkdirSync(BASE_DIR, { recursive: true });
}

function collectionPath(name) {
  return path.join(BASE_DIR, `${name}.json`);
}

// Never throws. A missing file (first run) or an unreadable/corrupt one
// (e.g. hand-edited, or a write that was interrupted before this module's
// atomic-rename discipline existed) both fall back to `fallback` - local
// dev data is not worth crashing startup over.
function readCollection(name, fallback) {
  const file = collectionPath(name);
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[localStore] Could not read "${name}.json" (${e.message}) - starting from an empty collection.`);
    return fallback;
  }
}

function writeCollection(name, data) {
  ensureBaseDir();
  const file = collectionPath(name);
  const tmpFile = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpFile, file);
}

module.exports = { readCollection, writeCollection, BASE_DIR };
