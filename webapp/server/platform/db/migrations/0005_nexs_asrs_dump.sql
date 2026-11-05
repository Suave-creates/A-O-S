-- NEXS ASRS Tote Dump - MySQL persistence (approved design, see the
-- investigation turn preceding this migration). Two-table generation-swap
-- pattern: each refresh writes an entirely new generation of rows under a
-- new refresh_id, then atomically flips nexs_asrs_dump_current to point at
-- it. A generation only ever becomes visible once ALL its rows are written
-- and the pointer swap has committed - readers never see a partial
-- generation. Retention: the latest 3 COMPLETED generations' rows are kept;
-- refresh metadata (nexs_asrs_dump_refreshes) is never pruned by this
-- schema - it is small (one row per attempt, no bulk data) and kept for
-- operator-facing history.
--
-- Purely additive - does not alter any existing table.

CREATE TABLE nexs_asrs_dump_refreshes (
  id                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,   -- the generation/version identifier (refresh_id)
  query_id              VARCHAR(16) NULL,                          -- correlates to `queries` (NEXS_ASRS_DUMP_REFRESH operation)
  status                ENUM('RUNNING','COMPLETED','FAILED') NOT NULL DEFAULT 'RUNNING',
  source                VARCHAR(32) NULL,                          -- "runtime_apps_script" | "google_sheet_direct"
  row_count             INT UNSIGNED NULL,
  total_barcode_count   BIGINT UNSIGNED NULL,
  latest_ingested_at    VARCHAR(32) NULL,                          -- max(ingestedAt) across this generation's rows - part of the existing snapshot contract, computed once at write time so /current never re-scans rows to answer it
  latest_updated_at     VARCHAR(32) NULL,                          -- max(lastUpdatedAt) across this generation's rows, same reasoning
  refreshed_by          INT UNSIGNED NULL,
  error                 TEXT NULL,
  started_at            VARCHAR(32) NOT NULL,
  completed_at          VARCHAR(32) NULL,
  created_at            VARCHAR(32) NOT NULL,
  KEY idx_nexs_refreshes_status (status),
  KEY idx_nexs_refreshes_created_at (created_at),
  CONSTRAINT fk_nexs_refreshes_user FOREIGN KEY (refreshed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE nexs_asrs_dump_rows (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  refresh_id      INT UNSIGNED NOT NULL,
  pid             VARCHAR(32) NULL,
  tote_id         VARCHAR(20) NULL,
  partition_code  VARCHAR(8) NULL,                                 -- "partition" is a MySQL reserved word
  barcode_count   INT UNSIGNED NULL,
  location        VARCHAR(64) NULL,
  last_updated_at VARCHAR(32) NULL,
  ingested_at     VARCHAR(32) NULL,
  KEY idx_nexs_rows_refresh_id (refresh_id),
  KEY idx_nexs_rows_refresh_pid (refresh_id, pid),
  KEY idx_nexs_rows_refresh_tote (refresh_id, tote_id),
  KEY idx_nexs_rows_refresh_location (refresh_id, location),
  CONSTRAINT fk_nexs_rows_refresh FOREIGN KEY (refresh_id) REFERENCES nexs_asrs_dump_refreshes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Singleton pointer row (id is always 1) - the atomic "which generation is
-- current" switch. Updated via a single statement inside the same
-- transaction that finalizes a refresh as COMPLETED.
CREATE TABLE nexs_asrs_dump_current (
  id         TINYINT UNSIGNED PRIMARY KEY,
  refresh_id INT UNSIGNED NOT NULL,
  CONSTRAINT chk_nexs_current_singleton CHECK (id = 1),
  CONSTRAINT fk_nexs_current_refresh FOREIGN KEY (refresh_id) REFERENCES nexs_asrs_dump_refreshes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
