// Exact port of QTP_UTILS.parseToteList() / TOTE_ID_REGEX from the existing
// extension's shared/utils.js + shared/constants.js. Pure string parsing,
// no DOM - loaded as a plain global in the browser (no bundler in this
// project), and also require()-able directly from server/test/ so the
// parsing behavior gets real unit test coverage against the one and only
// copy of this logic, not a hand-duplicated backend re-implementation that
// could silently drift from what actually runs in the browser.
const ToteListParser = (() => {
  const TOTE_ID_REGEX = /^(TL|TS)[0-9]{10}$/;

  // Splits on whitespace/commas/semicolons, uppercases, filters to valid
  // tote ids. Deliberately preserves input order and does NOT deduplicate -
  // matching the existing Manual Mode exactly (QTP_UTILS.parseToteList
  // performs no uniqueness check either).
  function parseToteList(raw) {
    if (!raw) return [];
    return raw
      .split(/[\s,;\n\r\t]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((id) => TOTE_ID_REGEX.test(id));
  }

  return { parseToteList, TOTE_ID_REGEX };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = ToteListParser;
}
