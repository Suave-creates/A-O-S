-- A Purge-toggle pull only becomes a Purged tote once Quadron shows no inventory for it after the count
-- (operators sometimes do a normal cycle count on a purge-mode tote). NULL = not judged yet,
-- 1 = Quadron has no inventory (purged), 0 = Quadron still has stock (a normal CC; re-checked for a while).
ALTER TABLE purge_pulls
  ADD COLUMN empty_verdict TINYINT(1)  NULL,
  ADD COLUMN verified_at   VARCHAR(32) NULL;
