/**
 * Ad-hoc analysis: test "delayed entry" hypothesis.
 *
 * Hypothesis: instead of shorting at the close of the trigger day (delay=0),
 * wait N days and short at the d_{N}_close — some momentum squeezes keep
 * running for 1-2 more days before reverting. A later entry = higher entry
 * price for shorts = more profit when it finally reverts.
 *
 * Buckets by consecutive_days (streak length) to see if the edge depends on
 * how extended the move already was at entry.
 */

import { getPool, mysql } from "../src/lib/db";

async function main() {
  const pool = await getPool();
  // Include ACTIVE rows too — that's where the long-streak (XNDU-like) setups live.
  // ACTIVE trades still have open d-windows, so PnL is partial (based on latest
  // available d_close). We filter out rows that don't have enough data for the
  // chosen delay to be meaningful.
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT symbol, cohort_date, direction, consecutive_days, status, entry_price,
            d1_close, d2_close, d3_close, d4_close, d5_close,
            d6_close, d7_close, d8_close, d9_close, d10_close
       FROM reversal_entries
      WHERE entry_price > 0`
  );

  const latestClose = (r: any): number | null => {
    for (let d = 10; d >= 1; d--) {
      const v = r[`d${d}_close`];
      if (v != null) return Number(v);
    }
    return null;
  };

  const computePnl = (r: any, delay: number): number | null => {
    const dir = r.direction as "LONG" | "SHORT";
    let entry: number | null;
    if (delay === 0) {
      entry = Number(r.entry_price);
    } else {
      const v = r[`d${delay}_close`];
      if (v == null) return null;
      entry = Number(v);
    }
    if (!isFinite(entry) || entry === 0) return null;
    const exit = latestClose(r);
    if (exit == null || exit === entry) return null;
    const rawPct = ((exit - entry) / entry) * 100;
    return dir === "SHORT" ? -rawPct : rawPct;
  };

  const summarize = (rs: any[], delay: number) => {
    const pnls = rs.map((r) => computePnl(r, delay)).filter((p) => p != null) as number[];
    if (!pnls.length) return null;
    const wins = pnls.filter((p) => p > 0).length;
    const avg = pnls.reduce((s, p) => s + p, 0) / pnls.length;
    const total = pnls.reduce((s, p) => s + p, 0);
    return { n: pnls.length, wr: (wins / pnls.length) * 100, avg, total };
  };

  const fmtRow = (label: string, s: { n: number; wr: number; avg: number; total: number } | null) => {
    if (!s) return `  ${label}  —`;
    const sign = (x: number) => (x >= 0 ? "+" : "");
    return `  ${label}  ${String(s.n).padStart(3)}  ${s.wr.toFixed(1).padStart(5)}%   ${sign(s.avg)}${s.avg.toFixed(2).padStart(6)}   ${sign(s.total)}${s.total.toFixed(1).padStart(7)}`;
  };

  const buckets: Record<string, any[]> = { "1": [], "2": [], "3": [], "4+": [] };
  for (const r of rows) {
    const cd = Number(r.consecutive_days ?? 0);
    const key = cd >= 4 ? "4+" : String(cd);
    if (buckets[key]) buckets[key].push(r);
  }

  const active = rows.filter((r: any) => r.status === "ACTIVE");
  const completed = rows.filter((r: any) => r.status === "COMPLETED");
  console.log(`=== Delayed-entry hypothesis test ===`);
  console.log(`${rows.length} rows total: ${completed.length} COMPLETED (full window), ${active.length} ACTIVE (partial window)`);
  console.log("(PnL direction-adjusted, $100 position, costs excluded)\n");

  console.log("\n--- COMPLETED only, by streak (legacy: all have streak=1, no multi-day data) ---");
  for (const [bucket, rs] of Object.entries(buckets)) {
    const completedInBucket = rs.filter((r: any) => r.status === "COMPLETED");
    if (!completedInBucket.length) continue;
    console.log(`\nStreak = ${bucket} (${completedInBucket.length} COMPLETED)`);
    console.log("  Delay  N    WinR    AvgPnL%   TotPnL$");
    for (const delay of [0, 1, 2, 3]) {
      console.log(fmtRow(`${delay}d`, summarize(completedInBucket, delay)));
    }
  }

  console.log("\n\n--- ALL rows (incl ACTIVE with partial windows), by streak ---");
  for (const [bucket, rs] of Object.entries(buckets)) {
    if (!rs.length) continue;
    console.log(`\nStreak = ${bucket} (${rs.length} rows)`);
    console.log("  Delay  N    WinR    AvgPnL%   TotPnL$");
    for (const delay of [0, 1, 2, 3]) {
      console.log(fmtRow(`${delay}d`, summarize(rs, delay)));
    }
  }

  console.log("\n\n--- XNDU-like: SHORTS with streak ≥ 3 (extended rally, bet on revert) ---");
  const xnduLike = rows.filter((r: any) => r.direction === "SHORT" && Number(r.consecutive_days ?? 0) >= 3);
  console.log(`${xnduLike.length} trades (mostly ACTIVE — partial windows)`);
  console.log("  Delay  N    WinR    AvgPnL%   TotPnL$");
  for (const delay of [0, 1, 2, 3]) {
    console.log(fmtRow(`${delay}d`, summarize(xnduLike, delay)));
  }

  console.log("\n\n--- Mirror: LONGS with streak ≥ 3 (extended decline, bet on bounce) ---");
  const longStreak = rows.filter((r: any) => r.direction === "LONG" && Number(r.consecutive_days ?? 0) >= 3);
  console.log(`${longStreak.length} trades`);
  console.log("  Delay  N    WinR    AvgPnL%   TotPnL$");
  for (const delay of [0, 1, 2, 3]) {
    console.log(fmtRow(`${delay}d`, summarize(longStreak, delay)));
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
