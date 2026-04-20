/**
 * Momentum-carry hypothesis: buy today's top gainers at close,
 * sell next day at morning / midday / evening.
 *
 * Position: $100 per trade, 5x leverage.
 * Dataset: MOVERS-enrolled entries with day_change_pct > 0 and d1_morning present.
 * Take the 50 biggest gainers with full d1 trio.
 */

import { getPool, mysql } from "../src/lib/db";

const POSITION_USD = 100;
const LEVERAGE = 5;

async function main() {
  const pool = await getPool();
  // Prefer MOVERS-source gainers with d1 data. Sort by largest trigger-day move.
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT symbol, cohort_date, direction, day_change_pct, entry_price,
            d1_morning, d1_midday, d1_close
       FROM reversal_entries
      WHERE day_change_pct > 0
        AND entry_price > 0
        AND d1_morning IS NOT NULL
        AND d1_midday IS NOT NULL
        AND d1_close IS NOT NULL
        AND (enrollment_source = 'MOVERS' OR enrollment_source IS NULL)
      ORDER BY day_change_pct DESC
      LIMIT 50`
  );

  console.log(`\n=== Momentum-carry test: LONG top gainers at close, sell next day ===`);
  console.log(`Position $${POSITION_USD} × ${LEVERAGE}x leverage = $${POSITION_USD * LEVERAGE} exposure per trade`);
  console.log(`Sample: top 50 gainers (sorted by trigger-day % gain), all with full d1 data\n`);

  // Header
  const sep = "─".repeat(115);
  console.log(sep);
  console.log(
    [
      "#".padEnd(3),
      "TICKER".padEnd(8),
      "DATE".padEnd(11),
      "TRIGGER".padStart(9),
      "ENTRY$".padStart(9),
      " │ MORNING (open+5)".padEnd(20),
      " │ MIDDAY".padEnd(18),
      " │ EVENING (close)".padEnd(18),
    ].join("")
  );
  console.log(
    [
      "".padEnd(3),
      "".padEnd(8),
      "".padEnd(11),
      "".padStart(9),
      "".padStart(9),
      " │ %       PnL$".padEnd(20),
      " │ %       PnL$".padEnd(18),
      " │ %       PnL$".padEnd(18),
    ].join("")
  );
  console.log(sep);

  let totals = {
    morning: { pnl: 0, wins: 0, losses: 0 },
    midday: { pnl: 0, wins: 0, losses: 0 },
    evening: { pnl: 0, wins: 0, losses: 0 },
  };

  const pnlUsd = (pct: number) => (pct / 100) * POSITION_USD * LEVERAGE;
  const fmtPct = (pct: number) => `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
  const fmtUsd = (usd: number) => `${usd >= 0 ? "+" : ""}$${usd.toFixed(2)}`;
  const mark = (pct: number) => (pct > 0 ? "✓" : pct < 0 ? "✗" : "·");

  rows.forEach((r: any, i: number) => {
    const entry = Number(r.entry_price);
    const mP = ((Number(r.d1_morning) - entry) / entry) * 100;
    const dP = ((Number(r.d1_midday) - entry) / entry) * 100;
    const eP = ((Number(r.d1_close) - entry) / entry) * 100;

    const mUsd = pnlUsd(mP);
    const dUsd = pnlUsd(dP);
    const eUsd = pnlUsd(eP);

    totals.morning.pnl += mUsd;
    totals.midday.pnl += dUsd;
    totals.evening.pnl += eUsd;
    if (mP > 0) totals.morning.wins++;
    else totals.morning.losses++;
    if (dP > 0) totals.midday.wins++;
    else totals.midday.losses++;
    if (eP > 0) totals.evening.wins++;
    else totals.evening.losses++;

    console.log(
      [
        String(i + 1).padEnd(3),
        r.symbol.padEnd(8),
        String(r.cohort_date).slice(0, 10).padEnd(11),
        fmtPct(Number(r.day_change_pct)).padStart(9),
        `$${entry.toFixed(2)}`.padStart(9),
        ` │ ${mark(mP)} ${fmtPct(mP).padStart(7)} ${fmtUsd(mUsd).padStart(8)}`,
        ` │ ${mark(dP)} ${fmtPct(dP).padStart(7)} ${fmtUsd(dUsd).padStart(8)}`,
        ` │ ${mark(eP)} ${fmtPct(eP).padStart(7)} ${fmtUsd(eUsd).padStart(8)}`,
      ].join("")
    );
  });

  console.log(sep);
  const n = rows.length;
  const line = (label: string, t: { pnl: number; wins: number; losses: number }) => {
    const wr = ((t.wins / n) * 100).toFixed(0);
    const avgUsd = t.pnl / n;
    const avgPct = (t.pnl / (POSITION_USD * n)) * 100;
    console.log(
      `${label.padEnd(26)}│ WR ${wr}% (${t.wins}W/${t.losses}L) │ avg ${fmtUsd(avgUsd)} (${fmtPct(avgPct)}) │ TOTAL ${fmtUsd(t.pnl)}`
    );
  };
  console.log("\nAGGREGATE (50 trades × $100 capital × 5x lev = $5000 deployed per exit)");
  line("SELL at MORNING (open+5)", totals.morning);
  line("SELL at MIDDAY", totals.midday);
  line("SELL at EVENING (close)", totals.evening);
  console.log();

  // Verdict
  const best = [
    { name: "Morning", pnl: totals.morning.pnl },
    { name: "Midday", pnl: totals.midday.pnl },
    { name: "Evening", pnl: totals.evening.pnl },
  ].sort((a, b) => b.pnl - a.pnl)[0];
  console.log(`Best exit time: ${best.name.toUpperCase()} with ${fmtUsd(best.pnl)} on $5000 total deployed.`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
