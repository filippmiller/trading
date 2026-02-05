import { NextResponse } from "next/server";

import { loadPrices } from "@/lib/data";
import { runBacktest, RunMetrics } from "@/lib/backtest";
import { clampSpec, StrategySpecSchema, StrategySpec } from "@/lib/strategy";

type SweepRequest = {
  baseSpec: StrategySpec;
  stopLossRange: [number, number]; // [min, max]
  takeProfitRange: [number, number]; // [min, max]
  steps: number; // grid size
};

type SweepResult = {
  stopLossPct: number;
  takeProfitPct: number;
  metrics: RunMetrics;
};

function generateRange(min: number, max: number, steps: number): number[] {
  if (steps <= 1) return [min];
  const result: number[] = [];
  for (let i = 0; i < steps; i++) {
    result.push(min + ((max - min) * i) / (steps - 1));
  }
  return result;
}

export async function POST(req: Request) {
  try {
    const body: SweepRequest = await req.json();
    const {
      baseSpec,
      stopLossRange = [0.003, 0.02],
      takeProfitRange = [0.005, 0.03],
      steps = 5,
    } = body;

    if (!baseSpec) {
      return NextResponse.json({ error: "Base spec required." }, { status: 400 });
    }

    // Validate ranges
    if (!Array.isArray(stopLossRange) || stopLossRange.length !== 2) {
      return NextResponse.json({ error: "stopLossRange must be [min, max]" }, { status: 400 });
    }
    if (!Array.isArray(takeProfitRange) || takeProfitRange.length !== 2) {
      return NextResponse.json({ error: "takeProfitRange must be [min, max]" }, { status: 400 });
    }
    if (stopLossRange[0] >= stopLossRange[1]) {
      return NextResponse.json({ error: "stopLossRange min must be < max" }, { status: 400 });
    }
    if (takeProfitRange[0] >= takeProfitRange[1]) {
      return NextResponse.json({ error: "takeProfitRange min must be < max" }, { status: 400 });
    }
    if (stopLossRange[0] < 0.001 || stopLossRange[1] > 0.2) {
      return NextResponse.json({ error: "stopLossRange must be between 0.1% and 20%" }, { status: 400 });
    }
    if (takeProfitRange[0] < 0 || takeProfitRange[1] > 0.2) {
      return NextResponse.json({ error: "takeProfitRange must be between 0% and 20%" }, { status: 400 });
    }

    // Validate and clamp base spec
    let validatedSpec: StrategySpec;
    try {
      validatedSpec = clampSpec(StrategySpecSchema.parse(baseSpec));
    } catch {
      return NextResponse.json({ error: "Invalid base spec." }, { status: 400 });
    }

    // Limit grid size to prevent abuse
    const clampedSteps = Math.min(Math.max(steps, 2), 10);
    const totalRuns = clampedSteps * clampedSteps;

    if (totalRuns > 100) {
      return NextResponse.json({ error: "Grid too large. Max 100 runs." }, { status: 400 });
    }

    // Load price data
    const prices = await loadPrices(validatedSpec.lookback_days, validatedSpec.symbol);
    if (prices.length < 20) {
      return NextResponse.json({ error: "Not enough price data." }, { status: 400 });
    }

    // Generate parameter ranges
    const stopLosses = generateRange(stopLossRange[0], stopLossRange[1], clampedSteps);
    const takeProfits = generateRange(takeProfitRange[0], takeProfitRange[1], clampedSteps);

    // Run all combinations
    const results: SweepResult[] = [];

    for (const sl of stopLosses) {
      for (const tp of takeProfits) {
        try {
          const spec: StrategySpec = {
            ...validatedSpec,
            stop_loss_pct: sl,
            take_profit_pct: tp > 0 ? tp : undefined,
          } as StrategySpec;

          const { metrics } = runBacktest(prices, clampSpec(StrategySpecSchema.parse(spec)));

          results.push({
            stopLossPct: sl,
            takeProfitPct: tp,
            metrics,
          });
        } catch (error) {
          // Skip invalid combinations
          console.error("Sweep run error:", error);
        }
      }
    }

    // Find best result
    const bestResult = results.reduce((best, current) =>
      current.metrics.total_return_pct > best.metrics.total_return_pct ? current : best
    );

    return NextResponse.json({
      results,
      gridSize: clampedSteps,
      totalRuns: results.length,
      bestResult,
      symbol: validatedSpec.symbol,
      template: validatedSpec.template,
    });
  } catch (error) {
    console.error("sweep error", error);
    return NextResponse.json({ error: "Sweep failed." }, { status: 500 });
  }
}
