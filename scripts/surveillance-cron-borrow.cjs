/**
 * Stand-alone borrow-cost accrual — mirror of `jobAccrueBorrowCost` in
 * `scripts/surveillance-cron.ts`, extracted as CommonJS so the smoke-test
 * runner (plain `node`, no tsx) can drive it directly without bootstrapping
 * the whole cron scheduler. The TS version remains the one the production
 * cron calls; this file is a load-bearing test double.
 *
 * Keeping the logic in one spot is tempting but the prod cron is TS + uses
 * its own getPool(); duplicating ~60 lines here avoids a dual compile step
 * for the smoke test. When the logic changes, update BOTH — the pure math
 * is deliberately identical.
 *
 * CODEX ROUND-2 FIXES (2026-04-21):
 *   - Bug #3 — race with concurrent cover. Each short is now processed in
 *     its OWN per-trade transaction that locks both paper_accounts AND
 *     paper_trades[id] FOR UPDATE, re-checks status='OPEN' under the lock,
 *     and skips if the trade was covered between the snapshot SELECT and
 *     the per-trade transaction. Snapshot-then-stale-debit gap is closed.
 *   - Bug #4 — idempotency via `paper_trades.last_borrow_accrued_date`.
 *     Cron computes `days_to_accrue = datediff(target_date, last_date)` —
 *     where `last_date` is `last_borrow_accrued_date` if set, else
 *     `buy_date`. Running the cron twice on the same date yields 0 days
 *     to accrue on the second run → no-op. Atomic update sets
 *     last_borrow_accrued_date = target_date inside the debit transaction.
 *   - Bug #5 — calendar-day accrual (NOT business-day). Real borrow costs
 *     accrue on weekends/holidays too. We use MySQL `DATEDIFF()` for the
 *     span, so a Monday run accruing for a position last-accrued-on-Friday
 *     charges 3 days (Sat+Sun+Mon). Cron schedule itself is weekdays-only;
 *     we don't change that, we just make each run cover the full weekend.
 *   - Bug #6 — partial-day accrual on cover is NOT implemented (documented
 *     limitation). The borrow cron runs end-of-day weekday; positions
 *     covered intraday before that day's run miss the final day's accrual.
 *     MVP acceptable — daily granularity only. When intraday accrual is
 *     wanted, hook into the `BUY_TO_COVER` path in paper-fill.ts and catch
 *     up `today − last_borrow_accrued_date` days atomically with the cover.
 */

async function jobAccrueBorrowCost(pool, opts = {}) {
  // Target date for accrual = "today" by default, or an explicit ISO-date
  // override (lets the smoke test simulate multi-day gaps deterministically
  // without needing to sleep or advance the system clock).
  const targetDate = opts.targetDate ?? new Date().toISOString().slice(0, 10);

  // Snapshot of currently-open shorts. `last_borrow_accrued_date` is read
  // here but AUTHORITATIVELY re-checked inside each per-trade transaction.
  const [shorts] = await pool.execute(
    `SELECT t.id, t.account_id, t.quantity, t.closed_quantity, t.buy_price,
            t.borrow_daily_rate_pct, t.buy_date, t.last_borrow_accrued_date
       FROM paper_trades t
      WHERE t.status = 'OPEN' AND t.side = 'SHORT'
        AND COALESCE(t.borrow_daily_rate_pct, 0) > 0`
  );
  let debited = 0;
  let skipped = 0;
  let errors = 0;
  let totalUsd = 0;

  for (const snap of shorts) {
    const tradeId = Number(snap.id);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // LOCK STEP 1 — account (canonical order).
      const [acct] = await conn.execute(
        "SELECT id FROM paper_accounts WHERE id = ? FOR UPDATE",
        [snap.account_id]
      );
      if (acct.length === 0) { await conn.rollback(); skipped++; continue; }

      // LOCK STEP 2 — trade row. Re-check status='OPEN' under lock so a
      // cover that committed between the outer SELECT and this tx skips
      // cleanly rather than double-debiting a closed position.
      const [tradeRows] = await conn.execute(
        `SELECT status, quantity, closed_quantity, buy_price,
                borrow_daily_rate_pct, buy_date, last_borrow_accrued_date
           FROM paper_trades WHERE id = ? FOR UPDATE`,
        [tradeId]
      );
      if (tradeRows.length === 0) { await conn.rollback(); skipped++; continue; }
      const t = tradeRows[0];
      if (t.status !== "OPEN") { await conn.rollback(); skipped++; continue; }

      // Days to accrue — calendar days between last-accrued (or buy_date on
      // the first run) and targetDate. Computed in MySQL so the DATE type
      // arithmetic doesn't round-trip through JS timezone math.
      const lastDateRaw = t.last_borrow_accrued_date ?? t.buy_date;
      const [[dd]] = await conn.execute(
        "SELECT DATEDIFF(?, ?) AS days",
        [targetDate, lastDateRaw]
      );
      const daysToAccrue = Math.max(0, Number(dd.days ?? 0));
      if (daysToAccrue <= 0) { await conn.rollback(); skipped++; continue; }

      const qty = Math.max(0, Number(t.quantity) - Number(t.closed_quantity ?? 0));
      const entryPrice = Number(t.buy_price);
      const annualPct = Number(t.borrow_daily_rate_pct);
      const daily = qty * entryPrice * (annualPct / 100) / 365;
      if (!(daily > 0)) { await conn.rollback(); skipped++; continue; }
      const accrual = daily * daysToAccrue;

      // Atomic cash debit with underflow guard (shared invariant with
      // paper-fill: cash never goes negative).
      const [debitRes] = await conn.execute(
        "UPDATE paper_accounts SET cash = cash - ? WHERE id = ? AND cash >= ?",
        [accrual, snap.account_id, accrual]
      );
      if (debitRes.affectedRows !== 1) { await conn.rollback(); errors++; continue; }

      // Record last_borrow_accrued_date atomically with the debit so a crash
      // between the two UPDATEs can't leave the position debited but
      // idempotency-unmarked (which would cause a re-run to double-debit).
      const [markRes] = await conn.execute(
        "UPDATE paper_trades SET last_borrow_accrued_date = ? WHERE id = ? AND status = 'OPEN'",
        [targetDate, tradeId]
      );
      if (markRes.affectedRows !== 1) { await conn.rollback(); errors++; continue; }

      await conn.commit();
      debited++;
      totalUsd += accrual;
    } catch (err) {
      try { await conn.rollback(); } catch { /* ignore */ }
      errors++;
    } finally {
      conn.release();
    }
  }
  return { shorts: shorts.length, debited, skipped, errors, totalUsd };
}

module.exports = { jobAccrueBorrowCost };
