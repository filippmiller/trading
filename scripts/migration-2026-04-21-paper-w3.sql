-- Migration: 2026-04-21 — Paper Trading W3 (shorts, protective exits, partial close, order modify)
-- Safe to apply repeatedly (idempotent via INFORMATION_SCHEMA gates).
-- Additive only: no destructive DDL, no data rewrites.
--
-- Changes:
--   A. paper_trades: adds `side ENUM('LONG','SHORT')` + exit-bracket columns
--      + partial-close tracking + watermarks + borrow placeholder.
--   B. paper_trades: adds index (status, time_exit_date) for the exit scanner.
--   C. paper_accounts: adds `reserved_short_margin` — a SEPARATE bucket from
--      `reserved_cash`. Rationale: `reserved_cash` already has an invariant
--      (`paper_orders.reserved_amount` aggregated across PENDING orders).
--      Adding shorts to the same column would require a discriminator and
--      fight the W2 reconciliation view. A dedicated column keeps semantics
--      crisp — equity = cash + reserved_cash + reserved_short_margin + open positions.
--
-- Apply via:
--   railway run --service MySQL mysql < scripts/migration-2026-04-21-paper-w3.sql

-- ── A. paper_trades.side ─────────────────────────────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_trades'
    AND COLUMN_NAME  = 'side'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE paper_trades ADD COLUMN side ENUM(''LONG'',''SHORT'') NOT NULL DEFAULT ''LONG''',
  'SELECT ''paper_trades.side already present'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── A. paper_trades bracket columns (stop / take profit / trailing / time) ──
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_trades' AND COLUMN_NAME='stop_loss_price');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_trades ADD COLUMN stop_loss_price DECIMAL(18,6) NULL', 'SELECT ''stop_loss_price present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_trades' AND COLUMN_NAME='take_profit_price');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_trades ADD COLUMN take_profit_price DECIMAL(18,6) NULL', 'SELECT ''take_profit_price present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_trades' AND COLUMN_NAME='trailing_stop_pct');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_trades ADD COLUMN trailing_stop_pct DECIMAL(10,4) NULL', 'SELECT ''trailing_stop_pct present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_trades' AND COLUMN_NAME='trailing_activates_at_profit_pct');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_trades ADD COLUMN trailing_activates_at_profit_pct DECIMAL(10,4) NULL', 'SELECT ''trailing_activates_at_profit_pct present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_trades' AND COLUMN_NAME='trailing_stop_price');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_trades ADD COLUMN trailing_stop_price DECIMAL(18,6) NULL', 'SELECT ''trailing_stop_price present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_trades' AND COLUMN_NAME='trailing_active');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_trades ADD COLUMN trailing_active TINYINT(1) NOT NULL DEFAULT 0', 'SELECT ''trailing_active present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_trades' AND COLUMN_NAME='time_exit_date');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_trades ADD COLUMN time_exit_date DATE NULL', 'SELECT ''time_exit_date present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_trades' AND COLUMN_NAME='max_pnl_pct');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_trades ADD COLUMN max_pnl_pct DECIMAL(10,4) NULL', 'SELECT ''max_pnl_pct present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_trades' AND COLUMN_NAME='min_pnl_pct');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_trades ADD COLUMN min_pnl_pct DECIMAL(10,4) NULL', 'SELECT ''min_pnl_pct present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_trades' AND COLUMN_NAME='borrow_daily_rate_pct');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_trades ADD COLUMN borrow_daily_rate_pct DECIMAL(10,6) NOT NULL DEFAULT 0', 'SELECT ''borrow_daily_rate_pct present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_trades' AND COLUMN_NAME='closed_quantity');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_trades ADD COLUMN closed_quantity DECIMAL(18,6) NOT NULL DEFAULT 0', 'SELECT ''closed_quantity present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Exit-reason column — closes record which bracket triggered for analytics.
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_trades' AND COLUMN_NAME='exit_reason');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_trades ADD COLUMN exit_reason VARCHAR(32) NULL', 'SELECT ''exit_reason present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── B. paper_trades index for exit scanner ───────────────────────────────
SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_trades'
    AND INDEX_NAME   = 'IX_paper_trades_status_timeexit'
);
SET @sql := IF(@idx_exists = 0,
  'ALTER TABLE paper_trades ADD INDEX IX_paper_trades_status_timeexit (status, time_exit_date)',
  'SELECT ''IX_paper_trades_status_timeexit present'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── C. paper_accounts.reserved_short_margin ─────────────────────────────
-- SEPARATE bucket from reserved_cash (LIMIT/STOP BUY reservations). Keeping
-- them distinct preserves the W2 reconciliation invariant
--   cash + reserved_cash + open_investment = initial_cash + realized_pnl
-- which just extends to
--   cash + reserved_cash + reserved_short_margin + open_long_investment = initial_cash + realized_pnl
-- with short-margin treated as "open short investment" on the LHS.
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_accounts'
    AND COLUMN_NAME  = 'reserved_short_margin'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE paper_accounts ADD COLUMN reserved_short_margin DECIMAL(18,6) NOT NULL DEFAULT 0',
  'SELECT ''paper_accounts.reserved_short_margin present'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── paper_orders: track per-order short margin so PATCH / cancel can refund.
-- Separate column from reserved_amount (BUY-side reservation) for the same
-- reason as reserved_short_margin above.
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_orders'
    AND COLUMN_NAME  = 'reserved_short_margin'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE paper_orders ADD COLUMN reserved_short_margin DECIMAL(18,6) NOT NULL DEFAULT 0',
  'SELECT ''paper_orders.reserved_short_margin present'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── paper_orders.position_side ───────────────────────────────────────────
-- Distinguishes "open/close LONG" from "open/close SHORT" without re-purposing
-- the existing `side` (BUY/SELL) column. Semantics:
--   side='BUY'  + position_side='LONG'  → open LONG
--   side='SELL' + position_side='LONG'  → close LONG
--   side='SELL' + position_side='SHORT' → open SHORT (sell short)
--   side='BUY'  + position_side='SHORT' → close SHORT (buy to cover)
-- Existing rows default to 'LONG' so their behaviour is unchanged.
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_orders'
    AND COLUMN_NAME  = 'position_side'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE paper_orders ADD COLUMN position_side VARCHAR(8) NOT NULL DEFAULT ''LONG''',
  'SELECT ''paper_orders.position_side present'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── paper_orders: bracket fields captured at open-order time ─────────────
-- Optional — if supplied on a BUY order, fillOrder persists them on the
-- resulting paper_trades row at fill time (computing absolute prices from
-- fill price for pct-based fields).
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_orders' AND COLUMN_NAME='bracket_stop_loss_pct');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_orders ADD COLUMN bracket_stop_loss_pct DECIMAL(10,4) NULL', 'SELECT ''bracket_stop_loss_pct present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_orders' AND COLUMN_NAME='bracket_take_profit_pct');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_orders ADD COLUMN bracket_take_profit_pct DECIMAL(10,4) NULL', 'SELECT ''bracket_take_profit_pct present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_orders' AND COLUMN_NAME='bracket_trailing_pct');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_orders ADD COLUMN bracket_trailing_pct DECIMAL(10,4) NULL', 'SELECT ''bracket_trailing_pct present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_orders' AND COLUMN_NAME='bracket_trailing_activates_pct');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_orders ADD COLUMN bracket_trailing_activates_pct DECIMAL(10,4) NULL', 'SELECT ''bracket_trailing_activates_pct present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_orders' AND COLUMN_NAME='bracket_time_exit_days');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_orders ADD COLUMN bracket_time_exit_days INT NULL', 'SELECT ''bracket_time_exit_days present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Partial-close: BUY-to-cover and SELL orders may specify how much of the
-- open position to close (fractional quantity). NULL = close remaining.
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_orders' AND COLUMN_NAME='close_quantity');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_orders ADD COLUMN close_quantity DECIMAL(18,6) NULL', 'SELECT ''close_quantity present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- paper_equity_snapshots — expose reserved_short_margin so the equity curve
-- can plot short-margin-held separately.
SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paper_equity_snapshots' AND COLUMN_NAME='reserved_short_margin');
SET @sql := IF(@col_exists = 0, 'ALTER TABLE paper_equity_snapshots ADD COLUMN reserved_short_margin DECIMAL(18,6) NOT NULL DEFAULT 0', 'SELECT ''snapshots.reserved_short_margin present'' AS status');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'migration-2026-04-21-paper-w3 applied' AS status;
