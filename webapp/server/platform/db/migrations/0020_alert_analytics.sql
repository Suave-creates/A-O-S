-- Alert analytics storage.
--
-- 1. Searchable columns on `alerts`: station / tote / metric / threshold were only inside the `detail` JSON text,
--    so analytics could not filter or group by them in SQL. They are copied out when an alert is raised or grows.
-- 2. `alert_events`: the history of each alert. `alerts` keeps only the current state (a growing station count
--    or a re-saved remark overwrites the old value); this keeps every step with who and when.
-- 3. `alert_daily`: per IST day x rule x station rollup, rebuilt from `alerts` by the server, so long-range
--    analytics stays fast.
-- Existing rows are backfilled: columns from `detail`, history from `alerts` + the audit log.

ALTER TABLE alerts
  ADD COLUMN station   VARCHAR(32) NULL,
  ADD COLUMN tote      VARCHAR(64) NULL,
  ADD COLUMN metric    INT         NULL,   -- the figure the rule compared with its limit (G1: units short, G2: totes)
  ADD COLUMN threshold INT         NULL,   -- the limit in force when it was raised
  ADD KEY idx_alerts_event_at (event_at),
  ADD KEY idx_alerts_station (station, event_at),
  ADD KEY idx_alerts_tote (tote);

UPDATE alerts SET
  station   = JSON_VALUE(detail, '$.station'),
  tote      = JSON_VALUE(detail, '$.tote'),
  metric    = CASE rule_key WHEN 'G1_TOTE_SHORT_QTY' THEN JSON_VALUE(detail, '$.shortQty' RETURNING SIGNED)
                            WHEN 'G2_STATION_SHORT_TOTES' THEN JSON_VALUE(detail, '$.count' RETURNING SIGNED) END,
  threshold = JSON_VALUE(detail, '$.threshold' RETURNING SIGNED)
WHERE JSON_VALID(detail);

CREATE TABLE alert_events (
  id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  alert_id  BIGINT UNSIGNED NOT NULL,
  kind      ENUM('RAISED','UPDATED','ACKNOWLEDGED','REMARK','REMARK_UNDONE') NOT NULL,
  at        VARCHAR(32) NOT NULL,          -- ISO
  actor     VARCHAR(64) NULL,              -- employee id; NULL = the alert engine
  metric    INT         NULL,              -- RAISED / UPDATED: the rule's figure at that moment
  note      TEXT        NULL,              -- REMARK: the text saved
  KEY idx_alert_events_alert (alert_id, at),
  KEY idx_alert_events_kind_at (kind, at),
  CONSTRAINT fk_alert_events_alert FOREIGN KEY (alert_id) REFERENCES alerts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO alert_events (alert_id, kind, at, actor, metric)
  SELECT id, 'RAISED', raised_at, NULL, metric FROM alerts;

INSERT INTO alert_events (alert_id, kind, at, actor)
  SELECT id, 'ACKNOWLEDGED', acknowledged_at, acknowledged_by FROM alerts WHERE acknowledged_at IS NOT NULL;

-- Remark history comes from the audit log (it has every save/undo; `alerts` only the latest).
INSERT INTO alert_events (alert_id, kind, at, actor, note)
  SELECT a.id, IF(l.action = 'ALERT_REMARK', 'REMARK', 'REMARK_UNDONE'), l.created_at, u.employee_id, l.remark
  FROM (
    SELECT user_id, action, created_at,
      CASE WHEN JSON_VALID(detail) THEN JSON_VALUE(detail, '$.alertId' RETURNING UNSIGNED) END AS alert_id,
      CASE WHEN JSON_VALID(detail) THEN JSON_UNQUOTE(JSON_EXTRACT(detail, '$.remark')) END AS remark
    FROM audit_logs WHERE action IN ('ALERT_REMARK', 'ALERT_REMARK_UNDONE')
  ) l
  JOIN alerts a ON a.id = l.alert_id
  LEFT JOIN users u ON u.id = l.user_id
  ORDER BY l.created_at;

CREATE TABLE alert_daily (
  day              DATE        NOT NULL,             -- IST calendar day of the event
  rule_key         VARCHAR(40) NOT NULL,
  station          VARCHAR(32) NOT NULL DEFAULT '',  -- '' = the alert has no station
  level            ENUM('GLOBAL','NORMAL') NOT NULL,
  raised           INT UNSIGNED    NOT NULL,
  acknowledged     INT UNSIGNED    NOT NULL,
  with_remark      INT UNSIGNED    NOT NULL,
  metric_sum       BIGINT          NOT NULL,         -- e.g. total units short across the day's G1 alerts
  ack_seconds_sum  BIGINT UNSIGNED NOT NULL,         -- raised -> acknowledged, over the acknowledged ones
  ack_seconds_max  INT UNSIGNED    NULL,
  refreshed_at     VARCHAR(32)     NOT NULL,
  PRIMARY KEY (day, rule_key, station)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
