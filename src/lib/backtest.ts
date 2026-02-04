import { StrategySpec } from "@/lib/strategy";

export type PriceBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Trade = {
  entry_date: string;
  side: "LONG" | "SHORT";
  entry_price: number;
  exit_date: string;
  exit_price: number;
  exit_reason: "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "TIME_EXIT" | "SAR_FLIP";
  pnl_usd: number;
  pnl_pct: number;
  fees_usd: number;
  interest_usd: number;
  meta_json?: string;
};

export type RunMetrics = {
  total_pnl_usd: number;
  total_return_pct: number;
  win_rate: number;
  trades_count: number;
  max_drawdown_pct: number;
  worst_losing_streak: number;
  max_martingale_step_reached: number;
  martingale_step_escalations: number;
  avg_trade_pct: number;
  median_trade_pct: number;
};

type ExitResult = {
  exitIndex: number;
  exitPrice: number;
  exitReason: Trade["exit_reason"];
  meta?: Record<string, unknown>;
};

function applySlippage(price: number, side: "LONG" | "SHORT", bps: number, isEntry: boolean) {
  const factor = bps / 10000;
  if (side === "LONG") {
    return isEntry ? price * (1 + factor) : price * (1 - factor);
  }
  return isEntry ? price * (1 - factor) : price * (1 + factor);
}

function computeInterest(positionValue: number, leverage: number, capital: number, apr: number, daysHeld: number) {
  if (leverage <= 1) return 0;
  const borrowed = Math.max(0, positionValue - capital);
  const dailyRate = apr / 365;
  return borrowed * dailyRate * daysHeld;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function calculateMAs(prices: PriceBar[], length: number) {
  const ma: Array<number | null> = Array(prices.length).fill(null);
  let sum = 0;
  for (let i = 0; i < prices.length; i += 1) {
    sum += prices[i].close;
    if (i >= length) sum -= prices[i - length].close;
    if (i >= length - 1) {
      ma[i] = sum / length;
    }
  }
  return ma;
}

function isSignalAllowedByRegime(spec: StrategySpec, close: number, ma: number | null, side: "LONG" | "SHORT") {
  if (!spec.regime_filter || !ma) return true;
  if (close > ma && side === "SHORT") return false;
  if (close < ma && side === "LONG") return false;
  return true;
}

function resolveStopTake(
  side: "LONG" | "SHORT",
  day: PriceBar,
  entryPrice: number,
  stopLossPct: number,
  takeProfitPct?: number
): ExitResult | null {
  const stopPrice = side === "LONG"
    ? entryPrice * (1 - stopLossPct)
    : entryPrice * (1 + stopLossPct);
  const takePrice = takeProfitPct
    ? side === "LONG"
      ? entryPrice * (1 + takeProfitPct)
      : entryPrice * (1 - takeProfitPct)
    : undefined;

  const stopHit = side === "LONG" ? day.low <= stopPrice : day.high >= stopPrice;
  const takeHit =
    takePrice !== undefined
      ? side === "LONG"
        ? day.high >= takePrice
        : day.low <= takePrice
      : false;

  if (stopHit && takeHit) {
    return {
      exitIndex: -1,
      exitPrice: stopPrice,
      exitReason: "STOP_LOSS",
    };
  }

  if (stopHit) {
    return {
      exitIndex: -1,
      exitPrice: stopPrice,
      exitReason: "STOP_LOSS",
    };
  }

  if (takeHit && takePrice !== undefined) {
    return {
      exitIndex: -1,
      exitPrice: takePrice,
      exitReason: "TAKE_PROFIT",
    };
  }

  return null;
}

function resolveTrailing(
  side: "LONG" | "SHORT",
  day: PriceBar,
  trailingPct: number,
  peak: number,
  trough: number
): { exit?: ExitResult; peak: number; trough: number } {
  let nextPeak = peak;
  let nextTrough = trough;
  if (side === "LONG") {
    nextPeak = Math.max(peak, day.high);
    const trailPrice = nextPeak * (1 - trailingPct);
    if (day.low <= trailPrice) {
      return {
        exit: { exitIndex: -1, exitPrice: trailPrice, exitReason: "TRAILING_STOP" },
        peak: nextPeak,
        trough: nextTrough,
      };
    }
  } else {
    nextTrough = Math.min(trough, day.low);
    const trailPrice = nextTrough * (1 + trailingPct);
    if (day.high >= trailPrice) {
      return {
        exit: { exitIndex: -1, exitPrice: trailPrice, exitReason: "TRAILING_STOP" },
        peak: nextPeak,
        trough: nextTrough,
      };
    }
  }
  return { peak: nextPeak, trough: nextTrough };
}

function simulateTrade(
  prices: PriceBar[],
  entryIndex: number,
  side: "LONG" | "SHORT",
  spec: StrategySpec
): ExitResult {
  const entryDay = prices[entryIndex];
  const slippage = spec.costs.slippage_bps;
  const entryBasePrice = spec.template === "gap_fade" ? entryDay.open : entryDay.close;
  const entryPrice = applySlippage(entryBasePrice, side, slippage, true);
  const stopLossPct = spec.stop_loss_pct;
  const trailingPct = "trailing_stop_pct" in spec ? spec.trailing_stop_pct : undefined;
  const takeProfitPct =
    trailingPct !== undefined
      ? undefined
      : "take_profit_pct" in spec
        ? spec.take_profit_pct
        : undefined;
  const holdDays = spec.hold_max_days;

  let peak = entryDay.high;
  let trough = entryDay.low;

  const evaluateDay = (dayIndex: number) => {
    const day = prices[dayIndex];
    const stopTake = resolveStopTake(side, day, entryPrice, stopLossPct, takeProfitPct);
    if (stopTake) {
      return {
        exitIndex: dayIndex,
        exitPrice: stopTake.exitPrice,
        exitReason: stopTake.exitReason,
      } as ExitResult;
    }

    if (trailingPct !== undefined) {
      const trailing = resolveTrailing(side, day, trailingPct, peak, trough);
      peak = trailing.peak;
      trough = trailing.trough;
      if (trailing.exit) {
        return { ...trailing.exit, exitIndex: dayIndex } as ExitResult;
      }
    }

    return null;
  };

  if (holdDays === 0) {
    const exitSameDay = evaluateDay(entryIndex);
    if (exitSameDay) {
      return exitSameDay;
    }
    return {
      exitIndex: entryIndex,
      exitPrice: entryDay.close,
      exitReason: "TIME_EXIT",
    };
  }

  for (let dayOffset = 1; dayOffset <= holdDays; dayOffset += 1) {
    const dayIndex = entryIndex + dayOffset;
    if (!prices[dayIndex]) break;
    const exit = evaluateDay(dayIndex);
    if (exit) {
      return exit;
    }
  }

  const exitIndex = Math.min(entryIndex + holdDays, prices.length - 1);
  return {
    exitIndex,
    exitPrice: prices[exitIndex].close,
    exitReason: "TIME_EXIT",
  };
}

export function runBacktest(prices: PriceBar[], spec: StrategySpec) {
  const trades: Trade[] = [];
  let equity = 0;
  let peakEquity = 0;
  let maxDrawdown = 0;
  let winCount = 0;
  let losingStreak = 0;
  let worstLosingStreak = 0;

  let martingaleStep = 0;
  let maxMartingaleStep = 0;
  let martingaleEscalations = 0;

  const maLength = spec.regime_filter?.length ?? 0;
  const maValues = maLength ? calculateMAs(prices, maLength) : [];

  const baseCapital = spec.martingale_lite
    ? spec.martingale_lite.base_capital_usd
    : spec.capital_base_usd;

  const leverage = spec.martingale_lite
    ? spec.martingale_lite.leverage
    : spec.leverage;

  const canIncreaseStep = () => {
    if (!spec.martingale_lite) return false;
    const nextStep = martingaleStep + 1;
    if (nextStep > spec.martingale_lite.max_steps) return false;
    const rawValue = baseCapital * leverage * Math.pow(spec.martingale_lite.step_multiplier, nextStep);
    if (rawValue > spec.martingale_lite.max_exposure_usd) return false;
    const worstLoss = rawValue * spec.stop_loss_pct;
    if (worstLoss > spec.martingale_lite.max_daily_loss_usd) return false;
    return true;
  };

  const resolvePositionValue = () => {
    let value = baseCapital * leverage;
    if (spec.martingale_lite) {
      value = value * Math.pow(spec.martingale_lite.step_multiplier, martingaleStep);
      if (value > spec.martingale_lite.max_exposure_usd) {
        value = spec.martingale_lite.max_exposure_usd;
      }
      const worstLoss = value * spec.stop_loss_pct;
      if (worstLoss > spec.martingale_lite.max_daily_loss_usd) {
        value = spec.martingale_lite.max_daily_loss_usd / spec.stop_loss_pct;
      }
    }
    return value;
  };

  let i = 1;
  let streakUp = 0;
  let streakDown = 0;

  while (i < prices.length) {
    const today = prices[i];
    const prev = prices[i - 1];

    if (spec.template === "gap_fade") {
      const gapPct = (today.open - prev.close) / prev.close;
      if (Math.abs(gapPct) >= spec.gap_threshold_pct) {
        const side: "LONG" | "SHORT" = gapPct > 0 ? "SHORT" : "LONG";
        if (isSignalAllowedByRegime(spec, today.close, maValues[i] ?? null, side)) {
          const positionValue = resolvePositionValue();
          const exit = simulateTrade(prices, i, side, spec);
          const trade = buildTrade(prices, i, exit, side, spec, positionValue, baseCapital, leverage);
          trades.push(trade);
          updateStats(trade);
        }
      }
      i += 1;
      continue;
    }

    if (today.close > prev.close) {
      streakUp += 1;
      streakDown = 0;
    } else if (today.close < prev.close) {
      streakDown += 1;
      streakUp = 0;
    } else {
      streakUp = 0;
      streakDown = 0;
    }

    const streakLength = spec.streak_length;
    let signalSide: "LONG" | "SHORT" | null = null;

    if (streakUp >= streakLength) {
      signalSide = spec.direction === "fade" ? "SHORT" : "LONG";
    } else if (streakDown >= streakLength) {
      signalSide = spec.direction === "fade" ? "LONG" : "SHORT";
    }

    if (!signalSide) {
      i += 1;
      continue;
    }

    if (!isSignalAllowedByRegime(spec, today.close, maValues[i] ?? null, signalSide)) {
      i += 1;
      continue;
    }

    const positionValue = resolvePositionValue();
    const exit = simulateTrade(prices, i, signalSide, spec);
    const trade = buildTrade(prices, i, exit, signalSide, spec, positionValue, baseCapital, leverage);
    trades.push(trade);
    updateStats(trade);

    if (spec.template === "sar_fade_flip" && trade.exit_reason === "STOP_LOSS" && spec.flip_on_stop) {
      let flipCount = 0;
      while (flipCount < spec.flip_max_times) {
        const flipEntryIndex = Math.min(exit.exitIndex, prices.length - 1);
        const flipSide = signalSide === "LONG" ? "SHORT" : "LONG";
        if (!prices[flipEntryIndex]) break;
        const flipExit = simulateTrade(prices, flipEntryIndex, flipSide, spec);
        const flipTrade = buildTrade(prices, flipEntryIndex, flipExit, flipSide, spec, positionValue, baseCapital, leverage, {
          flip_from: signalSide,
        });
        flipTrade.exit_reason = "SAR_FLIP";
        trades.push(flipTrade);
        updateStats(flipTrade);
        i = flipExit.exitIndex + 1;
        flipCount += 1;
        if (flipTrade.pnl_usd >= 0) break;
      }
    }

    i = exit.exitIndex + 1;
  }

  const tradePnls = trades.map((trade) => trade.pnl_pct);
  const totalPnl = trades.reduce((sum, trade) => sum + trade.pnl_usd, 0);
  const avgTrade = trades.length ? tradePnls.reduce((sum, v) => sum + v, 0) / trades.length : 0;

  const metrics: RunMetrics = {
    total_pnl_usd: totalPnl,
    total_return_pct: baseCapital ? totalPnl / baseCapital : 0,
    win_rate: trades.length ? winCount / trades.length : 0,
    trades_count: trades.length,
    max_drawdown_pct: baseCapital ? maxDrawdown / baseCapital : 0,
    worst_losing_streak: worstLosingStreak,
    max_martingale_step_reached: maxMartingaleStep,
    martingale_step_escalations: martingaleEscalations,
    avg_trade_pct: avgTrade,
    median_trade_pct: median(tradePnls),
  };

  return { trades, metrics };

  function updateStats(trade: Trade) {
    equity += trade.pnl_usd;
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity - equity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    if (trade.pnl_usd >= 0) {
      winCount += 1;
      losingStreak = 0;
      if (spec.martingale_lite) {
        martingaleStep = 0;
      }
    } else {
      losingStreak += 1;
      worstLosingStreak = Math.max(worstLosingStreak, losingStreak);
      if (spec.martingale_lite && canIncreaseStep()) {
        martingaleStep += 1;
        martingaleEscalations += 1;
        maxMartingaleStep = Math.max(maxMartingaleStep, martingaleStep);
      }
    }
  }
}

function buildTrade(
  prices: PriceBar[],
  entryIndex: number,
  exit: ExitResult,
  side: "LONG" | "SHORT",
  spec: StrategySpec,
  positionValue: number,
  baseCapital: number,
  leverage: number,
  meta?: Record<string, unknown>
): Trade {
  const entryDay = prices[entryIndex];
  const exitDay = prices[exit.exitIndex];
  const entryBasePrice = spec.template === "gap_fade" ? entryDay.open : entryDay.close;
  const entryPrice = applySlippage(entryBasePrice, side, spec.costs.slippage_bps, true);
  const exitPrice = applySlippage(exit.exitPrice, side, spec.costs.slippage_bps, false);
  const quantity = positionValue / entryPrice;
  const grossPnl = side === "LONG" ? (exitPrice - entryPrice) * quantity : (entryPrice - exitPrice) * quantity;
  const fees = spec.costs.commission_per_side_usd * 2;
  const daysHeld = Math.max(1, exit.exitIndex - entryIndex + 1);
  const interest = computeInterest(positionValue, leverage, baseCapital, spec.costs.margin_interest_apr, daysHeld);
  const pnl = grossPnl - fees - interest;

  return {
    entry_date: entryDay.date,
    side,
    entry_price: entryPrice,
    exit_date: exitDay.date,
    exit_price: exitPrice,
    exit_reason: exit.exitReason,
    pnl_usd: pnl,
    pnl_pct: baseCapital ? pnl / baseCapital : 0,
    fees_usd: fees,
    interest_usd: interest,
    meta_json: meta ? JSON.stringify(meta) : undefined,
  };
}
