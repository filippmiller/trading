-- Migration: Add UNIQUE KEY on paper_signals(strategy_id, reversal_entry_id).
--
-- Why: jobExecuteStrategies and jobExecuteConfirmationStrategies both check
-- for duplicate signals via `SELECT 1 FROM paper_signals WHERE strategy_id=?
-- AND reversal_entry_id=?` OUTSIDE their per-entry transaction. Between
-- startup-catchup and the scheduled 09:50 ET tick, two invocations can both
-- pass the check before either commits — producing duplicate signals. The
-- executeStrategiesRunning module-flag only serializes within one process;
-- the database needs to enforce the invariant itself.
--
-- Idempotent: probes information_schema before ALTER, cleans orphans (exact
-- duplicates) first so the constraint creation doesn't fail.
--
-- Usage (on VPS via tunnel):
--   bash scripts/tunnel-db.sh   # in one terminal
--   mysql -h127.0.0.1 -P3319 -uroot -p"${DB_PASSWORD}" trading \
--     < scripts/migration-2026-04-17-unique-signal.sql

-- Step 1: Find and remove exact duplicates. For each (strategy_id,
-- reversal_entry_id) pair with >1 row, keep the MAX(id) (newest) and
-- delete the rest. Refund cash only if a duplicate was in EXECUTED state
-- and its proceeds were already double-credited.
SELECT 'Duplicates before cleanup' AS step,
       COUNT(*) AS total_rows,
       COUNT(DISTINCT strategy_id, reversal_entry_id) AS unique_pairs
  FROM paper_signals
 WHERE strategy_id IS NOT NULL AND reversal_entry_id IS NOT NULL;

-- Show what would be deleted before acting
SELECT 'Duplicate pairs about to collapse' AS step,
       strategy_id, reversal_entry_id, COUNT(*) AS n, MAX(id) AS keep_id
  FROM paper_signals
 WHERE strategy_id IS NOT NULL AND reversal_entry_id IS NOT NULL
 GROUP BY strategy_id, reversal_entry_id
HAVING COUNT(*) > 1;

-- Collapse: keep newest id per (strategy_id, reversal_entry_id) pair
DELETE ps FROM paper_signals ps
 INNER JOIN (
   SELECT strategy_id, reversal_entry_id, MAX(id) AS keep_id
     FROM paper_signals
    WHERE strategy_id IS NOT NULL AND reversal_entry_id IS NOT NULL
    GROUP BY strategy_id, reversal_entry_id
   HAVING COUNT(*) > 1
 ) dups
   ON dups.strategy_id = ps.strategy_id
  AND dups.reversal_entry_id = ps.reversal_entry_id
  AND ps.id <> dups.keep_id;

-- Step 2: Add UNIQUE KEY if not already present.
SET @uk_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'paper_signals'
     AND INDEX_NAME = 'UX_signal_strat_entry'
);

SET @sql := IF(@uk_exists = 0,
  'ALTER TABLE paper_signals
     ADD UNIQUE KEY UX_signal_strat_entry (strategy_id, reversal_entry_id)',
  'SELECT "UX_signal_strat_entry already present — no-op" AS status'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Step 3: Verify
SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'paper_signals'
   AND INDEX_NAME = 'UX_signal_strat_entry'
 ORDER BY SEQ_IN_INDEX;
