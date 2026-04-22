-- Migration: 2026-04-22 — Paper Trading HOTFIX: account-scoped idempotency
-- Safe to apply repeatedly (idempotent via INFORMATION_SCHEMA gates).
--
-- Changes:
--   1. DROP the W5 global UNIQUE INDEX idx_paper_orders_client_request_id
--      (scoped to `client_request_id` alone).
--   2. ADD composite UNIQUE INDEX idx_paper_orders_acct_crid on
--      (account_id, client_request_id).
--
-- Why: the global index let a second account's request with the same
-- client_request_id collide with an earlier account's row. The pre-check
-- `SELECT ... WHERE client_request_id = ?` returned the OTHER account's
-- row — cross-account data leak, and the second caller's order was never
-- placed (silently deduped). With the composite index, identical ids in
-- different accounts are distinct keys; dedup fires only within an account.
--
-- MySQL InnoDB continues to allow multiple NULLs in a UNIQUE index (the
-- uniqueness constraint skips rows where the key is NULL), so legacy rows
-- without an idempotency key remain unaffected regardless of account.
--
-- Apply via:
--   railway run --service MySQL mysql < scripts/migration-2026-04-22-paper-hotfix-account-idempotency.sql

-- ── 1. Drop the global unique index if it exists ─────────────────────────
SET @old_idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_orders'
    AND INDEX_NAME   = 'idx_paper_orders_client_request_id'
);
SET @sql := IF(@old_idx_exists > 0,
  'ALTER TABLE paper_orders DROP INDEX idx_paper_orders_client_request_id',
  'SELECT ''idx_paper_orders_client_request_id already absent'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. Add composite (account_id, client_request_id) unique index ────────
SET @new_idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_orders'
    AND INDEX_NAME   = 'idx_paper_orders_acct_crid'
);
SET @sql := IF(@new_idx_exists = 0,
  'ALTER TABLE paper_orders ADD UNIQUE INDEX idx_paper_orders_acct_crid (account_id, client_request_id)',
  'SELECT ''idx_paper_orders_acct_crid already present'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'migration-2026-04-22-paper-hotfix-account-idempotency applied' AS status;
