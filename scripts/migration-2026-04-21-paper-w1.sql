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
-- ── M1 codex finding — reconciliation is NOT run automatically ────────────
-- This migration DOES NOT perform any reconciliation UPDATE. An earlier draft
-- included an unconditional `SET cash = initial_cash + SUM(pnl) ...` which
-- would have corrupted live state on any re-run once real reservations or
-- open positions exist. All reconciliation SQL in this file is COMMENTED OUT
-- and documented as a manual one-shot procedure. Operators should execute
-- the inspection SELECT first, confirm the drift is purely a data-restore
-- artefact (no OPEN positions, no PENDING reservations), and only then copy
-- the UPDATE into a MySQL shell by hand. The long-term home for any
-- repeatable reconcile logic is `scripts/reconcile-paper-accounts.sql`
-- (to be created when we need it) — never this forward-schema migration.

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
