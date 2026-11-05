-- Historical Report Cache (2026-09-22, operator-reported repeated database
-- strain from "many queries") - CC Metrics/Compaction/ASRS Production for a
-- day that has already fully elapsed (its own Shift C window has closed)
-- never changes again, so it is safe to cache PERMANENTLY rather than
-- re-fetched every time. See server/lib/historicalReportCache.js's own
-- header comment for exactly how this is used - a cache HIT for a closed
-- day skips the Grafana capability dispatch entirely, and (unlike the
-- existing short-TTL capabilityManager result cache) also skips creating a
-- `queries` row and writing to `audit_logs` for that call, which is what
-- was actually driving the database load (every capability call writes
-- several bookkeeping rows regardless of whether the underlying data was
-- already available).

CREATE TABLE historical_report_cache (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  section     VARCHAR(32) NOT NULL,   -- "ccMetrics" | "compaction" | "asrsProduction"
  date_str    VARCHAR(10) NOT NULL,   -- YYYY-MM-DD, IST calendar date
  result_json LONGTEXT NOT NULL,
  cached_at   VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_hrc_section_date (section, date_str)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
