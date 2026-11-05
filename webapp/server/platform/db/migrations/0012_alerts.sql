-- Alerts module. One row per alert EVENT (not per rule):
--   level GLOBAL  = high escalation: shown to every user in the sidebar until someone acknowledges it
--   level NORMAL  = shown on the Alerts page only
-- dedupe_key makes raising idempotent (the same real-world event never creates a second row, even
-- across restarts / re-evaluations). `detail` is the rule's own JSON (what the page shows).
-- A single remark per alert (editable, with who/when); every acknowledge/remark is also written to
-- audit_logs, so the history is not lost when a remark is edited.
-- Acknowledging is shared: the first acknowledgement closes the sidebar notice for everyone and
-- records who took it. Users are stored by employee id (no FK) so the local-dev identity works too.

CREATE TABLE alerts (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  rule_key         VARCHAR(40)  NOT NULL,
  level            ENUM('GLOBAL','NORMAL') NOT NULL,
  dedupe_key       VARCHAR(160) NOT NULL,
  title            VARCHAR(200) NOT NULL,
  detail           TEXT NULL,
  event_at         VARCHAR(32)  NOT NULL,           -- when the underlying event happened (ISO)
  raised_at        VARCHAR(32)  NOT NULL,           -- when this app detected it (ISO)
  updated_at       VARCHAR(32)  NOT NULL,
  status           ENUM('OPEN','ACKNOWLEDGED') NOT NULL DEFAULT 'OPEN',
  acknowledged_by  VARCHAR(32)  NULL,
  acknowledged_at  VARCHAR(32)  NULL,
  remark           TEXT NULL,
  remark_by        VARCHAR(32)  NULL,
  remark_at        VARCHAR(32)  NULL,
  UNIQUE KEY uq_alerts_dedupe (dedupe_key),
  KEY idx_alerts_status_level (status, level),
  KEY idx_alerts_raised_at (raised_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
