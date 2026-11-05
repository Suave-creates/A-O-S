-- Direct-login pilot (2026-09-05) - encrypted per-user credential storage for
-- bypassing the ASO Browser Runtime for specific capabilities (Concinity/
-- Quadron first, see server/lib/directAuth/). One row per (user, service).
--
-- encrypted_username/encrypted_password are AES-256-GCM ciphertext (see
-- server/lib/serviceCredentialCrypto.js) - never plaintext, never logged.
-- The server-held encryption key lives only in SERVICE_CREDENTIAL_ENCRYPTION_KEY
-- (.env), never in this database.
--
-- Deliberately no session/token cache column here - a live session (Concinity
-- accessToken, NexS jwt-token, Grafana grafana_session) is cheap to
-- re-derive from the stored credential and is kept in-memory only (see each
-- service's own auth module) rather than persisted, so a compromised DB
-- backup at worst exposes login credentials (already the sensitive part)
-- and never a ready-to-use live session token alongside them.

CREATE TABLE service_credentials (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id             INT UNSIGNED NOT NULL,
  service             VARCHAR(32) NOT NULL,
  encrypted_username  TEXT NOT NULL,
  encrypted_password  TEXT NOT NULL,
  created_at          VARCHAR(32) NOT NULL,
  updated_at          VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_service_credentials_user_service (user_id, service),
  CONSTRAINT fk_service_credentials_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
