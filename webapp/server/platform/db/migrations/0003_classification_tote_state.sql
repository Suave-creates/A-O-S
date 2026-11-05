-- Backend-side "Locked Since" state for the Classification panel. One row
-- per tote ever observed as locked by Classification, keyed by base tote id
-- (never a partitioned "-N" suffix - see baseToteId() in
-- server/lib/classification.js).
--
-- discrepancy_marked_at is deliberately included now, NULL until a future
-- phase populates it from real discrepancy history - see
-- server/lib/lockedSinceTracker.js's own comment for why this column
-- exists ahead of that system being built: it lets "Locked Since" switch
-- from firstSeenAt to a real discrepancy timestamp later with a data
-- change only, no Classification UI/API shape change.
--
-- first_seen_at is set once, on the row's first INSERT, and is never
-- updated again by application code afterwards, even across a tote
-- disappearing and later reappearing in Locked Dump (see
-- lockedSinceTracker.js for the documented reasoning). last_seen_at
-- advances on every observation and exists for future staleness/audit use;
-- it is not currently surfaced in the Classification UI.

CREATE TABLE classification_tote_state (
  tote_id                 VARCHAR(20) NOT NULL PRIMARY KEY,
  first_seen_at           VARCHAR(32) NOT NULL,
  last_seen_at            VARCHAR(32) NOT NULL,
  discrepancy_marked_at   VARCHAR(32) NULL,
  KEY idx_classification_tote_state_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
