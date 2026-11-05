-- Operator-editable alert rule settings (Alerts page, admins). A missing row = the default from config.js.
CREATE TABLE alert_rule_settings (
  rule_key   VARCHAR(48) NOT NULL PRIMARY KEY,
  enabled    TINYINT(1)  NOT NULL DEFAULT 1,
  threshold  INT UNSIGNED NOT NULL,
  updated_by VARCHAR(64) NULL,
  updated_at VARCHAR(32) NOT NULL
);
