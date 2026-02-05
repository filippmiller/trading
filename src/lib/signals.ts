import { PriceBar } from "@/lib/backtest";
import { StrategySpec } from "@/lib/strategy";

export type Signal = {
  side: "LONG" | "SHORT";
  reason: string;
  entryPrice: number;
  template: string;
  symbol: string;
};

function calculateMAs(prices: PriceBar[], length: number): Array<number | null> {
  const ma: Array<number | null> = Array(prices.length).fill(null);
  let sum = 0;
  for (let i = 0; i < prices.length; i++) {
    sum += prices[i].close;
    if (i >= length) sum -= prices[i - length].close;
    if (i >= length - 1) {
      ma[i] = sum / length;
    }
  }
  return ma;
}

function isSignalAllowedByRegime(
  spec: StrategySpec,
  close: number,
  ma: number | null,
  side: "LONG" | "SHORT"
): boolean {
  if (!spec.regime_filter || !ma) return true;
  if (close > ma && side === "SHORT") return false;
  if (close < ma && side === "LONG") return false;
  return true;
}

/**
 * Check if the latest bar would trigger an entry signal for the given strategy spec.
 * Returns the signal if triggered, null otherwise.
 */
export function checkSignalToday(prices: PriceBar[], spec: StrategySpec): Signal | null {
  if (prices.length < 10) return null;

  const maLength = spec.regime_filter?.length ?? 0;
  const maValues = maLength ? calculateMAs(prices, maLength) : [];

  const i = prices.length - 1;
  const today = prices[i];
  const prev = prices[i - 1];

  // Gap fade detection
  if (spec.template === "gap_fade") {
    const gapPct = (today.open - prev.close) / prev.close;
    if (Math.abs(gapPct) >= spec.gap_threshold_pct) {
      const side: "LONG" | "SHORT" = gapPct > 0 ? "SHORT" : "LONG";
      if (isSignalAllowedByRegime(spec, today.close, maValues[i] ?? null, side)) {
        return {
          side,
          reason: `Gap ${gapPct > 0 ? "up" : "down"} of ${(Math.abs(gapPct) * 100).toFixed(2)}% exceeds threshold`,
          entryPrice: today.open,
          template: spec.template,
          symbol: spec.symbol,
        };
      }
    }
    return null;
  }

  // Streak detection for streak_fade, streak_follow, sar_fade_flip
  if (
    spec.template === "streak_fade" ||
    spec.template === "streak_follow" ||
    spec.template === "sar_fade_flip"
  ) {
    // Calculate current streak
    let streakUp = 0;
    let streakDown = 0;

    for (let j = i; j > 0; j--) {
      const bar = prices[j];
      const prevBar = prices[j - 1];
      if (bar.close > prevBar.close) {
        if (streakDown > 0) break;
        streakUp++;
      } else if (bar.close < prevBar.close) {
        if (streakUp > 0) break;
        streakDown++;
      } else {
        break;
      }
    }

    const streakLength = spec.streak_length;
    let signalSide: "LONG" | "SHORT" | null = null;
    let reason = "";

    if (streakUp >= streakLength) {
      signalSide = spec.direction === "fade" ? "SHORT" : "LONG";
      reason = `${streakUp} consecutive up days (${spec.direction === "fade" ? "fading" : "following"} trend)`;
    } else if (streakDown >= streakLength) {
      signalSide = spec.direction === "fade" ? "LONG" : "SHORT";
      reason = `${streakDown} consecutive down days (${spec.direction === "fade" ? "fading" : "following"} trend)`;
    }

    if (!signalSide) return null;

    if (!isSignalAllowedByRegime(spec, today.close, maValues[i] ?? null, signalSide)) {
      return null;
    }

    return {
      side: signalSide,
      reason,
      entryPrice: today.close,
      template: spec.template,
      symbol: spec.symbol,
    };
  }

  return null;
}

/**
 * Check signals for multiple specs against price data.
 */
export function checkSignalsForSpecs(
  prices: PriceBar[],
  specs: Array<{ name: string; spec: StrategySpec }>
): Array<{ name: string; signal: Signal }> {
  const results: Array<{ name: string; signal: Signal }> = [];

  for (const { name, spec } of specs) {
    const signal = checkSignalToday(prices, spec);
    if (signal) {
      results.push({ name, signal });
    }
  }

  return results;
}
