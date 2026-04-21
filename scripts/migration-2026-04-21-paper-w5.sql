-- Migration: 2026-04-21 — Paper Trading W5 (UX guardrails + multi-account)
-- Safe to apply repeatedly (idempotent via INFORMATION_SCHEMA gates).
-- Additive only: no destructive DDL, no data rewrites.
--
-- Changes:
--   A. paper_orders.client_request_id VARCHAR(64) NULL — client-generated
--      idempotency key. POST /api/paper/order with the same client_request_id
--      is a no-op (returns the existing row). Protects against rapid double-
--      submits (Buy button mashed twice before the fetch lands) and network
--      retries that would otherwise create duplicate orders.
--   B. UNIQUE INDEX idx_paper_orders_client_request_id — enables the
--      single-row dedup lookup. MySQL InnoDB allows MULTIPLE NULLs in a
--      UNIQUE index, so legacy orders without an id are unaffected.
--
-- Apply via:
--   railway run --service MySQL mysql < scripts/migration-2026-04-21-paper-w5.sql

-- ── A. paper_orders.client_request_id ────────────────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_orders'
    AND COLUMN_NAME  = 'client_request_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE paper_orders ADD COLUMN client_request_id VARCHAR(64) NULL',
  'SELECT ''paper_orders.client_request_id present'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── B. UNIQUE INDEX on client_request_id ─────────────────────────────────
-- MySQL InnoDB allows multiple NULLs in a UNIQUE index, so rows that don't
-- carry an idempotency key (legacy / background-placed) are not affected.
-- Only rows that DO carry an id are constrained — if a caller submits the
-- same id twice, the second INSERT fails with errno 1062 (duplicate entry),
-- and POST /api/paper/order catches that to return the existing row.
SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_orders'
    AND INDEX_NAME   = 'idx_paper_orders_client_request_id'
);
SET @sql := IF(@idx_exists = 0,
  'ALTER TABLE paper_orders ADD UNIQUE INDEX idx_paper_orders_client_request_id (client_request_id)',
  'SELECT ''idx_paper_orders_client_request_id present'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'migration-2026-04-21-paper-w5 applied' AS status;
