-- One Pager Report (2026-09-07) - a single self-contained report combining
-- Locked Totes, Tote Utilisation, and Outside Totes (12-24h / above 24h),
-- each freshly fetched live by onePagerReportEngine.js rather than reused
-- from another tab's own last-refreshed state. One permanent row per
-- ONE_PAGER_REPORT run, keyed by query_id - mirrors locked_tote_snapshots/
-- tote_utilisation_results exactly (same shape, same reasoning): the
-- "current" report is simply the most recent COMPLETED row.

CREATE TABLE one_pager_reports (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  query_id    VARCHAR(16) NOT NULL,
  result_json LONGTEXT NOT NULL,
  created_at  VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_opr_query_id (query_id),
  KEY idx_opr_created_at (created_at),
  CONSTRAINT fk_opr_query FOREIGN KEY (query_id) REFERENCES queries(query_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
