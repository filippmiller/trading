/**
 * Stand-alone borrow-cost accrual — mirror of `jobAccrueBorrowCost` in
 * `scripts/surveillance-cron.ts`, extracted as CommonJS so the smoke-test
 * runner (plain `node`, no tsx) can drive it directly without bootstrapping
 * the whole cron scheduler. The TS version remains the one the production
 * cron calls; this file is a load-bearing test double.
 *
 * Keeping the logic in one spot is tempting but the prod cron is TS + uses
 * its own getPool(); duplicating ~30 lines here avoids a dual compile step
 * for the smoke test. When the logic changes, update BOTH — the pure math
 * is deliberately identical.
 */

async function jobAccrueBorrowCost(pool) {
  const [shorts] = await pool.execute(
    `SELECT t.id, t.account_id, t.quantity, t.closed_quantity, t.buy_price, t.borrow_daily_rate_pct
       FROM paper_trades t
      WHERE t.status = 'OPEN' AND t.side = 'SHORT'
        AND COALESCE(t.borrow_daily_rate_pct, 0) > 0`
  );
  let debited = 0;
  let errors = 0;
  let totalUsd = 0;
  for (const row of shorts) {
    const qty = Math.max(0, Number(row.quantity) - Number(row.closed_quantity ?? 0));
    const entryPrice = Number(row.buy_price);
    const annualPct = Number(row.borrow_daily_rate_pct);
    const daily = qty * entryPrice * (annualPct / 100) / 365;
    if (!(daily > 0)) continue;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [acct] = await conn.execute(
        "SELECT id FROM paper_accounts WHERE id = ? FOR UPDATE",
        [row.account_id]
      );
      if (acct.length === 0) { await conn.rollback(); continue; }
      const [debitRes] = await conn.execute(
        "UPDATE paper_accounts SET cash = cash - ? WHERE id = ?",
        [daily, row.account_id]
      );
      if (debitRes.affectedRows !== 1) { await conn.rollback(); errors++; continue; }
      await conn.commit();
      debited++;
      totalUsd += daily;
    } catch (err) {
      try { await conn.rollback(); } catch { /* ignore */ }
      errors++;
    } finally {
      conn.release();
    }
  }
  return { shorts: shorts.length, debited, errors, totalUsd };
}

module.exports = { jobAccrueBorrowCost };
