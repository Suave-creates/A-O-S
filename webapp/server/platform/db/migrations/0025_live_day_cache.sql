-- Live day cache (2026-11-04, operator decision: "previous data doesn't change, so why re-read it each time?").
-- The OPEN site day's Grafana reads, kept per hour (or per shift) so a refresh only asks Grafana for the recent
-- part of the day - see integrations/grafana/grafanaDayCache.js for the policy.
--
-- Only settled slots are stored (an hour last read 60+ min after it ended, or a shift frozen by its final read),
-- so a restart does not mean re-reading the whole day. Rows older than a few days are pruned; a CLOSED day is
-- never served from here - its numbers come from the full 06:05 read (historical_report_cache).
-- value_json is a jsonBlob (gzip when large), never queried with JSON functions.

CREATE TABLE live_day_cache (
  date_str    VARCHAR(10) NOT NULL,
  section     VARCHAR(64) NOT NULL,
  slot        VARCHAR(8) NOT NULL,
  value_json  LONGTEXT NOT NULL,
  read_at     BIGINT NOT NULL,
  frozen      TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (date_str, section, slot)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
