-- Pre-dump TRUNCATE prelude for Railway restore
-- Safely clears target tables before loading VPS dump.
-- FOREIGN_KEY_CHECKS=0 so truncate order is flexible, but we still
-- truncate children before parents to keep it honest.

SET FOREIGN_KEY_CHECKS = 0;
SET UNIQUE_CHECKS = 0;

-- children first (FKs: surveillance_failures→reversal_entries,
-- paper_position_prices→paper_signals)
TRUNCATE TABLE surveillance_failures;
TRUNCATE TABLE paper_position_prices;

-- parents
TRUNCATE TABLE paper_signals;
TRUNCATE TABLE reversal_entries;

-- standalone tables (no inbound FKs among our set)
TRUNCATE TABLE paper_trades;
TRUNCATE TABLE paper_orders;
TRUNCATE TABLE surveillance_logs;
TRUNCATE TABLE paper_strategies;

SELECT 'prelude_done' AS status;
