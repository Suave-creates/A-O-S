-- Per-user screen access: NULL = every panel (existing users keep working), else a JSON array of panel keys.
ALTER TABLE users ADD COLUMN panels TEXT NULL;
