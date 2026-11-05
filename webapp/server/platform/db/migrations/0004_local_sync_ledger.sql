-- Local-First Phase 1 - idempotency ledger for server/scripts/syncToCompany.js.
-- Purely additive: does not alter any existing table, and nothing outside
-- syncToCompany.js ever reads or writes it. One row per outbox entry that
-- has been successfully synced into company MySQL, keyed by the entry's
-- own operation_id (a UUID minted locally by server/lib/outbox.js) - this
-- is what makes running the sync command twice a no-op the second time:
-- before inserting a company record, the sync script checks whether
-- operation_id is already present here, and if so, only marks the local
-- outbox entry SYNCED without inserting anything again.
--
-- mysql_table/mysql_id record exactly which company row this operation_id
-- became, for traceability - never used to look anything up automatically.

CREATE TABLE local_sync_ledger (
  operation_id  VARCHAR(36) NOT NULL PRIMARY KEY,
  entity_type   VARCHAR(32) NOT NULL,
  mysql_table   VARCHAR(64) NOT NULL,
  mysql_id      INT UNSIGNED NULL,
  synced_at     VARCHAR(32) NOT NULL,
  KEY idx_local_sync_ledger_entity_type (entity_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
