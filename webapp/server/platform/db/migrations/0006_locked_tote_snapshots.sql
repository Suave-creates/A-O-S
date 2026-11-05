-- Locked Tote Information module (merges the former "ASRS: Locked Totes"
-- and "Classification" tabs). One permanent row per LOCKED_TOTE_INFO_REFRESH
-- run, keyed by query_id - mirrors tote_utilisation_results exactly (same
-- shape, same reasoning): the "current" snapshot is simply the most recent
-- COMPLETED row (ORDER BY id DESC LIMIT 1), never a separate pointer table
-- - this data is small enough per run that Tote Utilisation's simpler
-- pattern applies, not NEXS ASRS Dump's heavier generation-swap pattern.
--
-- classification_tote_state (migration 0003, "Locked Since" tracking) is
-- UNCHANGED and untouched by this migration - it remains its own,
-- independent, append-only per-tote table. This table only adds
-- persistence for the snapshot (totes + summary + degraded flags) that
-- was previously an in-memory-only variable in classificationEngine.js,
-- lost on every backend restart.

CREATE TABLE locked_tote_snapshots (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  query_id    VARCHAR(16) NOT NULL,
  result_json LONGTEXT NOT NULL,
  row_count   INT UNSIGNED NOT NULL DEFAULT 0,
  created_at  VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_lts_query_id (query_id),
  KEY idx_lts_created_at (created_at),
  CONSTRAINT fk_lts_query FOREIGN KEY (query_id) REFERENCES queries(query_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
