-- User management: a deleted user keeps their row (their query / audit history references it) but can no
-- longer sign in, and drops out of every list. Creating the same employee ID again reactivates the row.
ALTER TABLE users ADD COLUMN deleted_at VARCHAR(32) NULL;
