/**
 * Strategy grid search for the MOVERS dataset.
 *
 * Answers in one script, three questions:
 *   (A) BASIC GRID — hold {1,2,3,5} × exit {morning, midday, close}
 *       — pure entry-exit, no stops. Which hold duration + exit time maximises edge?
 *   (B) STOPS GRID — hold=1-day-close fixed, vary SL × TP × trailing
 *       — do stops improve the raw 1-day carry, or hurt it?
 *   (C) MIRROR — same (A) and (B) but applied to LOSERS (bet on bounce)
 *
 * Sample: deduplicated by ticker (keep most recent cohort per symbol).
 * Position: $100 × 5× leverage. PnL % in the tables is "return on capital".
 *
 * What's NOT here (faith / limits worth stating):
 *   - Intraday resolution is only M/D/E per day (3 ticks). Trailing stops
 *     evaluated on those 3 ticks × hold_days bars — not true tick-by-tick.
 *   - Commissions & borrow excluded (this is the gross edge probe).
 *   - Sample is concentrated in quantum/biotech/semi names (one month of data).
 */

import { getPool, mysql } from "../src/lib/db";

const CAPITAL_USD = 100;
const LEVERAGE = 5;
const EXPOSURE = CAPITAL_USD * LEVERAGE;

type Row = {
  symbol: string;
  cohort_date: string;
  direction: "LONG" | "SHORT";
  day_change_pct: number;
  entry_price: number;
  bars: (number | null)[]; // [d1_m, d1_d, d1_e, d2_m, ...] length 30
};

async function loadData(): Promise<Row[]> {
  const pool = await getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT symbol, cohort_date, direction, day_change_pct, entry_price,
            d1_morning, d1_midday, d1_close,
            d2_morning, d2_midday, d2_close,
            d3_morning, d3_midday, d3_close,
            d4_morning, d4_midday, d4_close,
            d5_morning, d5_midday, d5_close,
            d6_morning, d6_midday, d6_close,
            d7_morning, d7_midday, d7_close,
            d8_morning, d8_midday, d8_close,
            d9_morning, d9_midday, d9_close,
            d10_morning, d10_midday, d10_close
       FROM reversal_entries
      WHERE entry_price > 0 AND d1_morning IS NOT NULL`
  );
  const parsed = rows.map((r: any): Row => {
    const bars: (number | null)[] = [];
    for (let d = 1; d <= 10; d++) {
      for (const t of ["morning", "midday", "close"] as const) {
        const v = r[`d${d}_${t}`];
        bars.push(v == null ? null : Number(v));
      }
    }
    return {
      symbol: r.symbol,
      cohort_date: new Date(r.cohort_date).toISOString().slice(0, 10),
      direction: r.direction,
      day_change_pct: Number(r.day_change_pct),
      entry_price: Number(r.entry_price),
      bars,
    };
  });
  // Dedupe by ticker — keep most recent cohort
  const byTicker = new Map<string, Row>();
  for (const r of parsed.sort((a, b) => a.cohort_date.localeCompare(b.cohort_date))) {
    byTicker.set(r.symbol, r); // latest wins
  }
  return [...byTicker.values()];
}

// index into bars[]: day in 1..10, time in {morning=0, midday=1, close=2}
const idx = (day: number, time: 0 | 1 | 2) => (day - 1) * 3 + time;
const TIME_NAMES = ["morning", "midday", "close"] as const;

/** Simple entry-exit PnL, no stops. Returns PnL% on capital (5× leverage baked in). */
function simplePnlPct(row: Row, holdDay: number, exitTime: 0 | 1 | 2, side: "LONG" | "SHORT"): number | null {
  const exit = row.bars[idx(holdDay, exitTime)];
  if (exit == null) return null;
  const rawPct = ((exit - row.entry_price) / row.entry_price) * 100;
  const directed = side === "SHORT" ? -rawPct : rawPct;
  return directed * LEVERAGE;
}

/**
 * PnL with SL/TP/trailing on bar-by-bar simulation (M/D/E ticks).
 * slPct/tpPct are from entry (directed). trailPct is % off the peak favorable move.
 * Exit rules, checked in order per bar: stop-loss, take-profit, trailing-stop, then time-out.
 */
function pnlWithStops(
  row: Row,
  side: "LONG" | "SHORT",
  opts: { maxHoldDays: number; slPct?: number; tpPct?: number; trailPct?: number }
): number | null {
  const sign = side === "SHORT" ? -1 : 1;
  let bestDirected = 0;
  for (let d = 1; d <= opts.maxHoldDays; d++) {
    for (let t = 0 as 0 | 1 | 2; t < 3; t = (t + 1) as 0 | 1 | 2) {
      const p = row.bars[idx(d, t)];
      if (p == null) continue;
      const rawPct = ((p - row.entry_price) / row.entry_price) * 100;
      const directed = sign * rawPct; // positive = favorable for the position
      // Update best for trailing
      if (directed > bestDirected) bestDirected = directed;
      // Stop-loss (loss worse than slPct below entry)
      if (opts.slPct != null && directed <= -Math.abs(opts.slPct)) {
        return directed * LEVERAGE;
      }
      // Take-profit
      if (opts.tpPct != null && directed >= opts.tpPct) {
        return directed * LEVERAGE;
      }
      // Trailing stop: exit if directed drops by trailPct from bestDirected
      if (opts.trailPct != null && bestDirected > 0 && bestDirected - directed >= opts.trailPct) {
        return directed * LEVERAGE;
      }
    }
  }
  // Time-out: exit at last available bar
  for (let d = opts.maxHoldDays; d >= 1; d--) {
    for (let t = 2 as 2 | 1 | 0; t >= 0; t = (t - 1) as 2 | 1 | 0) {
      const p = row.bars[idx(d, t)];
      if (p != null) {
        const rawPct = ((p - row.entry_price) / row.entry_price) * 100;
        return sign * rawPct * LEVERAGE;
      }
    }
  }
  return null;
}

function summarize(pnls: number[]): { n: number; wr: number; avg: number; total: number; best: number; worst: number } | null {
  if (!pnls.length) return null;
  const wins = pnls.filter((p) => p > 0).length;
  const total = pnls.reduce((s, p) => s + p, 0);
  return {
    n: pnls.length,
    wr: (wins / pnls.length) * 100,
    avg: total / pnls.length,
    total,
    best: Math.max(...pnls),
    worst: Math.min(...pnls),
  };
}

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const fmtUsd = (v: number) => `${v >= 0 ? "+" : ""}$${v.toFixed(0)}`;

function fmtRow(label: string, s: ReturnType<typeof summarize>): string {
  if (!s) return `  ${label.padEnd(22)}│  (no data)`;
  const pnlUsd = (s.total * CAPITAL_USD) / 100;
  return `  ${label.padEnd(22)}│ n=${String(s.n).padStart(3)} │ WR ${s.wr.toFixed(0).padStart(3)}% │ avg ${fmtPct(s.avg).padStart(7)} │ total ${fmtUsd(pnlUsd).padStart(7)} │ best ${fmtPct(s.best).padStart(7)} │ worst ${fmtPct(s.worst).padStart(7)}`;
}

async function main() {
  const all = await loadData();
  const gainers = all.filter((r) => r.day_change_pct > 0);
  const losers = all.filter((r) => r.day_change_pct < 0);

  console.log(`\n╔════════════════════════════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║ STRATEGY GRID — MOVERS dataset (deduplicated by ticker, latest cohort per symbol)                  ║`);
  console.log(`║ Position: $${CAPITAL_USD} × ${LEVERAGE}× leverage = $${EXPOSURE} exposure per trade                                        ║`);
  console.log(`║ Sample: ${String(all.length).padStart(3)} unique tickers · ${String(gainers.length).padStart(3)} gainers · ${String(losers.length).padStart(3)} losers                                      ║`);
  console.log(`╚════════════════════════════════════════════════════════════════════════════════════════════════════╝`);

  const runSection = (label: string, universe: Row[], side: "LONG" | "SHORT") => {
    console.log(`\n\n┌── ${label} (${universe.length} tickers, ${side}) ─────────────────────────────────────────────`);

    console.log(`\n(A) Basic hold × exit grid — no stops:`);
    for (const hold of [1, 2, 3, 5, 10]) {
      for (const t of [0, 1, 2] as (0 | 1 | 2)[]) {
        const pnls = universe.map((r) => simplePnlPct(r, hold, t, side)).filter((p) => p != null) as number[];
        console.log(fmtRow(`hold=${hold}d · exit=${TIME_NAMES[t]}`, summarize(pnls)));
      }
      console.log("");
    }

    console.log(`(B) Hold=1 close, vary stops:`);
    for (const sl of [undefined, 3, 5, 10]) {
      for (const tp of [undefined, 5, 10, 20]) {
        const pnls = universe
          .map((r) => pnlWithStops(r, side, { maxHoldDays: 1, slPct: sl, tpPct: tp }))
          .filter((p) => p != null) as number[];
        const label = `SL=${sl ?? "—"}${sl ? "%" : ""} TP=${tp ?? "—"}${tp ? "%" : ""}`;
        console.log(fmtRow(label, summarize(pnls)));
      }
    }

    console.log(`\n(C) Hold up to 5d with trailing stop:`);
    for (const trail of [undefined, 3, 5, 10, 15]) {
      const pnls = universe
        .map((r) => pnlWithStops(r, side, { maxHoldDays: 5, trailPct: trail }))
        .filter((p) => p != null) as number[];
      const label = `trail=${trail ?? "—"}${trail ? "%" : ""}`;
      console.log(fmtRow(label, summarize(pnls)));
    }

    console.log(`\n(D) Hold up to 10d, trailing + hard-stop combo:`);
    for (const sl of [5, 10]) {
      for (const trail of [5, 10]) {
        const pnls = universe
          .map((r) => pnlWithStops(r, side, { maxHoldDays: 10, slPct: sl, trailPct: trail }))
          .filter((p) => p != null) as number[];
        const label = `SL=${sl}% trail=${trail}%`;
        console.log(fmtRow(label, summarize(pnls)));
      }
    }
  };

  runSection("BUY THE GAINERS (momentum-carry LONG)", gainers, "LONG");
  runSection("BUY THE LOSERS (bounce-bet LONG)", losers, "LONG");

  // Find the best overall strategy
  console.log(`\n\n╔══════════════════════════════════════════════════════════════════════╗`);
  console.log(`║ TOP 5 STRATEGIES BY TOTAL $PNL (across all combos tested above)      ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════╝`);

  type Candidate = { name: string; side: "LONG" | "SHORT"; universe: string; summary: ReturnType<typeof summarize> };
  const candidates: Candidate[] = [];
  for (const [uniName, universe] of [["Gainers", gainers] as const, ["Losers", losers] as const]) {
    // A
    for (const hold of [1, 2, 3, 5, 10]) {
      for (const t of [0, 1, 2] as (0 | 1 | 2)[]) {
        const pnls = universe.map((r) => simplePnlPct(r, hold, t, "LONG")).filter((p) => p != null) as number[];
        candidates.push({ name: `hold=${hold}d · exit=${TIME_NAMES[t]}`, side: "LONG", universe: uniName, summary: summarize(pnls) });
      }
    }
    // B
    for (const sl of [undefined, 3, 5, 10]) {
      for (const tp of [undefined, 5, 10, 20]) {
        const pnls = universe
          .map((r) => pnlWithStops(r, "LONG", { maxHoldDays: 1, slPct: sl, tpPct: tp }))
          .filter((p) => p != null) as number[];
        candidates.push({ name: `1d close · SL=${sl ?? "—"} TP=${tp ?? "—"}`, side: "LONG", universe: uniName, summary: summarize(pnls) });
      }
    }
    // C
    for (const trail of [undefined, 3, 5, 10, 15]) {
      const pnls = universe
        .map((r) => pnlWithStops(r, "LONG", { maxHoldDays: 5, trailPct: trail }))
        .filter((p) => p != null) as number[];
      candidates.push({ name: `≤5d · trail=${trail ?? "—"}`, side: "LONG", universe: uniName, summary: summarize(pnls) });
    }
    // D
    for (const sl of [5, 10]) {
      for (const trail of [5, 10]) {
        const pnls = universe
          .map((r) => pnlWithStops(r, "LONG", { maxHoldDays: 10, slPct: sl, trailPct: trail }))
          .filter((p) => p != null) as number[];
        candidates.push({ name: `≤10d · SL=${sl}% trail=${trail}%`, side: "LONG", universe: uniName, summary: summarize(pnls) });
      }
    }
  }

  const sorted = candidates.filter((c) => c.summary).sort((a, b) => (b.summary!.total ?? 0) - (a.summary!.total ?? 0));
  sorted.slice(0, 10).forEach((c, i) => {
    const s = c.summary!;
    const pnlUsd = (s.total * CAPITAL_USD) / 100;
    console.log(
      `  ${String(i + 1).padStart(2)}. [${c.universe.padEnd(7)}] ${c.name.padEnd(26)} n=${String(s.n).padStart(3)} WR=${s.wr.toFixed(0)}% total=${fmtUsd(pnlUsd).padStart(7)} avg=${fmtPct(s.avg).padStart(6)}`
    );
  });

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
