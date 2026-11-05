-- Site-wide settings, one JSON value per key (2026-11-04). First user: the Dashboard's central auto refresh -
-- minutes per tile source, set by an admin, the same for everyone (live/dashboardAutoRefresh.js).
-- A missing key = the default in code.

CREATE TABLE app_settings (
  setting_key  VARCHAR(64) NOT NULL,
  value_json   TEXT NOT NULL,
  updated_by   VARCHAR(64) NULL,
  updated_at   VARCHAR(32) NOT NULL,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
