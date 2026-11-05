-- Purge tracking v2: each pull keeps a Quadron inventory BASELINE taken when the calling finished and is watched
-- for 2 days (see platform/storage/purgeMarks.js). Replaces the single empty/not-empty verdict of 0018 (never used).
ALTER TABLE purge_pulls
  DROP COLUMN empty_verdict,
  DROP COLUMN verified_at,
  ADD COLUMN pull_done_at  VARCHAR(32) NULL,                          -- calling of the session finished
  ADD COLUMN snapshot_at   VARCHAR(32) NULL,                          -- baseline taken
  ADD COLUMN baseline_qty  INT         NULL,                          -- units in Quadron at that time
  ADD COLUMN baseline_skus TEXT        NULL,                          -- JSON array of the PIDs/SKUs then
  ADD COLUMN status        VARCHAR(12) NOT NULL DEFAULT 'PENDING',    -- PENDING | PURGED | RESTOCKED | EXPIRED
  ADD COLUMN purged_at     VARCHAR(32) NULL,                          -- first time Quadron showed it empty
  ADD KEY idx_purge_pulls_status (status, pulled_at);
