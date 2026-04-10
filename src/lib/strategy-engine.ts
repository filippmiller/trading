/**
 * Strategy Scenario Engine
 *
 * Config-driven strategy evaluation. Each strategy is defined by a JSON config
 * stored in paper_strategies.config_json. The engine evaluates entry signals
 * and exit conditions without knowing the specific strategy — all logic is
 * derived from the config.
 *
 * This module is used by both:
 *   - The backtest script (scripts/backtest-strategies.ts)
 *   - The cron jobs (jobExecuteStrategies, jobMonitorPositions)
 */

// ─── Config Types ──────────────────────────────────────────────────────────

export type EntryConfig = {
  direction: "LONG" | "SHORT" | "ANY";
  min_drop_pct?: number;    // e.g. -7 → filter day_change_pct <= -7
  max_drop_pct?: number;    // e.g. -15 → filter day_change_pct >= -15
  min_rise_pct?: number;    // for SHORT strategies
  max_rise_pct?: number;
  max_consecutive_days?: number; // skip if too many consecutive days (likely fundamental)
  min_price?: number;       // skip penny stocks
};

export type SizingConfig = {
  type: "fixed" | "pct_equity";
  amount_usd: number;       // fixed $ per trade
  max_concurrent: number;   // max open positions at once
  max_new_per_day: number;  // max new positions per day
};

export type ExitConfig = {
  hard_stop_pct?: number;            // e.g. -7 → exit if down 7% from entry
  take_profit_pct?: number;          // e.g. 3 → exit if up 3% from entry
  trailing_stop_pct?: number;        // e.g. 2 → trail 2% from high water mark
  trailing_activates_at_profit_pct?: number; // e.g. 1 → trailing starts after 1% profit
  time_exit_days?: number;           // e.g. 3 → exit after 3 trading days
};

export type StrategyConfig = {
  entry: EntryConfig;
  sizing: SizingConfig;
  exits: ExitConfig;
};

// ─── Entry Evaluation ──────────────────────────────────────────────────────

export type ReversalCandidate = {
  id: number;
  cohort_date: string;
  symbol: string;
  direction: string;
  day_change_pct: number;
  entry_price: number;
  consecutive_days: number | null;
};

/**
 * Does this reversal entry match the strategy's entry criteria?
 */
export function matchesEntry(candidate: ReversalCandidate, config: StrategyConfig): boolean {
  const { entry } = config;
  const pct = candidate.day_change_pct;

  // Direction filter
  if (entry.direction === "LONG" && candidate.direction !== "LONG") return false;
  if (entry.direction === "SHORT" && candidate.direction !== "SHORT") return false;

  // Drop magnitude filter (for LONG: we care about how much it dropped)
  if (candidate.direction === "LONG") {
    if (entry.min_drop_pct != null && pct > entry.min_drop_pct) return false;  // pct is negative, min_drop is e.g. -7
    if (entry.max_drop_pct != null && pct < entry.max_drop_pct) return false;  // pct is e.g. -12, max is -15
  }

  // Rise magnitude filter (for SHORT)
  if (candidate.direction === "SHORT") {
    if (entry.min_rise_pct != null && pct < entry.min_rise_pct) return false;
    if (entry.max_rise_pct != null && pct > entry.max_rise_pct) return false;
  }

  // Consecutive days filter
  if (entry.max_consecutive_days != null && candidate.consecutive_days != null) {
    if (candidate.consecutive_days > entry.max_consecutive_days) return false;
  }

  // Min price filter
  if (entry.min_price != null && candidate.entry_price < entry.min_price) return false;

  return true;
}

// ─── Exit Evaluation ───────────────────────────────────────────────────────

export type PositionState = {
  entry_price: number;
  current_price: number;
  max_price: number;       // high watermark since entry
  min_price: number;       // low watermark since entry
  entry_at: Date;
  now: Date;
  leverage: number;
  trailing_active: boolean;
  trailing_stop_price: number | null;
};

export type ExitDecision = {
  should_exit: boolean;
  reason: string | null;
  exit_price: number;
  new_trailing_stop: number | null;
  new_trailing_active: boolean;
};

/**
 * Should this position be exited? Check all exit conditions.
 *
 * Also computes new trailing stop values (returned even if no exit).
 */
export function evaluateExit(pos: PositionState, config: StrategyConfig): ExitDecision {
  const { exits } = config;
  const pnlPct = ((pos.current_price - pos.entry_price) / pos.entry_price) * 100;
  const leveragedPnlPct = pnlPct * pos.leverage;

  let newTrailingActive = pos.trailing_active;
  let newTrailingStop = pos.trailing_stop_price;

  // 1. Hard stop (based on raw price movement, not leveraged)
  if (exits.hard_stop_pct != null) {
    const stopPrice = pos.entry_price * (1 + exits.hard_stop_pct / 100);
    if (pos.current_price <= stopPrice) {
      return { should_exit: true, reason: "HARD_STOP", exit_price: pos.current_price, new_trailing_stop: newTrailingStop, new_trailing_active: newTrailingActive };
    }
  }

  // 2. Leverage liquidation check (if leveraged pnl wipes out margin)
  if (pos.leverage > 1 && leveragedPnlPct <= -90) {
    return { should_exit: true, reason: "LIQUIDATED", exit_price: pos.current_price, new_trailing_stop: newTrailingStop, new_trailing_active: newTrailingActive };
  }

  // 3. Take profit
  if (exits.take_profit_pct != null && pnlPct >= exits.take_profit_pct) {
    return { should_exit: true, reason: "TAKE_PROFIT", exit_price: pos.current_price, new_trailing_stop: newTrailingStop, new_trailing_active: newTrailingActive };
  }

  // 4. Trailing stop
  if (exits.trailing_stop_pct != null) {
    const activateAt = exits.trailing_activates_at_profit_pct ?? 0;

    // Activate trailing when profit exceeds threshold
    if (!newTrailingActive && pnlPct >= activateAt) {
      newTrailingActive = true;
      newTrailingStop = pos.current_price * (1 - exits.trailing_stop_pct / 100);
    }

    // Update trailing stop if price made new high
    if (newTrailingActive) {
      const effectiveHigh = Math.max(pos.max_price, pos.current_price);
      const newStop = effectiveHigh * (1 - exits.trailing_stop_pct / 100);
      if (newTrailingStop == null || newStop > newTrailingStop) {
        newTrailingStop = newStop;
      }
    }

    // Check if price hit the trailing stop
    if (newTrailingActive && newTrailingStop != null && pos.current_price <= newTrailingStop) {
      return { should_exit: true, reason: "TRAIL_STOP", exit_price: pos.current_price, new_trailing_stop: newTrailingStop, new_trailing_active: newTrailingActive };
    }
  }

  // 5. Time exit (trading days)
  if (exits.time_exit_days != null) {
    const holdMs = pos.now.getTime() - pos.entry_at.getTime();
    const holdDays = holdMs / (1000 * 60 * 60 * 24);
    // Rough: 1 calendar day = ~0.71 trading days (5/7). Better: count weekdays.
    const tradingDays = Math.floor(holdDays * 5 / 7);
    if (tradingDays >= exits.time_exit_days) {
      return { should_exit: true, reason: "TIME", exit_price: pos.current_price, new_trailing_stop: newTrailingStop, new_trailing_active: newTrailingActive };
    }
  }

  return { should_exit: false, reason: null, exit_price: pos.current_price, new_trailing_stop: newTrailingStop, new_trailing_active: newTrailingActive };
}

// ─── P&L Calculation ───────────────────────────────────────────────────────

export function computePnL(
  entryPrice: number,
  exitPrice: number,
  investmentUsd: number,
  leverage: number
): { pnl_usd: number; pnl_pct: number } {
  if (entryPrice <= 0) return { pnl_usd: 0, pnl_pct: 0 };
  const rawPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  const leveragedPct = rawPct * leverage;
  // P&L is capped at -100% of investment (can't lose more than you put in)
  const cappedPct = Math.max(leveragedPct, -100);
  const pnlUsd = investmentUsd * (cappedPct / 100);
  return { pnl_usd: pnlUsd, pnl_pct: cappedPct };
}

// ─── Strategy Definitions (the 8 scenarios) ────────────────────────────────

export const STRATEGY_TEMPLATES: Array<{
  name: string;
  strategy_type: "TRADING" | "ANALYSIS";
  config: StrategyConfig;
}> = [
  {
    name: "Baseline 3D",
    strategy_type: "TRADING",
    config: {
      entry: { direction: "LONG", min_drop_pct: -7, max_drop_pct: -15, max_consecutive_days: 3, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 1000, max_concurrent: 15, max_new_per_day: 3 },
      exits: { time_exit_days: 3, hard_stop_pct: -7 },
    },
  },
  {
    name: "Trailing 2%",
    strategy_type: "TRADING",
    config: {
      entry: { direction: "LONG", min_drop_pct: -7, max_drop_pct: -15, max_consecutive_days: 3, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 1000, max_concurrent: 15, max_new_per_day: 3 },
      exits: { trailing_stop_pct: 2, trailing_activates_at_profit_pct: 1, hard_stop_pct: -7, time_exit_days: 7 },
    },
  },
  {
    name: "Hybrid",
    strategy_type: "TRADING",
    config: {
      entry: { direction: "LONG", min_drop_pct: -7, max_drop_pct: -15, max_consecutive_days: 3, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 1000, max_concurrent: 15, max_new_per_day: 3 },
      exits: { hard_stop_pct: -7, trailing_stop_pct: 3, trailing_activates_at_profit_pct: 2, time_exit_days: 5 },
    },
  },
  {
    name: "Big Drop",
    strategy_type: "TRADING",
    config: {
      entry: { direction: "LONG", min_drop_pct: -10, max_drop_pct: -20, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 1000, max_concurrent: 15, max_new_per_day: 3 },
      exits: { time_exit_days: 5, hard_stop_pct: -10 },
    },
  },
  {
    name: "Take Profit 3%",
    strategy_type: "TRADING",
    config: {
      entry: { direction: "LONG", min_drop_pct: -7, max_drop_pct: -15, max_consecutive_days: 3, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 1000, max_concurrent: 15, max_new_per_day: 3 },
      exits: { take_profit_pct: 3, hard_stop_pct: -5, time_exit_days: 5 },
    },
  },
  {
    name: "Reversal Detector",
    strategy_type: "TRADING",
    config: {
      entry: { direction: "LONG", min_drop_pct: -5, max_drop_pct: -15, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 1000, max_concurrent: 15, max_new_per_day: 5 },
      exits: { trailing_stop_pct: 3, trailing_activates_at_profit_pct: 0, hard_stop_pct: -5, time_exit_days: 10 },
    },
  },
  {
    name: "Big Win Riders",
    strategy_type: "TRADING",
    config: {
      entry: { direction: "LONG", min_drop_pct: -7, max_drop_pct: -15, max_consecutive_days: 3, min_price: 5 },
      sizing: { type: "fixed", amount_usd: 1000, max_concurrent: 15, max_new_per_day: 3 },
      exits: { trailing_stop_pct: 1, trailing_activates_at_profit_pct: 3, hard_stop_pct: -7, time_exit_days: 10 },
    },
  },
  {
    name: "Analysis Only",
    strategy_type: "ANALYSIS",
    config: {
      entry: { direction: "ANY", min_price: 5 },
      sizing: { type: "fixed", amount_usd: 1000, max_concurrent: 100, max_new_per_day: 20 },
      exits: { time_exit_days: 10 },
    },
  },
];

/** 3 leverage tiers per template = 24 total strategies */
export const LEVERAGE_TIERS = [1, 5, 10];

/**
 * Generate all 24 strategy definitions (8 templates × 3 leverage tiers).
 * Returns { name, strategy_type, leverage, config } for each.
 */
export function generateAllStrategies(): Array<{
  name: string;
  strategy_type: "TRADING" | "ANALYSIS";
  leverage: number;
  config: StrategyConfig;
}> {
  const result: Array<{ name: string; strategy_type: "TRADING" | "ANALYSIS"; leverage: number; config: StrategyConfig }> = [];
  for (const tmpl of STRATEGY_TEMPLATES) {
    for (const lev of LEVERAGE_TIERS) {
      result.push({
        name: `${tmpl.name} (${lev}x)`,
        strategy_type: tmpl.strategy_type,
        leverage: lev,
        config: tmpl.config,
      });
    }
  }
  return result;
}
