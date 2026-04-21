-- Migration: 2026-04-21 — Paper Trading W2 data integrity
-- Safe to apply repeatedly (idempotent via INFORMATION_SCHEMA gates).
-- Additive only: no destructive DDL, no data rewrites.
--
-- Changes:
--   1. Adds `paper_equity_snapshots.reserved_cash` — track held cash at
--      snapshot time so equity reconstruction includes pending reservations.
--   2. Adds `paper_equity_snapshots.realized_pnl` — cumulative closed P&L
--      at snapshot time, so a chart can plot realized vs unrealized without
--      re-aggregating the whole paper_trades history per point.
--   3. Adds `paper_trades.strategy_id` INT NULL — real FK to paper_strategies.
--      The existing `strategy` VARCHAR stays as a denormalized human label.
--      Manual UI trades get NULL strategy_id + 'MANUAL BUY'/'MANUAL SELL'.
--      Cron-path trades (when wired through in W3+) will set strategy_id.
--   4. Creates VIEW `v_paper_account_activity` that UNIONs paper_trades +
--      paper_signals into a unified (account_id, event_type, symbol,
--      amount_usd, at_timestamp) stream for audit/reconciliation queries.
--
-- NOT APPLIED to Railway production by this migration — apply after codex
-- review + merge via:
--   railway run --service MySQL mysql < scripts/migration-2026-04-21-paper-w2.sql

-- ── paper_equity_snapshots.reserved_cash ─────────────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_equity_snapshots'
    AND COLUMN_NAME  = 'reserved_cash'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE paper_equity_snapshots ADD COLUMN reserved_cash DECIMAL(18,6) NOT NULL DEFAULT 0',
  'SELECT ''snapshots.reserved_cash already present'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── paper_equity_snapshots.realized_pnl ──────────────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_equity_snapshots'
    AND COLUMN_NAME  = 'realized_pnl'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE paper_equity_snapshots ADD COLUMN realized_pnl DECIMAL(18,6) NOT NULL DEFAULT 0',
  'SELECT ''snapshots.realized_pnl already present'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── paper_trades.strategy_id ─────────────────────────────────────────────
-- Real FK to paper_strategies.id. Left NULL for manual trades and all
-- existing historical rows (we do NOT reverse-parse "MARKET BUY" strings).
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_trades'
    AND COLUMN_NAME  = 'strategy_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE paper_trades ADD COLUMN strategy_id INT NULL, ADD INDEX IX_paper_trades_strategy (strategy_id)',
  'SELECT ''paper_trades.strategy_id already present'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add FK constraint only if not already present. We use ON DELETE SET NULL
-- (codex F5): deleting a strategy leaves the trade row + its denormalized
-- `strategy` VARCHAR label intact, but the exact FK is lost. That's an
-- acceptable trade-off because it allows strategies to be garbage-collected
-- without having to rewrite every historical trade. If you NEED a bulletproof
-- audit chain, change this to RESTRICT and force strategies to be retired
-- (enabled=0) rather than deleted.
--
-- codex F6 — also gate on `paper_strategies` existing. Fresh clones / new
-- staging environments may not have run the application's ensureSchema() yet
-- (which CREATEs paper_strategies). Skip the FK in that case; re-running
-- this migration after ensureSchema() picks it up cleanly.
SET @strat_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_strategies'
);
SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_trades'
    AND CONSTRAINT_NAME = 'FK_paper_trades_strategy'
);
SET @sql := CASE
  WHEN @strat_exists = 0
    THEN 'SELECT ''paper_strategies missing — skipping FK_paper_trades_strategy (re-run after ensureSchema)'' AS status'
  WHEN @fk_exists > 0
    THEN 'SELECT ''FK_paper_trades_strategy already present'' AS status'
  ELSE
    'ALTER TABLE paper_trades ADD CONSTRAINT FK_paper_trades_strategy FOREIGN KEY (strategy_id) REFERENCES paper_strategies(id) ON DELETE SET NULL'
END;
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── v_paper_account_activity VIEW ────────────────────────────────────────
-- Unified event stream UNIONing paper_trades + paper_signals. Columns:
--   account_id    — owner account
--   source        — 'trade' or 'signal' (provenance)
--   event_type    — 'TRADE_OPEN' | 'TRADE_CLOSE' | 'SIGNAL_ENTRY' | 'SIGNAL_EXIT'
--                   (WIN/LOSS subtype for signals encoded in `outcome`)
--   symbol        — ticker
--   amount_usd    — SIGNED cash flow from the ACCOUNT's perspective:
--                     OPENs  → negative investment_usd  (cash leaves account)
--                     CLOSEs → +proceeds — i.e. (investment_usd + pnl_usd)
--                              NEGATIVE of that signed flow is -(inv+pnl)
--                              so SUM(amount_usd) over a CLOSED trade pair
--                              reduces to -investment + (investment + pnl) = +pnl
--                   (codex F4 — the previous UNION emitted always-positive
--                   investment_usd on both legs, so SUM(amount_usd) counted
--                   every dollar of gross turnover twice instead of netting
--                   to realized P&L. Now SUM(amount_usd) per account equals
--                   realized_pnl minus still-open investment — i.e. the
--                   reconciliation-friendly delta used in test 4 of the
--                   W2 smoke test.)
--   pnl_usd       — realized pnl for closes (NULL on opens)
--   outcome       — 'OPEN' | 'WIN' | 'LOSS' | 'SCRATCHED' (NULL on opens)
--   at_timestamp  — DATETIME when the event happened
--   ref_id        — source row id for debugging
-- paper_signals has no direct account_id — we join through paper_strategies.
--
-- codex F6 — gate the CREATE VIEW on both `paper_strategies` and
-- `paper_signals` existing. Fresh local clones / new staging environments
-- that haven't run `ensureSchema()` yet will skip the view; the application's
-- migrations.ts path creates the dependent tables first, so VIEW creation
-- works there. Re-running this file after the tables exist picks it up.
SET @strat_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_strategies'
);
SET @sig_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_signals'
);
SET @sql := IF(@strat_exists > 0 AND @sig_exists > 0,
  CONCAT(
    'CREATE OR REPLACE VIEW v_paper_account_activity AS ',
    'SELECT t.account_id AS account_id, ''trade'' AS source, ''TRADE_OPEN'' AS event_type, ',
           't.symbol AS symbol, -CAST(t.investment_usd AS DECIMAL(18,6)) AS amount_usd, ',
           'NULL AS pnl_usd, ''OPEN'' AS outcome, t.created_at AS at_timestamp, t.id AS ref_id ',
    'FROM paper_trades t ',
    'UNION ALL ',
    'SELECT t.account_id, ''trade'', ''TRADE_CLOSE'', t.symbol, ',
           'CAST(t.investment_usd + COALESCE(t.pnl_usd, 0) AS DECIMAL(18,6)), t.pnl_usd, ',
           'CASE WHEN t.pnl_usd > 0 THEN ''WIN'' WHEN t.pnl_usd < 0 THEN ''LOSS'' ELSE ''SCRATCHED'' END, ',
           'CAST(t.sell_date AS DATETIME), t.id ',
    'FROM paper_trades t WHERE t.status = ''CLOSED'' AND t.sell_date IS NOT NULL ',
    'UNION ALL ',
    'SELECT s.account_id, ''signal'', ''SIGNAL_ENTRY'', sig.symbol, ',
           '-CAST(sig.investment_usd AS DECIMAL(18,6)), NULL, ''OPEN'', ',
           'COALESCE(sig.entry_at, sig.generated_at), sig.id ',
    'FROM paper_signals sig JOIN paper_strategies s ON s.id = sig.strategy_id ',
    'WHERE s.account_id IS NOT NULL ',
    'UNION ALL ',
    'SELECT s.account_id, ''signal'', ''SIGNAL_EXIT'', sig.symbol, ',
           'CAST(sig.investment_usd + COALESCE(sig.pnl_usd, 0) AS DECIMAL(18,6)), sig.pnl_usd, ',
           'CASE WHEN sig.pnl_usd > 0 THEN ''WIN'' WHEN sig.pnl_usd < 0 THEN ''LOSS'' ELSE ''SCRATCHED'' END, ',
           'COALESCE(sig.exit_at, sig.generated_at), sig.id ',
    'FROM paper_signals sig JOIN paper_strategies s ON s.id = sig.strategy_id ',
    'WHERE s.account_id IS NOT NULL AND sig.status IN (''WIN'',''LOSS'',''CLOSED'') AND sig.exit_at IS NOT NULL'
  ),
  'SELECT ''paper_strategies or paper_signals missing — skipping v_paper_account_activity (re-run after ensureSchema)'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'migration-2026-04-21-paper-w2 applied' AS status;
