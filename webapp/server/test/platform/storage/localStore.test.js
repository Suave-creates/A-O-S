// Tests for server/platform/storage/localStore.js - the Local-First Phase 1 file-backed
// persistence primitive. Pure file I/O, no MySQL, no Quadron/Grafana/
// Concinity/NexS call anywhere in this file.
//
// ASO_LOCAL_STORE_DIR points this file's own process at a throwaway temp
// directory - never the real webapp/.local-dev-data/.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.ASO_LOCAL_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aso-localstore-test-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const localStore = require("../../../platform/storage/localStore");

test.after(() => {
  fs.rmSync(process.env.ASO_LOCAL_STORE_DIR, { recursive: true, force: true });
});

test("BASE_DIR resolves to the ASO_LOCAL_STORE_DIR override, not the real .local-dev-data", () => {
  assert.equal(localStore.BASE_DIR, process.env.ASO_LOCAL_STORE_DIR);
});

test("readCollection returns the fallback when the file does not exist yet", () => {
  const result = localStore.readCollection("does-not-exist-yet", { empty: true });
  assert.deepEqual(result, { empty: true });
});

test("writeCollection then readCollection round-trips exactly", () => {
  const data = { totes: ["TL1", "TL2"], count: 2 };
  localStore.writeCollection("roundtrip", data);
  const result = localStore.readCollection("roundtrip", null);
  assert.deepEqual(result, data);
});

test("writeCollection is atomic: no .tmp file is left behind after a successful write", () => {
  localStore.writeCollection("atomic-check", [1, 2, 3]);
  const files = fs.readdirSync(localStore.BASE_DIR);
  const tmpFiles = files.filter((f) => f.includes(".tmp-"));
  assert.deepEqual(tmpFiles, [], "no temp file should survive a successful write");
  assert.ok(files.includes("atomic-check.json"));
});

test("a second write fully replaces the first (whole-document semantics, not a merge)", () => {
  localStore.writeCollection("replace-check", { a: 1 });
  localStore.writeCollection("replace-check", { b: 2 });
  assert.deepEqual(localStore.readCollection("replace-check", null), { b: 2 });
});

test("readCollection recovers gracefully (falls back) from a corrupt/unparseable file instead of throwing", () => {
  const file = path.join(localStore.BASE_DIR, "corrupt.json");
  fs.writeFileSync(file, "{ this is not valid JSON", "utf8");
  const result = localStore.readCollection("corrupt", "fallback-value");
  assert.equal(result, "fallback-value");
});

test("readCollection treats an empty file as the fallback, not a parse error", () => {
  const file = path.join(localStore.BASE_DIR, "empty.json");
  fs.writeFileSync(file, "", "utf8");
  const result = localStore.readCollection("empty", "fallback-value");
  assert.equal(result, "fallback-value");
});

test("collections are independent - writing one never touches another", () => {
  localStore.writeCollection("indep-a", { name: "a" });
  localStore.writeCollection("indep-b", { name: "b" });
  assert.deepEqual(localStore.readCollection("indep-a", null), { name: "a" });
  assert.deepEqual(localStore.readCollection("indep-b", null), { name: "b" });
});

test("data persists across separate read calls without re-writing (simulated restart read)", () => {
  localStore.writeCollection("restart-sim", { sessionId: "Q-000001", status: "COMPLETED" });
  // A fresh readCollection call, as a freshly-restarted process's own
  // module-load-time hydration would perform, sees the same data.
  const firstRead = localStore.readCollection("restart-sim", null);
  const secondRead = localStore.readCollection("restart-sim", null);
  assert.deepEqual(firstRead, secondRead);
  assert.equal(firstRead.sessionId, "Q-000001");
});
