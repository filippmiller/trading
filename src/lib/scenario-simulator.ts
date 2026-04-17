import { getPool, mysql } from "@/lib/db";
import { computePnL } from "@/lib/strategy-engine";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ScenarioFilters = {
  cohortDateFrom?: string;   // YYYY-MM-DD inclusive
  cohortDateTo?: string;     // YYYY-MM-DD inclusive
  direction?: "UP" | "DOWN" | "BOTH";   // UP = gainers (SHORT cohort rows), DOWN = losers (LONG cohort rows)
  minDayChangePct?: number;  // e.g. 3 → include UP only if +change >= 3
  maxDayChangePct?: number;  // e.g. 20 → include UP only if +change <= 20 (absolute, magnitude)
  minStreak?: number;        // consecutive_days min
  maxStreak?: number;        // consecutive_days max
  enrollmentSources?: Array<"MOVERS" | "TREND">;
  symbols?: string[];        // optional: filter to these symbols only
};

export type ExitStrategy = {
  kind: "TIME" | "STOP";
  // TIME: sell at d{holdDays}_close. No stop/take/trail.
  // STOP: walk through d1..holdDays close prices, exit when ANY condition triggers.
  holdDays: number;             // 1..10. For TIME: exact exit. For STOP: max hold.
  hardStopPct?: number;         // e.g. -5 → exit if direction-aware PnL <= -5
  takeProfitPct?: number;       // e.g. 8 → exit if direction-aware PnL >= 8
  trailingStopPct?: number;     // e.g. 3 → exit when price retraces 3% from best
  trailingActivateAtPct?: number; // activate trailing only after this much profit (default 0)
};

export type TradeParams = {
  investmentUsd: number;     // $ per position (own capital)
  leverage: number;          // 1, 5, 10, etc.
  tradeDirection: "LONG" | "SHORT";   // what we actually trade (independent of movers direction)
  exit: ExitStrategy;
};

export type CostParams = {
  commissionRoundTrip: number;   // $ per round-trip
  marginApyPct: number;          // e.g. 7 = 7% annual on borrowed portion
};

export type ExitReasonStr = "TIME" | "HARD_STOP" | "TAKE_PROFIT" | "TRAIL_STOP" | "DATA_MISSING";

export type SimulatedTrade = {
  entryId: number;
  symbol: string;
  cohortDate: string;
  coohortDirection: string;   // "LONG" or "SHORT" from reversal_entries.direction
  dayChangePct: number;
  consecutiveDays: number | null;
  enrollmentSource: string;
  tradeDirection: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number | null;
  exitDay: number | null;     // which d{n} we used (1..10)
  exitReason: ExitReasonStr;
  holdDays: number;           // actual days held (may be < requested if stopped out)
  rawPnlUsd: number;          // PnL before commissions/interest
  commissionUsd: number;
  interestUsd: number;
  netPnlUsd: number;          // raw - commission - interest
  netPnlPct: number;          // net return on investmentUsd
};

export type ScenarioSummary = {
  totalEntries: number;        // entries matching filters
  tradedEntries: number;       // entries we could actually simulate (had required exit data)
  skippedNoData: number;       // had no d{holdDays}_close
  wins: number;
  losses: number;
  winRate: number;             // 0..100
  totalPnlUsd: number;
  avgPnlUsd: number;
  avgPnlPct: number;
  medianPnlUsd: number;
  bestTrade: { symbol: string; pnl: number } | null;
  worstTrade: { symbol: string; pnl: number } | null;
  maxDrawdownUsd: number;      // running equity curve drawdown
  totalCommissionUsd: number;
  totalInterestUsd: number;
  roiPct: number;              // totalPnl / (tradedEntries * investmentUsd)
  // Advanced metrics:
  profitFactor: number;        // gross wins / |gross losses|, Infinity if no losses
  sharpeRatio: number;         // mean(pnl_pct) / std(pnl_pct), annualized by sqrt(252/avgHoldDays)
  avgHoldDays: number;         // mean of actual hold days
  exitReasonCounts: Record<ExitReasonStr, number>;
  pnlHistogram: Array<{ binStart: number; binEnd: number; count: number }>;
};

export type EquityCurvePoint = {
  cohortDate: string;          // trades sorted by cohort_date
  cumulativePnlUsd: number;
  tradesSoFar: number;
};

export type ScenarioResult = {
  trades: SimulatedTrade[];
  summary: ScenarioSummary;
  equityCurve: EquityCurvePoint[];
};

// ─── Simulator ──────────────────────────────────────────────────────────────

function dCol(n: number): string {
  if (n < 1 || n > 10) throw new Error(`day must be 1..10, got ${n}`);
  return `d${n}_close`;
}

/**
 * Walk through d1..dMax close prices for this entry. Evaluate exit rules at
 * each day. Return the first exit that triggers, or fall through to TIME at
 * dMax if nothing hit earlier. Direction-aware: pnlPct flips sign for SHORT.
 */
function evaluateExitWalk(
  row: mysql.RowDataPacket,
  entryPrice: number,
  tradeDirection: "LONG" | "SHORT",
  leverage: number,
  exit: ExitStrategy
): { exitPrice: number | null; exitDay: number | null; reason: ExitReasonStr } {
  const isShort = tradeDirection === "SHORT";
  let maxPrice = entryPrice;  // best for LONG
  let minPrice = entryPrice;  // best for SHORT
  let trailActive = false;
  let trailStop: number | null = null;
  let lastAvailable: { price: number; day: number } | null = null;

  for (let d = 1; d <= exit.holdDays; d++) {
    const raw = row[dCol(d)];
    if (raw == null) continue;
    const price = Number(raw);
    lastAvailable = { price, day: d };

    if (price > maxPrice) maxPrice = price;
    if (price < minPrice) minPrice = price;

    if (exit.kind === "STOP") {
      // Direction-aware PnL
      const rawPct = ((price - entryPrice) / entryPrice) * 100;
      const pnlPct = isShort ? -rawPct : rawPct;

      // 1. Hard stop (typically negative: -5 means "exit if down 5%")
      if (exit.hardStopPct != null && pnlPct <= exit.hardStopPct) {
        return { exitPrice: price, exitDay: d, reason: "HARD_STOP" };
      }

      // 2. Leverage liquidation (down -90% or more of leveraged capital)
      if (leverage > 1 && pnlPct * leverage <= -90) {
        return { exitPrice: price, exitDay: d, reason: "HARD_STOP" };
      }

      // 3. Take profit
      if (exit.takeProfitPct != null && pnlPct >= exit.takeProfitPct) {
        return { exitPrice: price, exitDay: d, reason: "TAKE_PROFIT" };
      }

      // 4. Trailing stop
      if (exit.trailingStopPct != null) {
        const activateAt = exit.trailingActivateAtPct ?? 0;
        if (!trailActive && pnlPct >= activateAt) {
          trailActive = true;
          trailStop = isShort
            ? price * (1 + exit.trailingStopPct / 100)
            : price * (1 - exit.trailingStopPct / 100);
        }
        if (trailActive) {
          if (isShort) {
            // SHORT: best = minPrice. Stop goes above it. Tighter = lower.
            const newStop = minPrice * (1 + exit.trailingStopPct / 100);
            if (trailStop == null || newStop < trailStop) trailStop = newStop;
            if (trailStop != null && price >= trailStop) {
              return { exitPrice: price, exitDay: d, reason: "TRAIL_STOP" };
            }
          } else {
            // LONG: best = maxPrice. Stop goes below. Tighter = higher.
            const newStop = maxPrice * (1 - exit.trailingStopPct / 100);
            if (trailStop == null || newStop > trailStop) trailStop = newStop;
            if (trailStop != null && price <= trailStop) {
              return { exitPrice: price, exitDay: d, reason: "TRAIL_STOP" };
            }
          }
        }
      }
    }
  }

  // TIME exit — use dMax's price if available, otherwise last price we saw.
  const targetCol = row[dCol(exit.holdDays)];
  if (targetCol != null) {
    return { exitPrice: Number(targetCol), exitDay: exit.holdDays, reason: "TIME" };
  }
  if (lastAvailable) {
    // Partial data — exit at last known price (informational)
    return { exitPrice: lastAvailable.price, exitDay: lastAvailable.day, reason: "TIME" };
  }
  return { exitPrice: null, exitDay: null, reason: "DATA_MISSING" };
}

/** Convert a MySQL DATE value into a YYYY-MM-DD string preserving the stored calendar day. */
function dateToStr(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v);
}

/**
 * Run a "what-if" scenario against historical reversal_entries.
 * Read-only: no DB writes, no side effects on live trading.
 */
export async function runScenario(
  filters: ScenarioFilters,
  trade: TradeParams,
  costs: CostParams
): Promise<ScenarioResult> {
  if (trade.investmentUsd <= 0) throw new Error("investmentUsd must be > 0");
  if (trade.leverage < 1 || trade.leverage > 100) throw new Error("leverage must be 1..100");
  if (trade.exit.holdDays < 1 || trade.exit.holdDays > 10) throw new Error("exit.holdDays must be 1..10");

  const pool = await getPool();

  // Build parameterized WHERE clause
  const where: string[] = ["d1_close IS NOT NULL", "entry_price > 0"];
  const params: (string | number)[] = [];

  if (filters.cohortDateFrom) { where.push("cohort_date >= ?"); params.push(filters.cohortDateFrom); }
  if (filters.cohortDateTo)   { where.push("cohort_date <= ?"); params.push(filters.cohortDateTo); }

  if (filters.direction === "UP")   { where.push("day_change_pct > 0"); }
  if (filters.direction === "DOWN") { where.push("day_change_pct < 0"); }

  if (filters.minDayChangePct != null) {
    // Interpreted as magnitude for UP; signed for DOWN bucket
    // Simplest: pass as-is for UP (positive), negate for DOWN (user passes magnitude)
    if (filters.direction === "DOWN") {
      where.push("day_change_pct <= ?");
      params.push(-filters.minDayChangePct);
    } else {
      where.push("day_change_pct >= ?");
      params.push(filters.minDayChangePct);
    }
  }
  if (filters.maxDayChangePct != null) {
    if (filters.direction === "DOWN") {
      where.push("day_change_pct >= ?");
      params.push(-filters.maxDayChangePct);
    } else {
      where.push("day_change_pct <= ?");
      params.push(filters.maxDayChangePct);
    }
  }

  if (filters.minStreak != null) { where.push("consecutive_days >= ?"); params.push(filters.minStreak); }
  if (filters.maxStreak != null) { where.push("consecutive_days <= ?"); params.push(filters.maxStreak); }

  if (filters.enrollmentSources && filters.enrollmentSources.length > 0) {
    where.push(`enrollment_source IN (${filters.enrollmentSources.map(() => "?").join(",")})`);
    params.push(...filters.enrollmentSources);
  }

  if (filters.symbols && filters.symbols.length > 0) {
    where.push(`symbol IN (${filters.symbols.map(() => "?").join(",")})`);
    params.push(...filters.symbols);
  }

  // Select all d1..d{holdDays} close columns so STOP walk can evaluate each.
  const dayCols: string[] = [];
  for (let d = 1; d <= trade.exit.holdDays; d++) dayCols.push(dCol(d));
  const selectCols = [
    "id", "symbol", "cohort_date", "direction", "day_change_pct", "entry_price",
    "consecutive_days", "enrollment_source",
    ...dayCols,
  ].join(", ");

  const sql = `SELECT ${selectCols} FROM reversal_entries WHERE ${where.join(" AND ")} ORDER BY cohort_date ASC, id ASC`;

  const [rows] = await pool.execute<mysql.RowDataPacket[]>(sql, params);

  // Simulate each entry
  const borrowed = trade.investmentUsd * (trade.leverage - 1);
  const dailyInterest = borrowed * (costs.marginApyPct / 100) / 252; // trading days
  const trades: SimulatedTrade[] = [];
  let skippedNoData = 0;

  for (const r of rows) {
    const entryPrice = Number(r.entry_price);
    const cohortStr = dateToStr(r.cohort_date);

    const exitResult = evaluateExitWalk(r, entryPrice, trade.tradeDirection, trade.leverage, trade.exit);

    if (exitResult.exitPrice == null || exitResult.exitDay == null) {
      skippedNoData++;
      trades.push({
        entryId: Number(r.id),
        symbol: String(r.symbol),
        cohortDate: cohortStr,
        coohortDirection: String(r.direction),
        dayChangePct: Number(r.day_change_pct),
        consecutiveDays: r.consecutive_days != null ? Number(r.consecutive_days) : null,
        enrollmentSource: String(r.enrollment_source),
        tradeDirection: trade.tradeDirection,
        entryPrice,
        exitPrice: null,
        exitDay: null,
        exitReason: "DATA_MISSING",
        holdDays: trade.exit.holdDays,
        rawPnlUsd: 0,
        commissionUsd: 0,
        interestUsd: 0,
        netPnlUsd: 0,
        netPnlPct: 0,
      });
      continue;
    }

    const pnl = computePnL(entryPrice, exitResult.exitPrice, trade.investmentUsd, trade.leverage, trade.tradeDirection);
    const rawPnlUsd = pnl.pnl_usd;
    const commissionUsd = costs.commissionRoundTrip;
    const interestUsd = dailyInterest * exitResult.exitDay;
    const netPnlUsd = rawPnlUsd - commissionUsd - interestUsd;
    const netPnlPct = (netPnlUsd / trade.investmentUsd) * 100;

    trades.push({
      entryId: Number(r.id),
      symbol: String(r.symbol),
      cohortDate: cohortStr,
      coohortDirection: String(r.direction),
      dayChangePct: Number(r.day_change_pct),
      consecutiveDays: r.consecutive_days != null ? Number(r.consecutive_days) : null,
      enrollmentSource: String(r.enrollment_source),
      tradeDirection: trade.tradeDirection,
      entryPrice,
      exitPrice: exitResult.exitPrice,
      exitDay: exitResult.exitDay,
      exitReason: exitResult.reason,
      holdDays: exitResult.exitDay,
      rawPnlUsd,
      commissionUsd,
      interestUsd,
      netPnlUsd,
      netPnlPct,
    });
  }

  // Summary + equity curve
  const simulated = trades.filter(t => t.exitReason !== "DATA_MISSING");
  const wins = simulated.filter(t => t.netPnlUsd > 0).length;
  const losses = simulated.filter(t => t.netPnlUsd <= 0).length;
  const totalPnl = simulated.reduce((s, t) => s + t.netPnlUsd, 0);
  const totalCommission = simulated.reduce((s, t) => s + t.commissionUsd, 0);
  const totalInterest = simulated.reduce((s, t) => s + t.interestUsd, 0);

  let best: { symbol: string; pnl: number } | null = null;
  let worst: { symbol: string; pnl: number } | null = null;
  for (const t of simulated) {
    if (!best || t.netPnlUsd > best.pnl) best = { symbol: t.symbol, pnl: t.netPnlUsd };
    if (!worst || t.netPnlUsd < worst.pnl) worst = { symbol: t.symbol, pnl: t.netPnlUsd };
  }

  // Equity curve: cumulative PnL walking through trades sorted by cohort_date
  const sorted = [...simulated].sort((a, b) => a.cohortDate.localeCompare(b.cohortDate));
  const curve: EquityCurvePoint[] = [];
  let cum = 0, peak = 0, maxDd = 0;
  for (let i = 0; i < sorted.length; i++) {
    cum += sorted[i].netPnlUsd;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
    // Merge same-cohort-date into one point (last of that date)
    const lastIdx = curve.length - 1;
    if (lastIdx >= 0 && curve[lastIdx].cohortDate === sorted[i].cohortDate) {
      curve[lastIdx] = {
        cohortDate: sorted[i].cohortDate,
        cumulativePnlUsd: cum,
        tradesSoFar: curve[lastIdx].tradesSoFar + 1,
      };
    } else {
      curve.push({ cohortDate: sorted[i].cohortDate, cumulativePnlUsd: cum, tradesSoFar: i + 1 });
    }
  }

  // Advanced metrics
  const grossWins = simulated.filter(t => t.netPnlUsd > 0).reduce((s, t) => s + t.netPnlUsd, 0);
  const grossLosses = simulated.filter(t => t.netPnlUsd <= 0).reduce((s, t) => s + Math.abs(t.netPnlUsd), 0);
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0);

  // Sharpe: mean / std of pnl_pct, annualized assuming avg hold period.
  const pctReturns = simulated.map(t => t.netPnlPct);
  const meanReturn = pctReturns.length > 0 ? pctReturns.reduce((s, v) => s + v, 0) / pctReturns.length : 0;
  const variance = pctReturns.length > 1
    ? pctReturns.reduce((s, v) => s + Math.pow(v - meanReturn, 2), 0) / (pctReturns.length - 1)
    : 0;
  const stdReturn = Math.sqrt(variance);
  const avgHoldDays = simulated.length > 0
    ? simulated.reduce((s, t) => s + t.holdDays, 0) / simulated.length
    : 0;
  const periodsPerYear = avgHoldDays > 0 ? 252 / avgHoldDays : 0;
  const sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(periodsPerYear) : 0;

  // Median
  const sortedPnl = pctReturns.map(v => v).sort((a, b) => a - b).map(v => v);
  const sortedUsd = simulated.map(t => t.netPnlUsd).sort((a, b) => a - b);
  const medianPnlUsd = sortedUsd.length === 0 ? 0
    : sortedUsd.length % 2 === 0
      ? (sortedUsd[sortedUsd.length / 2 - 1] + sortedUsd[sortedUsd.length / 2]) / 2
      : sortedUsd[Math.floor(sortedUsd.length / 2)];

  // Exit reason counts
  const exitReasonCounts: Record<ExitReasonStr, number> = {
    TIME: 0, HARD_STOP: 0, TAKE_PROFIT: 0, TRAIL_STOP: 0, DATA_MISSING: 0,
  };
  for (const t of trades) exitReasonCounts[t.exitReason]++;

  // PnL histogram — 12 buckets spanning min..max pnl_pct
  const pnlHistogram: Array<{ binStart: number; binEnd: number; count: number }> = [];
  if (sortedPnl.length > 0) {
    const minP = sortedPnl[0];
    const maxP = sortedPnl[sortedPnl.length - 1];
    const range = maxP - minP;
    if (range > 0) {
      const binCount = 12;
      const binWidth = range / binCount;
      for (let i = 0; i < binCount; i++) {
        const binStart = minP + i * binWidth;
        const binEnd = i === binCount - 1 ? maxP : binStart + binWidth;
        const count = pctReturns.filter(v => v >= binStart && (i === binCount - 1 ? v <= binEnd : v < binEnd)).length;
        pnlHistogram.push({ binStart, binEnd, count });
      }
    } else {
      // Edge case: all trades had identical pnl_pct
      pnlHistogram.push({ binStart: minP, binEnd: maxP, count: sortedPnl.length });
    }
  }

  const summary: ScenarioSummary = {
    totalEntries: trades.length,
    tradedEntries: simulated.length,
    skippedNoData,
    wins,
    losses,
    winRate: simulated.length > 0 ? (wins / simulated.length) * 100 : 0,
    totalPnlUsd: totalPnl,
    avgPnlUsd: simulated.length > 0 ? totalPnl / simulated.length : 0,
    avgPnlPct: meanReturn,
    medianPnlUsd,
    bestTrade: best,
    worstTrade: worst,
    maxDrawdownUsd: maxDd,
    totalCommissionUsd: totalCommission,
    totalInterestUsd: totalInterest,
    roiPct: simulated.length > 0
      ? (totalPnl / (simulated.length * trade.investmentUsd)) * 100
      : 0,
    profitFactor,
    sharpeRatio,
    avgHoldDays,
    exitReasonCounts,
    pnlHistogram,
  };

  return { trades, summary, equityCurve: curve };
}
