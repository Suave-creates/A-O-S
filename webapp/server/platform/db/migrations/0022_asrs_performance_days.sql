-- ASRS Performance (2026-11-03) - one row per IST calendar day: the day's One Pager figures flattened into
-- a small metrics object, the history behind the ASRS Performance screen (MTD totals, daily averages).
--
-- Written by server/live/asrsPerformanceAuto.js every morning at 06:05 IST for the day before (its Shift C
-- has closed by then), and by the month backfill for days that were missed. source says which:
--   AUTO     - the scheduled morning save: a full One Pager for that date (snapshots taken at that moment)
--   CATCHUP  - the same, run later because the server was off at 06:05
--   BACKFILL - production / CC / compaction rebuilt for a past date; snapshot figures only when a One Pager
--              for that date had already been generated, otherwise null
-- report_query_id points at the one_pager_reports row a full save came from (null for a backfill).

CREATE TABLE asrs_performance_days (
  date_str        VARCHAR(10) NOT NULL,
  metrics_json    TEXT NOT NULL,
  source          VARCHAR(16) NOT NULL,
  report_query_id VARCHAR(16) NULL,
  captured_at     VARCHAR(32) NOT NULL,
  PRIMARY KEY (date_str)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
