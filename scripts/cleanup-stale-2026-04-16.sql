-- Cleanup stale 4/16 data that was enrolled pre-market (00:35-00:38 AM ET Thursday)
-- using Wednesday's close data, with cohort_date incorrectly set to 4/16.
-- This blocks the legitimate 9:45 AM Thursday enrollment via idempotency.

-- Step 1: Identify affected paper_signals from the stale 4/16 enrollment
-- Only target signals with generated_at before 9:00 AM Thursday (the stale ones)
-- and whose underlying reversal_entry is from 4/16.

-- Refund cash for all stale EXECUTED signals
UPDATE paper_accounts a
JOIN paper_strategies s ON s.account_id = a.id
JOIN paper_signals ps ON ps.strategy_id = s.id
JOIN reversal_entries re ON ps.reversal_entry_id = re.id
SET a.cash = a.cash + ps.investment_usd
WHERE re.cohort_date = '2026-04-16'
  AND re.created_at < '2026-04-16 09:00:00'
  AND ps.status = 'EXECUTED'
  AND ps.exit_at IS NULL;

-- Mark stale signals as CANCELED (preserve history for audit, but won't count in win/loss)
UPDATE paper_signals ps
JOIN reversal_entries re ON ps.reversal_entry_id = re.id
SET ps.status = 'CANCELED',
    ps.exit_at = CURRENT_TIMESTAMP(6),
    ps.exit_reason = 'STALE_ENROLLMENT_CLEANUP',
    ps.pnl_usd = 0,
    ps.pnl_pct = 0
WHERE re.cohort_date = '2026-04-16'
  AND re.created_at < '2026-04-16 09:00:00'
  AND ps.status = 'EXECUTED';

-- Delete stale reversal_entries (all 4/16 entries created before 9 AM Thursday)
DELETE FROM reversal_entries
WHERE cohort_date = '2026-04-16'
  AND created_at < '2026-04-16 09:00:00';

-- Verification query
SELECT 'Remaining 4/16 entries' as info, COUNT(*) as count FROM reversal_entries WHERE cohort_date = '2026-04-16';
SELECT 'Canceled signals' as info, COUNT(*) as count FROM paper_signals WHERE exit_reason = 'STALE_ENROLLMENT_CLEANUP';
SELECT 'Strategy cash totals after refund' as info, COUNT(*) as n_strategies, SUM(cash) as total_cash FROM paper_accounts WHERE name LIKE 'Strategy:%';
