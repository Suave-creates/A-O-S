-- Runtime registry for the ASO Browser Runtime (Phase 1: connection skeleton
-- only - no capabilities, no commands). One row per enrolled workstation
-- installation. See webapp/server/runtime/ for the code that uses this.
--
-- Deliberately does NOT include approved_by/revoked_by/approved_at/revoked_at
-- columns - who approved/revoked what and when is already captured in
-- audit_logs (RUNTIME_ENROLLMENT_REQUESTED / RUNTIME_APPROVED / RUNTIME_REVOKED),
-- so duplicating it here was left out.

CREATE TABLE runtimes (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  workstation_id      VARCHAR(64) NOT NULL,
  public_key          JSON NOT NULL,
  label               VARCHAR(255) NULL,
  enrollment_status   ENUM('PENDING','APPROVED','REVOKED') NOT NULL DEFAULT 'PENDING',
  status              ENUM('ONLINE','OFFLINE') NOT NULL DEFAULT 'OFFLINE',
  runtime_version     VARCHAR(32) NULL,
  protocol_version    INT UNSIGNED NULL,
  capabilities        JSON NULL,
  last_heartbeat_at   VARCHAR(32) NULL,
  created_at          VARCHAR(32) NOT NULL,
  updated_at          VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_runtimes_workstation_id (workstation_id),
  KEY idx_runtimes_enrollment_status (enrollment_status),
  KEY idx_runtimes_status (status),
  KEY idx_runtimes_last_heartbeat (last_heartbeat_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
