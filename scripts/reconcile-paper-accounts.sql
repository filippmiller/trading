-- Reconciliation queries for paper trading accounts.
-- READ-ONLY: every statement is a SELECT. No UPDATEs, no DELETEs.
-- Apply ad-hoc from a MySQL shell. Intended home for the reconciliation
-- promised by W1's M1 codex finding — forward-schema migrations never
-- mutate live data.
--
-- W4 round-3 SIDE-AWARE reconciliation invariant per account:
--   cash + reserved_cash + reserved_short_margin
--     + SUM(open LONG investment_usd + slippage_usd + commission_usd)
--     + SUM(open SHORT commission_usd)
--     + SUM(open signal investment_usd)       -- signals are LONG + zero-cost
--     + SUM(closed trade commission_usd)
--   ==
--   initial_cash + SUM(closed trade pnl_usd) + SUM(closed signal pnl_usd)
--
-- LONG OPEN contributes investment + slippage + commission (all three were
-- separate cash debits on the open leg). SHORT OPEN contributes commission
-- ONLY: the nominal investment lives in reserved_short_margin (= adj*qty,
-- slightly under-nominal by the open-leg slippage, which is baked into the
-- margin rather than being a separate cash debit). Closed-leg slippage for
-- either side is already reflected in pnl_usd via the adjustedPrice used on
-- the cover/close leg, so it is NOT added to LHS.
--
-- paper_trades and paper_signals are TWO SEPARATE cash streams that both
-- write to paper_accounts.cash. A drift in the invariant is usually one of:
--   (a) A fill that debited cash but failed to INSERT the trade row (pre-W1)
--   (b) A data restore where cash was restored but trades were not
--   (c) A cross-system leak (a signal exit credited cash but its EXECUTED row
--       was never updated to CLOSED, or vice versa)
--   (d) Pre-round-3 shorts whose investment_usd was stored as adj*qty
--       (round-2 artefact). Drift ≈ +sum(slippage_usd on SHORT OPEN trades).

-- ── Q1: Per-account summary across both streams ───────────────────────────
SELECT
  a.id,
  a.name,
  ROUND(a.cash, 2)                              AS cash,
  ROUND(a.reserved_cash, 2)                     AS reserved_cash,
  ROUND(a.reserved_short_margin, 2)             AS reserved_short_margin,
  ROUND(a.initial_cash, 2)                      AS initial_cash,
  (SELECT COALESCE(SUM(investment_usd),0) FROM paper_trades WHERE account_id=a.id AND status='OPEN' AND side='LONG')  AS long_open_invested,
  (SELECT COALESCE(SUM(slippage_usd),0)   FROM paper_trades WHERE account_id=a.id AND status='OPEN' AND side='LONG')  AS long_open_slippage,
  (SELECT COALESCE(SUM(commission_usd),0) FROM paper_trades WHERE account_id=a.id AND status='OPEN' AND side='LONG')  AS long_open_commission,
  (SELECT COALESCE(SUM(commission_usd),0) FROM paper_trades WHERE account_id=a.id AND status='OPEN' AND side='SHORT') AS short_open_commission,
  (SELECT COALESCE(SUM(commission_usd),0) FROM paper_trades WHERE account_id=a.id AND status='CLOSED')                AS trades_closed_commission,
  (SELECT COALESCE(SUM(pnl_usd),0)        FROM paper_trades WHERE account_id=a.id AND status='CLOSED')                AS trades_closed_pnl,
  (SELECT COALESCE(SUM(sig.investment_usd),0)
     FROM paper_signals sig JOIN paper_strategies s ON s.id=sig.strategy_id
     WHERE s.account_id=a.id AND sig.status='EXECUTED' AND sig.exit_at IS NULL) AS signals_open_invested,
  (SELECT COALESCE(SUM(sig.pnl_usd),0)
     FROM paper_signals sig JOIN paper_strategies s ON s.id=sig.strategy_id
     WHERE s.account_id=a.id AND sig.status='CLOSED')                            AS signals_closed_pnl
FROM paper_accounts a
ORDER BY a.id;

-- ── Q2: Side-aware invariant drift per account ───────────────────────────
-- Expected: drift ≈ 0. Tolerance = 1e-6 (DECIMAL(18,6) rounding).
SELECT
  a.id,
  a.name,
  ROUND(
    (a.cash + a.reserved_cash + a.reserved_short_margin
      -- LONG open: full three-part contribution (inv + slip + comm).
      + (SELECT COALESCE(SUM(investment_usd + slippage_usd + commission_usd),0)
           FROM paper_trades WHERE account_id=a.id AND status='OPEN' AND side='LONG')
      -- SHORT open: commission only (investment lives in reserved_short_margin).
      + (SELECT COALESCE(SUM(commission_usd),0)
           FROM paper_trades WHERE account_id=a.id AND status='OPEN' AND side='SHORT')
      -- Closed trades: commission only (slippage is inside pnl_usd already).
      + (SELECT COALESCE(SUM(commission_usd),0)
           FROM paper_trades WHERE account_id=a.id AND status='CLOSED')
      -- Signals: legacy zero-cost LONG. Treat like LONG investment only.
      + (SELECT COALESCE(SUM(sig.investment_usd),0)
           FROM paper_signals sig JOIN paper_strategies s ON s.id=sig.strategy_id
           WHERE s.account_id=a.id AND sig.status='EXECUTED' AND sig.exit_at IS NULL)
    ) -
    (a.initial_cash
      + (SELECT COALESCE(SUM(pnl_usd),0) FROM paper_trades WHERE account_id=a.id AND status='CLOSED')
      + (SELECT COALESCE(SUM(sig.pnl_usd),0)
           FROM paper_signals sig JOIN paper_strategies s ON s.id=sig.strategy_id
           WHERE s.account_id=a.id AND sig.status='CLOSED')
    ),
    6
  ) AS drift_usd
FROM paper_accounts a
ORDER BY ABS(drift_usd) DESC;

-- ── Q3: Activity stream — last 50 events via the unified view ─────────────
-- Uses the v_paper_account_activity VIEW defined in migration-2026-04-21-paper-w2.sql.
-- If this errors with "view does not exist" the migration hasn't been applied.
SELECT
  account_id,
  source,
  event_type,
  symbol,
  ROUND(amount_usd, 2)  AS amount_usd,
  ROUND(pnl_usd, 2)     AS pnl_usd,
  at_timestamp,
  ref_id
FROM v_paper_account_activity
ORDER BY at_timestamp DESC
LIMIT 50;

-- ── Q4: Dangling orders that claim reservation but account disagrees ─────
-- An order with reserved_amount > 0 should have account.reserved_cash >= that
-- amount. If this query returns rows, W1's reservation accounting drifted.
SELECT
  o.id             AS order_id,
  o.account_id,
  o.symbol,
  o.status,
  o.reserved_amount,
  a.reserved_cash,
  (a.reserved_cash - o.reserved_amount) AS shortfall
FROM paper_orders o
JOIN paper_accounts a ON a.id = o.account_id
WHERE o.status = 'PENDING'
  AND o.reserved_amount > 0
  AND a.reserved_cash < o.reserved_amount
ORDER BY shortfall;

-- ── Q5: OPEN trades with NULL strategy_id (pre-W2 rows) ──────────────────
-- Informational only — legacy rows will stay NULL. We do NOT reverse-parse
-- the "MARKET BUY" VARCHAR into a strategy_id (lossy + destructive).
SELECT
  COUNT(*) AS legacy_no_fk,
  SUM(CASE WHEN strategy LIKE 'MARKET %' THEN 1 ELSE 0 END)  AS tagged_market,
  SUM(CASE WHEN strategy LIKE 'LIMIT %'  THEN 1 ELSE 0 END)  AS tagged_limit,
  SUM(CASE WHEN strategy LIKE 'STOP %'   THEN 1 ELSE 0 END)  AS tagged_stop,
  SUM(CASE WHEN strategy LIKE 'MANUAL %' THEN 1 ELSE 0 END)  AS tagged_manual
FROM paper_trades
WHERE strategy_id IS NULL;
