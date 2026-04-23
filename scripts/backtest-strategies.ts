#!/usr/bin/env npx tsx
/**
 * Backtest all 24 strategies against historical reversal_entries.
 *
 * For each strategy, iterates through cohort days chronologically,
 * evaluates entry signals, simulates exits using d1-d5 close prices,
 * and records results in paper_signals.
 *
 * Usage: DATABASE_URL=mysql://... npx tsx scripts/backtest-strategies.ts
 */

import mysql from "mysql2/promise";
import {
  type StrategyConfig,
  type ReversalCandidate,
  matchesEntry,
  computePnL,
} from "../src/lib/strategy-engine";

// DATABASE_URL must be set explicitly — credentials must never be hardcoded.
function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL environment variable is required. Never hardcode credentials.");
    process.exit(1);
  }
  return url;
}
const DB_URL: string = requireDatabaseUrl();

async function main() {
  const parsed = new URL(DB_URL);
  const pool = mysql.createPool({
    host: parsed.hostname,
    port: Number(parsed.port) || 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace("/", ""),
    connectionLimit: 5,
    timezone: "Z",
  });

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   Strategy Backtest — Historical Simulation       ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // Clear previous backtest signals
  await pool.execute("DELETE FROM paper_signals WHERE status IN ('BACKTEST_WIN', 'BACKTEST_LOSS', 'BACKTEST_OPEN')");
  console.log("Cleared previous backtest results.\n");

  // Pre-load (strategy_id, reversal_entry_id) pairs that already have a
  // LIVE signal. The UX_signal_strat_entry UNIQUE KEY (added 2026-04-17)
  // prevents the backtest from re-INSERTing a pair that's already tracked
  // by live execution. Skipping these up-front avoids errno 1062 crashes
  // mid-run and keeps the live signal's real P&L authoritative for that
  // pair rather than overwriting with a simulated one.
  const [liveRows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT strategy_id, reversal_entry_id FROM paper_signals WHERE status IN ('EXECUTED', 'WIN', 'LOSS')"
  );
  const livePairKeys = new Set<string>();
  for (const r of liveRows) {
    if (r.strategy_id != null && r.reversal_entry_id != null) {
      livePairKeys.add(`${r.strategy_id}|${r.reversal_entry_id}`);
    }
  }
  console.log(`${livePairKeys.size} (strategy, entry) pairs already have live signals — will skip in backtest.\n`);

  // Load strategies
  const [stratRows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM paper_strategies WHERE enabled = 1 ORDER BY id"
  );
  console.log(`Loaded ${stratRows.length} strategies.\n`);

  // Load reversal entries with price data (only cohorts that have d1_close filled)
  const [entries] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT * FROM reversal_entries
     WHERE d1_close IS NOT NULL
     ORDER BY cohort_date ASC, id ASC`
  );
  console.log(`Loaded ${entries.length} reversal entries with price data.\n`);

  // Group entries by cohort_date
  const cohorts = new Map<string, mysql.RowDataPacket[]>();
  for (const e of entries) {
    const d = typeof e.cohort_date === "string"
      ? e.cohort_date
      : new Date(e.cohort_date).toISOString().split("T")[0];
    if (!cohorts.has(d)) cohorts.set(d, []);
    cohorts.get(d)!.push(e);
  }
  const sortedDates = [...cohorts.keys()].sort();
  console.log(`${sortedDates.length} cohort days: ${sortedDates[0]} → ${sortedDates[sortedDates.length - 1]}\n`);

  // ── Run backtest for each strategy ──────────────────────────────────────

  const results: Array<{
    name: string;
    leverage: number;
    trades: number;
    wins: number;
    losses: number;
    totalPnlUsd: number;
    avgPnlPct: number;
    maxDrawdownPct: number;
    bestTradePct: number;
    worstTradePct: number;
  }> = [];

  for (const strat of stratRows) {
    const config: StrategyConfig = JSON.parse(strat.config_json);
    const leverage = Number(strat.leverage);
    const stratName = strat.name as string;

    let trades = 0, wins = 0, losses = 0;
    let totalPnlUsd = 0;
    const pnlPcts: number[] = [];
    let equity = 100000;
    let peakEquity = equity;
    let maxDrawdownPct = 0;
    const activePositionUntilIndexes: number[] = [];
    let dailyNewCount = 0;
    let lastCohortDate = "";

    for (let cohortIndex = 0; cohortIndex < sortedDates.length; cohortIndex++) {
      const cohortDate = sortedDates[cohortIndex];
      const cohortEntries = cohorts.get(cohortDate)!;

      for (let i = activePositionUntilIndexes.length - 1; i >= 0; i--) {
        if (activePositionUntilIndexes[i] <= cohortIndex) {
          activePositionUntilIndexes.splice(i, 1);
        }
      }

      // Reset daily new count on new cohort date
      if (cohortDate !== lastCohortDate) {
        dailyNewCount = 0;
        lastCohortDate = cohortDate;
      }

      for (const entry of cohortEntries) {
        // Check concurrent position cap
        if (activePositionUntilIndexes.length >= config.sizing.max_concurrent) continue;
        if (dailyNewCount >= config.sizing.max_new_per_day) continue;

        // Skip pairs with an existing live signal — the UNIQUE KEY would
        // block the INSERT and the live P&L is the real number anyway.
        if (livePairKeys.has(`${strat.id}|${entry.id}`)) continue;

        // Build candidate
        const candidate: ReversalCandidate = {
          id: entry.id,
          cohort_date: cohortDate,
          symbol: entry.symbol,
          direction: entry.direction,
          day_change_pct: Number(entry.day_change_pct),
          entry_price: Number(entry.entry_price),
          consecutive_days: entry.consecutive_days != null ? Number(entry.consecutive_days) : null,
        };

        if (!matchesEntry(candidate, config)) continue;

        // ── Simulate the trade ──────────────────────────────────────────

        const entryPrice = candidate.entry_price;
        const investment = config.sizing.amount_usd;

        // Collect available price checkpoints: d1 morning/close through d5+
        const checkpoints: Array<{ day: number; slot: string; price: number }> = [];
        for (let d = 1; d <= 10; d++) {
          for (const slot of ["morning", "midday", "close"]) {
            const col = `d${d}_${slot}`;
            const val = entry[col];
            if (val != null) {
              checkpoints.push({ day: d, slot, price: Number(val) });
            }
          }
        }

        if (checkpoints.length === 0) continue;

        // Walk through checkpoints, evaluate exit conditions. All PnL math
        // is direction-aware: `pnlPct` represents PROFIT for both LONG and
        // SHORT (raw price-move sign flipped for SHORT).
        const isShort = candidate.direction === "SHORT";
        let maxPrice = entryPrice;
        let minPrice = entryPrice;
        let trailingActive = false;
        let trailingStop: number | null = null;
        let exitPrice: number | null = null;
        let exitReason: string | null = null;
        let exitDay = 0;

        for (const cp of checkpoints) {
          const price = cp.price;
          maxPrice = Math.max(maxPrice, price);
          minPrice = Math.min(minPrice, price);

          const rawPricePct = ((price - entryPrice) / entryPrice) * 100;
          const pnlPct = isShort ? -rawPricePct : rawPricePct;
          const leveragedPnl = pnlPct * leverage;

          // Hard stop (pnlPct is direction-aware: negative = losing)
          if (config.exits.hard_stop_pct != null && pnlPct <= config.exits.hard_stop_pct) {
            exitPrice = price;
            exitReason = "HARD_STOP";
            exitDay = cp.day;
            break;
          }

          // Leverage liquidation
          if (leverage > 1 && leveragedPnl <= -90) {
            exitPrice = price;
            exitReason = "LIQUIDATED";
            exitDay = cp.day;
            break;
          }

          // Take profit (direction-aware)
          if (config.exits.take_profit_pct != null && pnlPct >= config.exits.take_profit_pct) {
            exitPrice = price;
            exitReason = "TAKE_PROFIT";
            exitDay = cp.day;
            break;
          }

          // Trailing stop — LONG trails below max, SHORT trails above min.
          if (config.exits.trailing_stop_pct != null) {
            const activateAt = config.exits.trailing_activates_at_profit_pct ?? 0;
            if (!trailingActive && pnlPct >= activateAt) {
              trailingActive = true;
              trailingStop = isShort
                ? price * (1 + config.exits.trailing_stop_pct / 100)
                : price * (1 - config.exits.trailing_stop_pct / 100);
            }
            if (trailingActive) {
              if (isShort) {
                // SHORT: stop is above min; tighter stop is LOWER.
                const newStop = minPrice * (1 + config.exits.trailing_stop_pct / 100);
                if (trailingStop == null || newStop < trailingStop) trailingStop = newStop;
                if (trailingStop != null && price >= trailingStop) {
                  exitPrice = price;
                  exitReason = "TRAIL_STOP";
                  exitDay = cp.day;
                  break;
                }
              } else {
                // LONG: stop is below max; tighter stop is HIGHER.
                const newStop = maxPrice * (1 - config.exits.trailing_stop_pct / 100);
                if (trailingStop == null || newStop > trailingStop) trailingStop = newStop;
                if (trailingStop != null && price <= trailingStop) {
                  exitPrice = price;
                  exitReason = "TRAIL_STOP";
                  exitDay = cp.day;
                  break;
                }
              }
            }
          }

          // Time exit
          if (config.exits.time_exit_days != null && cp.slot === "close") {
            if (cp.day >= config.exits.time_exit_days) {
              exitPrice = price;
              exitReason = "TIME";
              exitDay = cp.day;
              break;
            }
          }
        }

        // If no exit triggered, use last available price
        if (exitPrice == null && checkpoints.length > 0) {
          const last = checkpoints[checkpoints.length - 1];
          exitPrice = last.price;
          exitReason = "DATA_END";
          exitDay = last.day;
        }

        if (exitPrice == null) continue;

        // Compute P&L (direction-aware)
        const direction = candidate.direction === "SHORT" ? "SHORT" : "LONG";
        const { pnl_usd, pnl_pct } = computePnL(entryPrice, exitPrice, investment, leverage, direction);
        // High-watermark pnl: for LONG the best is maxPrice; for SHORT the
        // best is minPrice. Flip sign accordingly.
        const maxRaw = ((maxPrice - entryPrice) / entryPrice) * 100;
        const minRaw = ((minPrice - entryPrice) / entryPrice) * 100;
        const maxPnlPct = (isShort ? -minRaw : maxRaw) * leverage;
        const minPnlPct = (isShort ? -maxRaw : minRaw) * leverage;

        // Update stats
        trades++;
        dailyNewCount++;
        if (pnl_usd > 0) wins++;
        else losses++;
        totalPnlUsd += pnl_usd;
        pnlPcts.push(pnl_pct);
        equity += pnl_usd;
        peakEquity = Math.max(peakEquity, equity);
        const dd = ((peakEquity - equity) / peakEquity) * 100;
        maxDrawdownPct = Math.max(maxDrawdownPct, dd);

        activePositionUntilIndexes.push(cohortIndex + Math.max(exitDay, 1));

        // Insert signal record. Swallow errno 1062 — it's possible a live
        // signal for this (strat, entry) snuck in between the pre-load and
        // this INSERT; in that case the live record is authoritative.
        const status = pnl_usd > 0 ? "BACKTEST_WIN" : "BACKTEST_LOSS";
        try {
          await pool.execute(
            `INSERT INTO paper_signals
             (strategy_id, reversal_entry_id, symbol, generated_at, status,
              entry_price, entry_at, exit_price, exit_at, exit_reason,
              investment_usd, leverage, effective_exposure,
              max_price, min_price, max_pnl_pct, min_pnl_pct,
              pnl_usd, pnl_pct, holding_minutes)
             VALUES (?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?,
                     ?, ?, ?,
                     ?, ?, ?, ?,
                     ?, ?, ?)`,
            [
              strat.id,
              entry.id,
              candidate.symbol,
              entry.created_at || new Date(),
              status,
              entryPrice,
              entry.created_at || new Date(),
              exitPrice,
              entry.created_at || new Date(), // approximate
              exitReason,
              investment,
              leverage,
              investment * leverage,
              maxPrice,
              minPrice,
              maxPnlPct,
              minPnlPct,
              pnl_usd,
              pnl_pct,
              exitDay * 24 * 60, // approximate holding time
            ]
          );
        } catch (err) {
          if ((err as { errno?: number }).errno !== 1062) throw err;
          // Silent skip — live signal won the race.
        }
      }
    }

    const avgPnlPct = pnlPcts.length > 0 ? pnlPcts.reduce((a, b) => a + b, 0) / pnlPcts.length : 0;
    const bestPct = pnlPcts.length > 0 ? Math.max(...pnlPcts) : 0;
    const worstPct = pnlPcts.length > 0 ? Math.min(...pnlPcts) : 0;

    results.push({
      name: stratName,
      leverage,
      trades,
      wins,
      losses,
      totalPnlUsd: totalPnlUsd,
      avgPnlPct,
      maxDrawdownPct,
      bestTradePct: bestPct,
      worstTradePct: worstPct,
    });

    const winRate = trades > 0 ? (wins / trades * 100).toFixed(1) : "0";
    const pnlStr = totalPnlUsd >= 0 ? `+$${totalPnlUsd.toFixed(0)}` : `-$${Math.abs(totalPnlUsd).toFixed(0)}`;
    console.log(
      `  ${stratName.padEnd(30)} ${String(trades).padStart(3)} trades | ${winRate.padStart(5)}% win | ${pnlStr.padStart(8)} | avg ${avgPnlPct.toFixed(2).padStart(7)}% | dd ${maxDrawdownPct.toFixed(1)}%`
    );
  }

  // ── Summary table ───────────────────────────────────────────────────────

  console.log("\n" + "═".repeat(100));
  console.log("RANKING (sorted by total P&L)");
  console.log("═".repeat(100));

  results.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);

  console.log(
    "  #  " +
    "Strategy".padEnd(30) +
    "Trades".padStart(7) +
    "Win%".padStart(7) +
    "Total P&L".padStart(12) +
    "Avg%".padStart(8) +
    "Best%".padStart(8) +
    "Worst%".padStart(8) +
    "MaxDD%".padStart(8)
  );
  console.log("─".repeat(100));

  let rank = 1;
  for (const r of results) {
    const pnlStr = r.totalPnlUsd >= 0 ? `+$${r.totalPnlUsd.toFixed(0)}` : `-$${Math.abs(r.totalPnlUsd).toFixed(0)}`;
    const winPct = r.trades > 0 ? (r.wins / r.trades * 100).toFixed(1) : "0.0";
    console.log(
      `  ${String(rank++).padStart(2)} ` +
      `${r.name.padEnd(30)}` +
      `${String(r.trades).padStart(7)}` +
      `${winPct.padStart(7)}` +
      `${pnlStr.padStart(12)}` +
      `${r.avgPnlPct.toFixed(2).padStart(8)}` +
      `${r.bestTradePct.toFixed(1).padStart(8)}` +
      `${r.worstTradePct.toFixed(1).padStart(8)}` +
      `${r.maxDrawdownPct.toFixed(1).padStart(8)}`
    );
  }

  // Total signals created
  const [countResult] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) as cnt FROM paper_signals WHERE status LIKE 'BACKTEST%'"
  );
  console.log(`\nTotal backtest signals recorded: ${countResult[0].cnt}`);

  await pool.end();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
