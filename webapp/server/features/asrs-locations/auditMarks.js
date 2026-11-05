// Location Audit marks: an auditor's finding at an empty slot, kept for the current site day only (see migration
// 0021). Marks are site data - everyone sees everyone's - and say who marked each slot and when.

const defaultDb = require("../../platform/db");
const { siteDayIST } = require("../../platform/time/shiftWindows");

const OUTCOMES = new Set(["EMPTY", "TOTE_FOUND"]);
const SLOT_KEY_RE = /^[1-6]-\d{1,2}-\d{1,3}-[LR]-0[12]$/;
// marked one cell at a time from the grid; the list shape is kept so a few cells can share one request
const MAX_BATCH = 50;

function validSlotKeys(list) {
  if (!Array.isArray(list) || !list.length) return { error: "No slots given" };
  if (list.length > MAX_BATCH) return { error: `At most ${MAX_BATCH} slots at a time` };
  const keys = [...new Set(list.map(String))];
  const bad = keys.find((k) => !SLOT_KEY_RE.test(k));
  return bad ? { error: `Not a slot: ${bad}` } : { keys };
}

async function list({ db = defaultDb, now = Date.now() } = {}) {
  const siteDay = siteDayIST(now);
  const rows = await db.query(
    `SELECT m.slot_key AS slotKey, m.outcome, m.tote_id AS toteId, u.employee_id AS markedBy, m.marked_at AS markedAt
       FROM location_audit_marks m LEFT JOIN users u ON u.id = m.marked_by
      WHERE m.site_day = ?`,
    [siteDay]
  );
  return { siteDay, marks: rows };
}

async function mark({ slotKeys, outcome, toteId = null, userId }, { db = defaultDb, now = Date.now() } = {}) {
  if (!OUTCOMES.has(outcome)) return { error: "Outcome must be EMPTY or TOTE_FOUND" };
  const v = validSlotKeys(slotKeys);
  if (v.error) return v;
  const tote = outcome === "TOTE_FOUND" && toteId ? String(toteId).trim().toUpperCase().slice(0, 40) || null : null;
  const siteDay = siteDayIST(now);
  const at = new Date(now).toISOString();
  const values = v.keys.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
  const params = v.keys.flatMap((k) => [siteDay, k, outcome, tote, userId, at]);
  await db.execute(
    `INSERT INTO location_audit_marks (site_day, slot_key, outcome, tote_id, marked_by, marked_at) VALUES ${values}
     ON DUPLICATE KEY UPDATE outcome = VALUES(outcome), tote_id = VALUES(tote_id), marked_by = VALUES(marked_by), marked_at = VALUES(marked_at)`,
    params
  );
  return { siteDay, count: v.keys.length };
}

async function clear({ slotKeys }, { db = defaultDb, now = Date.now() } = {}) {
  const v = validSlotKeys(slotKeys);
  if (v.error) return v;
  const siteDay = siteDayIST(now);
  await db.execute(`DELETE FROM location_audit_marks WHERE site_day = ? AND slot_key IN (${v.keys.map(() => "?").join(", ")})`, [siteDay, ...v.keys]);
  return { siteDay, count: v.keys.length };
}

module.exports = { list, mark, clear, MAX_BATCH, SLOT_KEY_RE };
