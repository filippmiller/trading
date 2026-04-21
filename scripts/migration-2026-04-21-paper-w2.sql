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
-- so deleting a strategy doesn't cascade-destroy historical trade P&L.
SET @fk_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_trades'
    AND CONSTRAINT_NAME = 'FK_paper_trades_strategy'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE paper_trades ADD CONSTRAINT FK_paper_trades_strategy FOREIGN KEY (strategy_id) REFERENCES paper_strategies(id) ON DELETE SET NULL',
  'SELECT ''FK_paper_trades_strategy already present'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── v_paper_account_activity VIEW ────────────────────────────────────────
-- Unified event stream UNIONing paper_trades + paper_signals. Columns:
--   account_id    — owner account
--   source        — 'trade' or 'signal' (provenance)
--   event_type    — 'BUY' | 'SELL' | 'SIGNAL_ENTRY' | 'SIGNAL_EXIT'
--   symbol        — ticker
--   amount_usd    — signed investment (positive on open, negative on close)
--   pnl_usd       — realized pnl for closes (NULL on opens)
--   at_timestamp  — DATETIME when the event happened
--   ref_id        — source row id for debugging
-- paper_signals has no direct account_id — we join through paper_strategies.
CREATE OR REPLACE VIEW v_paper_account_activity AS
  SELECT
    t.account_id                                   AS account_id,
    'trade'                                        AS source,
    CASE WHEN t.status = 'CLOSED' THEN 'SELL' ELSE 'BUY' END AS event_type,
    t.symbol                                       AS symbol,
    CAST(t.investment_usd AS DECIMAL(18,6))        AS amount_usd,
    t.pnl_usd                                      AS pnl_usd,
    CASE WHEN t.status = 'CLOSED' AND t.sell_date IS NOT NULL
         THEN CAST(t.sell_date AS DATETIME)
         ELSE t.created_at END                     AS at_timestamp,
    t.id                                           AS ref_id
  FROM paper_trades t
  UNION ALL
  SELECT
    s.account_id                                   AS account_id,
    'signal'                                       AS source,
    CASE WHEN sig.status = 'CLOSED' THEN 'SIGNAL_EXIT' ELSE 'SIGNAL_ENTRY' END AS event_type,
    sig.symbol                                     AS symbol,
    CAST(sig.investment_usd AS DECIMAL(18,6))      AS amount_usd,
    sig.pnl_usd                                    AS pnl_usd,
    COALESCE(sig.exit_at, sig.entry_at, sig.generated_at) AS at_timestamp,
    sig.id                                         AS ref_id
  FROM paper_signals sig
  JOIN paper_strategies s ON s.id = sig.strategy_id
  WHERE s.account_id IS NOT NULL;

SELECT 'migration-2026-04-21-paper-w2 applied' AS status;
