-- Location Audit: what an auditor found at an empty slot, for one site day (06:00 IST -> 06:00 IST).
-- One row per slot per site day; the screen only reads the current day, so marks "reset" at 06:00 without any
-- clean-up job (older days stay as history). An occupied slot ignores its mark - the live data wins.
--   EMPTY       - physically checked, the slot really is empty
--   TOTE_FOUND  - a tote was physically there although the system says empty (tote_id if the auditor read it)

CREATE TABLE location_audit_marks (
  site_day   DATE         NOT NULL,
  slot_key   VARCHAR(24)  NOT NULL,           -- aisle-level-pillar-L|R-01|02, as the Location Audit model builds it
  outcome    ENUM('EMPTY','TOTE_FOUND') NOT NULL,
  tote_id    VARCHAR(40)  NULL,
  marked_by  INT UNSIGNED NOT NULL,
  marked_at  VARCHAR(32)  NOT NULL,           -- ISO time
  PRIMARY KEY (site_day, slot_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
