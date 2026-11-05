-- Shared last results (2026-11-04, operator decision: "data loaded by someone can be seen by everyone until a
-- manual or auto refresh is triggered" - the pullers are the exception). The screens whose result used to go
-- only to the person who ran it (Outside Totes, CNG Validator, Bulk Tote Inv Check) keep their latest run here,
-- one row per screen, so everyone opening the screen sees it - and it survives a restart.
-- result_json is a jsonBlob (gzip when large), never queried with JSON functions.

CREATE TABLE shared_results (
  panel        VARCHAR(40) NOT NULL,
  result_json  LONGTEXT NOT NULL,
  meta_json    TEXT NULL,
  run_by       VARCHAR(64) NULL,
  run_at       VARCHAR(32) NOT NULL,
  PRIMARY KEY (panel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
