-- Migration: Add ON DELETE CASCADE FK from paper_position_prices to paper_signals.
--
-- Why: Without the FK, hard-deletes of paper_signals (via cleanup SQL scripts)
-- leave orphan rows in paper_position_prices forever. Schema now matches
-- docker/init-db.sql for fresh containers — this migration brings existing
-- prod up to date.
--
-- Idempotent: safe to re-run. Checks for the constraint before creating.
-- Cleans orphan rows BEFORE adding the FK (FK creation would fail otherwise).
--
-- Usage (on VPS):
--   ssh root@89.167.42.128
--   docker exec -i <mysql_container> mysql -uroot -p<pwd> trading \
--     < scripts/migration-2026-04-17-fk-cascade.sql
--
-- Or via SSH tunnel from local machine:
--   bash scripts/tunnel-db.sh   # in one terminal
--   mysql -h127.0.0.1 -P3319 -uroot -ptrading123 trading \
--     < scripts/migration-2026-04-17-fk-cascade.sql

-- Step 1: Clean orphan rows (signal_id pointing at non-existent signal).
DELETE pp FROM paper_position_prices pp
LEFT JOIN paper_signals ps ON ps.id = pp.signal_id
WHERE ps.id IS NULL;

-- Step 2: Add FK if not already present. Uses information_schema probe +
-- PREPARE/EXECUTE so the statement is syntactically always valid but a
-- no-op when the constraint already exists.
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE()
     AND TABLE_NAME = 'paper_position_prices'
     AND CONSTRAINT_NAME = 'FK_pos_price_signal'
);

SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE paper_position_prices
     ADD CONSTRAINT FK_pos_price_signal
     FOREIGN KEY (signal_id) REFERENCES paper_signals(id) ON DELETE CASCADE',
  'SELECT "FK_pos_price_signal already present — no-op" AS status'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Step 3: Verify
SELECT
  CONSTRAINT_NAME, DELETE_RULE
FROM information_schema.REFERENTIAL_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
  AND TABLE_NAME = 'paper_position_prices';
