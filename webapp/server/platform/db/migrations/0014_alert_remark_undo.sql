-- One-time undo of a saved remark: the remark before the latest save is kept until it is undone.
ALTER TABLE alerts
  ADD COLUMN remark_prev    TEXT        NULL,
  ADD COLUMN remark_prev_by VARCHAR(64) NULL,
  ADD COLUMN remark_prev_at VARCHAR(32) NULL,
  ADD COLUMN undo_ok        TINYINT(1)  NOT NULL DEFAULT 0;
