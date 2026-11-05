-- Locked Since by lock episode (2026-11-04). A tote is reused: emptied and refilled with other SKUs it is a new
-- tote as far as a lock is concerned. sku_sig keeps the SKUs it held when last seen locked (a JSON array, sorted),
-- so the next refresh can tell a continuing lock (mostly the same SKUs) from a new one (more than half of the
-- SKUs different), which restarts first_seen_at - see features/locked-tote-info/lockedSinceTracker.js.
-- discrepancy_marked_at (already in the table, never filled until now) gets the time of the SHORT report that
-- started the current lock, when there is one.

ALTER TABLE classification_tote_state ADD COLUMN sku_sig TEXT NULL;
