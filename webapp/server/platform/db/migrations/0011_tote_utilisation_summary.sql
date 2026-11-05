-- Tote Utilisation history is read constantly (Dashboard tiles, the Utilisation
-- screen, the live feeds). Each run's result_json is ~5 MB of per-tote detail
-- stored as LONGTEXT, so every JSON_EXTRACT re-parses the whole document -
-- listing 12 runs took ~24 s and timed out the pool.
--
-- summary_json holds just the small top-level pieces the list needs, as one
-- JSON array: [totals, stats, mixedCount, pipeline, caps]. It is written when
-- a run completes (toteUtilisationJob.js) and back-filled lazily for runs that
-- pre-date this migration (listRecentResults()). Purely additive: result_json
-- is untouched and still the source of truth for the full per-tote detail.

ALTER TABLE tote_utilisation_results
  ADD COLUMN summary_json MEDIUMTEXT NULL AFTER result_json;
