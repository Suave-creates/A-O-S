-- Locked Tote Analytics (2026-11-03) - the raw cycle-count trail of one site day (06:00 -> 06:00 IST), kept so the
-- analytics can look back 30+ days without reading Grafana again: the SHORT discrepancy reports (verification
-- events) and every GTP stock-check line, compacted (see features/locked-tote-info/ccDayRows.js).
--
-- Only CLOSED days are stored - a closed day never changes again; the open day is always read fresh.
-- rows_json is a jsonBlob (gzip when large), never queried with JSON functions.

CREATE TABLE cc_day_rows (
  date_str     VARCHAR(10) NOT NULL,
  rows_json    LONGTEXT NOT NULL,
  report_count INT UNSIGNED NOT NULL DEFAULT 0,
  line_count   INT UNSIGNED NOT NULL DEFAULT 0,
  fetched_at   VARCHAR(32) NOT NULL,
  PRIMARY KEY (date_str)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
