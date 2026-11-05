// Pure tote-location status classification - ported verbatim from the
// legacy extension's trStatusOf() (background/index.js). No I/O.
//
// Order matters (first match wins): "_bt_" -> Bad Tracker (checked before
// "_bin"/"_bout" since a bad-tracker location can otherwise look buffer-
// shaped); "_bin"/"_bout" -> Buffer; contains "out" -> Outside Tote; starts
// with 00[4-9] -> On Location; anything else -> "—" (unclassified).
function classifyStatus(location) {
  if (!location) return "";
  const l = String(location).toLowerCase();
  if (l.includes("_bt_")) return "Bad Tracker";
  if (l.includes("_bin") || l.includes("_bout")) return "Buffer";
  if (l.includes("out")) return "Outside Tote";
  if (/^00[4-9]/.test(l)) return "On Location";
  return "—";
}

module.exports = { classifyStatus };
