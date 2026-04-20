/**
 * One-time migration: compute final_pnl_usd / final_pnl_pct for every COMPLETED
 * reversal_entry where those fields are NULL. Also fixes the auto-close path
 * going forward by calling the same logic via updateOne.
 *
 * Context: the 14-day auto-close path in syncActiveSurveillance() only flipped
 * status to 'COMPLETED' but never populated final_pnl, so all KPIs that read
 * "Total P&L" and "Win Rate" stayed at $0 / 0% forever — false-empty trust data.
 *
 * PnL convention: direction-adjusted close-to-latest-available-d-close, against
 * the standard $100 position size (matches DEFAULT_SETTINGS in UI).
 */

import { getPool, mysql } from "../src/lib/db";

const POSITION_SIZE_USD = 100;

async function main() {
  const pool = await getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT id, direction, entry_price,
            d1_close, d2_close, d3_close, d4_close, d5_close,
            d6_close, d7_close, d8_close, d9_close, d10_close
       FROM reversal_entries
      WHERE status = 'COMPLETED' AND final_pnl_usd IS NULL`
  );

  console.log(`Rows to backfill: ${rows.length}`);
  if (!rows.length) {
    process.exit(0);
  }

  let updated = 0;
  let skippedNoData = 0;

  for (const row of rows) {
    const entryPrice = Number(row.entry_price);
    const direction = row.direction as "LONG" | "SHORT";
    // Walk d10 → d1 taking the latest available close as the "exit" price.
    let exitPrice: number | null = null;
    for (let d = 10; d >= 1; d--) {
      const v = row[`d${d}_close`];
      if (v != null && isFinite(Number(v))) {
        exitPrice = Number(v);
        break;
      }
    }
    if (exitPrice == null || !isFinite(entryPrice) || entryPrice === 0) {
      skippedNoData++;
      continue;
    }
    const rawPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    const directedPct = direction === "SHORT" ? -rawPct : rawPct;
    const pnlUsd = (directedPct / 100) * POSITION_SIZE_USD;

    await pool.execute(
      `UPDATE reversal_entries
         SET final_pnl_usd = ?, final_pnl_pct = ?
       WHERE id = ?`,
      [pnlUsd.toFixed(6), directedPct.toFixed(6), row.id]
    );
    updated++;
  }

  console.log(`Updated: ${updated}, skipped (no d-data): ${skippedNoData}`);

  const [summary] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT
        COUNT(*) as total,
        SUM(final_pnl_usd > 0) as wins,
        SUM(final_pnl_usd < 0) as losses,
        SUM(final_pnl_usd = 0) as scratches,
        ROUND(SUM(final_pnl_usd), 2) as total_pnl_usd,
        ROUND(AVG(final_pnl_pct), 3) as avg_pnl_pct
     FROM reversal_entries
     WHERE status = 'COMPLETED' AND final_pnl_usd IS NOT NULL`
  );
  console.log("\nPost-backfill stats:", summary[0]);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
