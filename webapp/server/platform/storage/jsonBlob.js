// Stores a large JSON result in a LONGTEXT column as "gz1:" + base64(gzip(json)). A tote-utilisation or One Pager
// result is ~5 MB of per-tote detail; sent to MySQL over the network that write alone took 3-9 s, and compressed it
// is ~0.5 MB. Small values stay plain JSON, and unpack() reads plain JSON too, so rows written before this existed
// still load. Only use it for columns nobody queries with JSON_EXTRACT (a packed value is not valid JSON to MySQL).
const zlib = require("zlib");
const { promisify } = require("util");

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const PREFIX = "gz1:";
const MIN_PACK_BYTES = 64 * 1024;

async function pack(value) {
  const json = JSON.stringify(value);
  if (json.length < MIN_PACK_BYTES) return json;
  return PREFIX + (await gzip(json, { level: 6 })).toString("base64");
}

async function unpack(text) {
  if (text == null) return null;
  if (typeof text !== "string") return text; // a JSON column driver may already have parsed it
  if (!text.startsWith(PREFIX)) return JSON.parse(text);
  return JSON.parse((await gunzip(Buffer.from(text.slice(PREFIX.length), "base64"))).toString("utf8"));
}

module.exports = { pack, unpack };
