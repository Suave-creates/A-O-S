-- Phase 1 schema, MySQL. Mirrors the SQLite schema.sql from Phase 1 exactly
-- in shape (same 5 tables, same columns) - only the SQL dialect changes
-- (see webapp's migration-plan discussion for the SQLite -> MySQL mapping).
--
-- NOT executed automatically. Applied only by server/db/migrate.js, which
-- tracks applied versions in `schema_migrations` and only ever runs
-- statements from files that haven't been applied yet - never re-runs or
-- alters this file's statements once recorded as applied.
--
-- Timestamps are stored as VARCHAR(32) ISO-8601 strings (e.g.
-- "2026-08-20T09:16:24.548Z"), written by the application via
-- `new Date().toISOString()`, exactly as they were under SQLite. ISO-8601
-- strings compare/sort correctly as text, so this preserves existing
-- comparison behaviour (e.g. session expiry checks) with zero application
-- code changes.

CREATE TABLE users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id   VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('ADMIN','USER') NOT NULL,
  created_at    VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_users_employee_id (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE sessions (
  token       VARCHAR(64) PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  created_at  VARCHAR(32) NOT NULL,
  expires_at  VARCHAR(32) NOT NULL,
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires_at (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE queries (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  query_id      VARCHAR(16) NOT NULL,
  user_id       INT UNSIGNED NOT NULL,
  operation     VARCHAR(64) NOT NULL,
  status        ENUM('QUEUED','RUNNING','COMPLETED','FAILED','CANCEL_REQUESTED','CANCELLED','TIMEOUT') NOT NULL,
  parameters    TEXT,
  started_at    VARCHAR(32),
  completed_at  VARCHAR(32),
  cancelled_at  VARCHAR(32),
  error         TEXT,
  created_at    VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_queries_query_id (query_id),
  KEY idx_queries_user (user_id),
  KEY idx_queries_status (status),
  KEY idx_queries_created_at (created_at),
  KEY idx_queries_operation (operation),
  CONSTRAINT fk_queries_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE tote_utilisation_results (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  query_id    VARCHAR(16) NOT NULL,
  result_json LONGTEXT NOT NULL,
  row_count   INT UNSIGNED NOT NULL DEFAULT 0,
  created_at  VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_tur_query_id (query_id),
  CONSTRAINT fk_tur_query FOREIGN KEY (query_id) REFERENCES queries(query_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Administrative/system audit trail - separate from ASRS operational call
-- history (unchanged from Phase 1: that stays in chrome.storage.local / the
-- Apps Script Call History sheet).
CREATE TABLE audit_logs (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED,
  action      VARCHAR(64) NOT NULL,
  detail      TEXT,
  created_at  VARCHAR(32) NOT NULL,
  KEY idx_audit_user (user_id),
  KEY idx_audit_created_at (created_at),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
