-- Migration: 2026-04-21 — Paper Trading W1 money correctness
-- Safe to apply repeatedly (idempotent via IF NOT EXISTS / INFORMATION_SCHEMA gates).
-- Only runs against the `paper_accounts` + `paper_orders` tables.
--
-- Changes:
--   1. Adds `paper_accounts.reserved_cash` column — tracks how much of the
--      account's cash is currently held against PENDING LIMIT/STOP BUYs.
--   2. Adds `paper_orders.reserved_amount` column — per-order reservation
--      bookkeeping so we can release it back to cash on cancel/reject.
--
-- Non-destructive: both columns default to 0, existing rows unaffected.
--
-- Post-apply reconciliation for finding #4 (cash/realized-P&L inconsistency
-- on Railway production — `paper_accounts` was never re-loaded during the
-- 2026-04-21 VPS→Railway restore, so Railway's Default account kept
-- cash=100000 even though the restored paper_trades rows summed to
-- +$30.71 realized P&L). After applying this migration, run the
-- reconciliation block at the bottom of this file to bring Railway's
-- `paper_accounts.cash` back in line with paper_trades history.

-- ── Column additions ──────────────────────────────────────────────────────

-- paper_accounts.reserved_cash
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_accounts'
    AND COLUMN_NAME  = 'reserved_cash'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE paper_accounts ADD COLUMN reserved_cash DECIMAL(18,6) NOT NULL DEFAULT 0',
  'SELECT ''reserved_cash already present'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- paper_orders.reserved_amount
SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'paper_orders'
    AND COLUMN_NAME  = 'reserved_amount'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE paper_orders ADD COLUMN reserved_amount DECIMAL(18,6) NOT NULL DEFAULT 0',
  'SELECT ''reserved_amount already present'' AS status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Reconciliation: Default account cash drift (finding #4) ───────────────
-- Expected invariant for an account with no OPEN positions:
--   cash = initial_cash + SUM(pnl_usd for CLOSED trades)
-- On Railway production the Default account (id=1) has cash=100000 and
-- 3 CLOSED trades summing to +$30.71 — cash was never credited during the
-- 2026-04-21 restore. Run this block ONLY once, after inspecting the drift:
--
-- SELECT
--   a.id, a.name, a.cash, a.initial_cash,
--   COALESCE(SUM(CASE WHEN t.status='CLOSED' THEN t.pnl_usd END), 0) AS closed_pnl,
--   COALESCE(SUM(CASE WHEN t.status='OPEN' THEN t.investment_usd END), 0) AS open_invested,
--   (a.initial_cash
--      + COALESCE(SUM(CASE WHEN t.status='CLOSED' THEN t.pnl_usd END), 0)
--      - COALESCE(SUM(CASE WHEN t.status='OPEN' THEN t.investment_usd END), 0)
--   ) AS expected_cash,
--   (a.cash -
--      (a.initial_cash
--        + COALESCE(SUM(CASE WHEN t.status='CLOSED' THEN t.pnl_usd END), 0)
--        - COALESCE(SUM(CASE WHEN t.status='OPEN' THEN t.investment_usd END), 0)
--      )
--   ) AS drift_usd
-- FROM paper_accounts a
-- LEFT JOIN paper_trades t ON t.account_id = a.id
-- WHERE a.name = 'Default'
-- GROUP BY a.id;
--
-- If drift is nonzero and the account has no OPEN positions, fix it with:
--
-- UPDATE paper_accounts a
-- LEFT JOIN (
--   SELECT account_id,
--          COALESCE(SUM(CASE WHEN status='CLOSED' THEN pnl_usd END), 0) AS closed_pnl,
--          COALESCE(SUM(CASE WHEN status='OPEN'   THEN investment_usd END), 0) AS open_inv
--     FROM paper_trades
--    GROUP BY account_id
-- ) t ON t.account_id = a.id
-- SET a.cash = a.initial_cash + COALESCE(t.closed_pnl,0) - COALESCE(t.open_inv,0),
--     a.reserved_cash = 0
-- WHERE a.name = 'Default';

SELECT 'migration-2026-04-21-paper-w1 applied' AS status;
