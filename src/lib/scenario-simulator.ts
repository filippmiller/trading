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

export type BarTime = "morning" | "midday" | "close";

export type ExitStrategy = {
  kind: "TIME" | "STOP";
  // TIME: sell at d{holdDays}_{exitBar}. No stop/take/trail.
  // STOP: walk through bars up to holdDays, exit when ANY condition triggers.
  holdDays: number;             // 1..10. For TIME: exact exit. For STOP: max hold.
  exitBar?: BarTime;            // "morning"|"midday"|"close" — defaults to "close" for TIME; STOP walks all 3 bars/day
  hardStopPct?: number;         // e.g. -5 → exit if direction-aware PnL <= -5
  takeProfitPct?: number;       // e.g. 8 → exit if direction-aware PnL >= 8
  trailingStopPct?: number;     // e.g. 3 → exit when price retraces 3% from best
  trailingActivateAtPct?: number; // activate trailing only after this much profit (default 0)
  breakevenAtPct?: number;      // e.g. 3 → after +3% favorable, tighten SL to entry (belt-and-suspenders)
};

export type TradeParams = {
  investmentUsd: number;     // $ per position (own capital)
  leverage: number;          // 1, 5, 10, etc.
  tradeDirection: "LONG" | "SHORT";   // what we actually trade (independent of movers direction)
  exit: ExitStrategy;
  entryDelayDays?: number;   // 0 = trigger-day close (default); 1..10 = enter at d{N}_close instead
  entryBar?: BarTime;        // which bar of the entry-delay day to use (default: close)
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

function dCol(n: number, bar: BarTime = "close"): string {
  if (n < 1 || n > 10) throw new Error(`day must be 1..10, got ${n}`);
  return `d${n}_${bar}`;
}

// All column names for full intraday walk (3 bars × 10 days = 30 columns)
const ALL_BAR_COLS: Array<{ col: string; day: number; bar: BarTime }> = (() => {
  const out: Array<{ col: string; day: number; bar: BarTime }> = [];
  for (let d = 1; d <= 10; d++) {
    for (const b of ["morning", "midday", "close"] as const) {
      out.push({ col: `d${d}_${b}`, day: d, bar: b });
    }
  }
  return out;
})();

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
  exit: ExitStrategy,
  startDay: number = 1  // begin evaluation from this day (supports entryDelay)
): { exitPrice: number | null; exitDay: number | null; reason: ExitReasonStr } {
  const isShort = tradeDirection === "SHORT";
  let maxPrice = entryPrice;  // best for LONG
  let minPrice = entryPrice;  // best for SHORT
  let trailActive = false;
  let trailStop: number | null = null;
  let breakevenArmed = false;
  let lastAvailable: { price: number; day: number } | null = null;

  // STOP mode walks every bar (M/D/E) to catch intraday trigger conditions.
  // TIME mode still walks for data-fallback purposes but only exits at the target bar.
  for (const { col, day } of ALL_BAR_COLS) {
    if (day < startDay) continue;
    if (day > exit.holdDays) break;
    const raw = row[col];
    if (raw == null) continue;
    const price = Number(raw);
    lastAvailable = { price, day };

    if (price > maxPrice) maxPrice = price;
    if (price < minPrice) minPrice = price;

    if (exit.kind === "STOP") {
      const rawPct = ((price - entryPrice) / entryPrice) * 100;
      const pnlPct = isShort ? -rawPct : rawPct;

      // 1. Breakeven arm — after reaching +X% favorable, any return to entry = exit.
      //    Protects runners that gave back gains without needing a full trailing stop.
      if (exit.breakevenAtPct != null && !breakevenArmed && pnlPct >= exit.breakevenAtPct) {
        breakevenArmed = true;
      }
      if (breakevenArmed && pnlPct <= 0) {
        return { exitPrice: price, exitDay: day, reason: "HARD_STOP" };
      }

      // 2. Hard stop (typically negative: -5 means "exit if down 5%")
      if (exit.hardStopPct != null && pnlPct <= exit.hardStopPct) {
        return { exitPrice: price, exitDay: day, reason: "HARD_STOP" };
      }

      // 3. Leverage liquidation (down -90% or more of leveraged capital)
      if (leverage > 1 && pnlPct * leverage <= -90) {
        return { exitPrice: price, exitDay: day, reason: "HARD_STOP" };
      }

      // 4. Take profit
      if (exit.takeProfitPct != null && pnlPct >= exit.takeProfitPct) {
        return { exitPrice: price, exitDay: day, reason: "TAKE_PROFIT" };
      }

      // 5. Trailing stop
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
            const newStop = minPrice * (1 + exit.trailingStopPct / 100);
            if (trailStop == null || newStop < trailStop) trailStop = newStop;
            if (trailStop != null && price >= trailStop) {
              return { exitPrice: price, exitDay: day, reason: "TRAIL_STOP" };
            }
          } else {
            const newStop = maxPrice * (1 - exit.trailingStopPct / 100);
            if (trailStop == null || newStop > trailStop) trailStop = newStop;
            if (trailStop != null && price <= trailStop) {
              return { exitPrice: price, exitDay: day, reason: "TRAIL_STOP" };
            }
          }
        }
      }
    }
  }

  // TIME exit — use d{holdDays}_{exitBar} price if available.
  const exitBar = exit.exitBar ?? "close";
  const targetRaw = row[dCol(exit.holdDays, exitBar)];
  if (targetRaw != null) {
    return { exitPrice: Number(targetRaw), exitDay: exit.holdDays, reason: "TIME" };
  }
  if (lastAvailable) {
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

  // Select all d{1..holdDays} bar columns (M/D/E) so STOP walk can evaluate
  // every intraday tick and the entryDelay path can use any bar as entry.
  const dayCols: string[] = [];
  for (let d = 1; d <= trade.exit.holdDays; d++) {
    for (const b of ["morning", "midday", "close"] as const) dayCols.push(`d${d}_${b}`);
  }
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
    let entryPrice = Number(r.entry_price);
    const cohortStr = dateToStr(r.cohort_date);

    // Entry-delay path: re-anchor entry to d{delay}_{entryBar} if requested.
    // This lets users test "what if I wait N days before buying" — the core
    // strategy search question.
    const delay = trade.entryDelayDays ?? 0;
    const entryBar = trade.entryBar ?? "close";
    if (delay > 0) {
      const delayedRaw = r[`d${delay}_${entryBar}`];
      if (delayedRaw == null) {
        skippedNoData++;
        continue;
      }
      entryPrice = Number(delayedRaw);
    }
    const walkStart = delay + 1;

    const exitResult = evaluateExitWalk(r, entryPrice, trade.tradeDirection, trade.leverage, trade.exit, walkStart);

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

// ─── Grid sweep ─────────────────────────────────────────────────────────────
// Run all combinations of axis-ranges in a single SQL load + in-memory replay.
// This is the core research primitive: one DB read, N simulations.

export type GridAxis<T> = { values: T[] };

export type GridSweepRequest = {
  filters: ScenarioFilters;
  trade: Omit<TradeParams, "exit" | "entryDelayDays" | "entryBar"> & {
    // These three axes sweep; everything else stays fixed.
    holdDays: GridAxis<number>;
    exitBar: GridAxis<BarTime>;
    entryDelayDays?: GridAxis<number>;
    entryBar?: GridAxis<BarTime>;
    hardStopPct?: GridAxis<number | null>;      // null = no hard stop
    takeProfitPct?: GridAxis<number | null>;    // null = no take profit
    trailingStopPct?: GridAxis<number | null>;  // null = no trailing
    breakevenAtPct?: GridAxis<number | null>;   // null = no breakeven arm
  };
  costs: CostParams;
  topN?: number;           // return top-N configs by totalPnl (default 20)
  sortBy?: "totalPnl" | "winRate" | "sharpe" | "profitFactor";
};

export type GridSweepRow = {
  // Axis values
  holdDays: number;
  exitBar: BarTime;
  entryDelayDays: number;
  entryBar: BarTime;
  hardStopPct: number | null;
  takeProfitPct: number | null;
  trailingStopPct: number | null;
  breakevenAtPct: number | null;
  // Metrics
  n: number;              // trades simulated
  winRate: number;
  totalPnlUsd: number;
  avgPnlPct: number;
  bestPct: number;
  worstPct: number;
  profitFactor: number;
  sharpeRatio: number;
  avgHoldDays: number;
};

export type GridSweepResult = {
  totalCombinations: number;
  evaluated: number;
  rows: GridSweepRow[];  // sorted by sortBy, limited to topN
  sampleSize: number;    // how many DB entries the filter matched
};

export async function runGridSweep(req: GridSweepRequest): Promise<GridSweepResult> {
  const pool = await getPool();

  // Load every candidate row ONCE (filter applied at SQL level).
  const where: string[] = ["d1_morning IS NOT NULL", "entry_price > 0"];
  const params: (string | number)[] = [];
  const f = req.filters;
  if (f.cohortDateFrom) { where.push("cohort_date >= ?"); params.push(f.cohortDateFrom); }
  if (f.cohortDateTo)   { where.push("cohort_date <= ?"); params.push(f.cohortDateTo); }
  if (f.direction === "UP")   where.push("day_change_pct > 0");
  if (f.direction === "DOWN") where.push("day_change_pct < 0");
  if (f.minDayChangePct != null) {
    if (f.direction === "DOWN") { where.push("day_change_pct <= ?"); params.push(-f.minDayChangePct); }
    else { where.push("day_change_pct >= ?"); params.push(f.minDayChangePct); }
  }
  if (f.maxDayChangePct != null) {
    if (f.direction === "DOWN") { where.push("day_change_pct >= ?"); params.push(-f.maxDayChangePct); }
    else { where.push("day_change_pct <= ?"); params.push(f.maxDayChangePct); }
  }
  if (f.minStreak != null) { where.push("consecutive_days >= ?"); params.push(f.minStreak); }
  if (f.maxStreak != null) { where.push("consecutive_days <= ?"); params.push(f.maxStreak); }
  if (f.enrollmentSources?.length) {
    where.push(`enrollment_source IN (${f.enrollmentSources.map(() => "?").join(",")})`);
    params.push(...f.enrollmentSources);
  }
  if (f.symbols?.length) {
    where.push(`symbol IN (${f.symbols.map(() => "?").join(",")})`);
    params.push(...f.symbols);
  }

  const allBarCols = ALL_BAR_COLS.map(b => b.col).join(", ");
  const sql = `SELECT id, symbol, cohort_date, direction, day_change_pct, entry_price,
                      consecutive_days, ${allBarCols}
                 FROM reversal_entries WHERE ${where.join(" AND ")}
                 ORDER BY cohort_date ASC, id ASC`;
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(sql, params);

  // Build all combinations of the grid axes.
  const axes = req.trade;
  const nullableAxis = <T>(a: GridAxis<T | null> | undefined, fallback: (T | null)[]) =>
    (a?.values ?? fallback);

  const holdValues = axes.holdDays.values;
  const exitBarValues = axes.exitBar.values;
  const entryDelayValues = (axes.entryDelayDays?.values ?? [0]);
  const entryBarValues = (axes.entryBar?.values ?? ["close" as BarTime]);
  const slValues = nullableAxis(axes.hardStopPct, [null]);
  const tpValues = nullableAxis(axes.takeProfitPct, [null]);
  const trailValues = nullableAxis(axes.trailingStopPct, [null]);
  const beValues = nullableAxis(axes.breakevenAtPct, [null]);

  const combos: Array<{
    holdDays: number; exitBar: BarTime;
    entryDelayDays: number; entryBar: BarTime;
    hardStopPct: number | null; takeProfitPct: number | null;
    trailingStopPct: number | null; breakevenAtPct: number | null;
  }> = [];
  for (const hd of holdValues) {
    for (const eb of exitBarValues) {
      for (const ed of entryDelayValues) {
        for (const enb of entryBarValues) {
          for (const sl of slValues) {
            for (const tp of tpValues) {
              for (const tr of trailValues) {
                for (const be of beValues) {
                  if (ed >= hd) continue; // nonsensical: delay must be < hold
                  combos.push({
                    holdDays: hd, exitBar: eb,
                    entryDelayDays: ed, entryBar: enb,
                    hardStopPct: sl, takeProfitPct: tp,
                    trailingStopPct: tr, breakevenAtPct: be,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  const borrowed = req.trade.investmentUsd * (req.trade.leverage - 1);
  const dailyInterest = borrowed * (req.costs.marginApyPct / 100) / 252;
  const results: GridSweepRow[] = [];

  for (const c of combos) {
    const hasAnyStop = c.hardStopPct != null || c.takeProfitPct != null
                    || c.trailingStopPct != null || c.breakevenAtPct != null;
    const exit: ExitStrategy = {
      kind: hasAnyStop ? "STOP" : "TIME",
      holdDays: c.holdDays,
      exitBar: c.exitBar,
      hardStopPct: c.hardStopPct ?? undefined,
      takeProfitPct: c.takeProfitPct ?? undefined,
      trailingStopPct: c.trailingStopPct ?? undefined,
      breakevenAtPct: c.breakevenAtPct ?? undefined,
    };

    let n = 0, wins = 0, totalUsd = 0;
    let grossWins = 0, grossLosses = 0;
    let bestPct = -Infinity, worstPct = Infinity;
    const pctReturns: number[] = [];
    let sumHold = 0;

    for (const r of rows) {
      let entryPrice = Number(r.entry_price);
      if (c.entryDelayDays > 0) {
        const v = r[`d${c.entryDelayDays}_${c.entryBar}`];
        if (v == null) continue;
        entryPrice = Number(v);
      }
      const walkStart = c.entryDelayDays + 1;
      const exitResult = evaluateExitWalk(r, entryPrice, req.trade.tradeDirection, req.trade.leverage, exit, walkStart);
      if (exitResult.exitPrice == null || exitResult.exitDay == null) continue;

      const pnl = computePnL(entryPrice, exitResult.exitPrice, req.trade.investmentUsd, req.trade.leverage, req.trade.tradeDirection);
      const commissionUsd = req.costs.commissionRoundTrip;
      const interestUsd = dailyInterest * exitResult.exitDay;
      const netPnlUsd = pnl.pnl_usd - commissionUsd - interestUsd;
      const netPnlPct = (netPnlUsd / req.trade.investmentUsd) * 100;

      n++;
      totalUsd += netPnlUsd;
      sumHold += exitResult.exitDay;
      if (netPnlUsd > 0) { wins++; grossWins += netPnlUsd; }
      else               { grossLosses += Math.abs(netPnlUsd); }
      if (netPnlPct > bestPct)  bestPct = netPnlPct;
      if (netPnlPct < worstPct) worstPct = netPnlPct;
      pctReturns.push(netPnlPct);
    }
    if (n === 0) continue;

    const winRate = (wins / n) * 100;
    const avgPct = pctReturns.reduce((s, v) => s + v, 0) / n;
    const variance = n > 1 ? pctReturns.reduce((s, v) => s + Math.pow(v - avgPct, 2), 0) / (n - 1) : 0;
    const std = Math.sqrt(variance);
    const avgHold = sumHold / n;
    const sharpe = std > 0 ? (avgPct / std) * Math.sqrt(avgHold > 0 ? 252 / avgHold : 0) : 0;
    const pf = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0);

    results.push({
      holdDays: c.holdDays, exitBar: c.exitBar,
      entryDelayDays: c.entryDelayDays, entryBar: c.entryBar,
      hardStopPct: c.hardStopPct, takeProfitPct: c.takeProfitPct,
      trailingStopPct: c.trailingStopPct, breakevenAtPct: c.breakevenAtPct,
      n, winRate, totalPnlUsd: totalUsd, avgPnlPct: avgPct,
      bestPct: bestPct === -Infinity ? 0 : bestPct,
      worstPct: worstPct === Infinity ? 0 : worstPct,
      profitFactor: pf, sharpeRatio: sharpe, avgHoldDays: avgHold,
    });
  }

  const sortBy = req.sortBy ?? "totalPnl";
  results.sort((a, b) => {
    if (sortBy === "winRate") return b.winRate - a.winRate;
    if (sortBy === "sharpe") return b.sharpeRatio - a.sharpeRatio;
    if (sortBy === "profitFactor") return (b.profitFactor === Infinity ? 999999 : b.profitFactor) - (a.profitFactor === Infinity ? 999999 : a.profitFactor);
    return b.totalPnlUsd - a.totalPnlUsd;
  });

  const topN = req.topN ?? 20;
  return {
    totalCombinations: combos.length,
    evaluated: results.length,
    rows: results.slice(0, topN),
    sampleSize: rows.length,
  };
}
