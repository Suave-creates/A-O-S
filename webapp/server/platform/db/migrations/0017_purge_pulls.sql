-- Totes the operator called through the Manual Tote Puller with purpose PURGE (marking the whole tote
-- Bermuda to free ASRS space). The stock-check data cannot tell a deliberate purge from a tote whose
-- stock really went missing, so the intent is recorded at pull time. One row per tote per session.
CREATE TABLE purge_pulls (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tote_id    VARCHAR(40)  NOT NULL,           -- base tote id (no partition suffix)
  pulled_at  VARCHAR(32)  NOT NULL,           -- ISO time the session was started
  session_id VARCHAR(64)  NULL,
  user_id    BIGINT UNSIGNED NULL,
  KEY idx_purge_pulls_pulled (pulled_at),
  KEY idx_purge_pulls_tote (tote_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
