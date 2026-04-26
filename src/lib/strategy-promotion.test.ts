import { describe, expect, it } from "vitest";

import {
  buildPromotedStrategyConfig,
  PromoteStrategySchema,
  type PromoteStrategyInput,
} from "./strategy-promotion";

function baseInput(overrides: Partial<PromoteStrategyInput> = {}): PromoteStrategyInput {
  const input: PromoteStrategyInput = {
    name: "Grid UP LONG 3d",
    accountInitialCash: 100000,
    filters: {
      direction: "UP",
      minDayChangePct: 3,
      maxDayChangePct: 10,
      minStreak: 2,
      maxStreak: 5,
      enrollmentSources: ["MOVERS"],
    },
    trade: {
      investmentUsd: 100,
      leverage: 5,
      tradeDirection: "LONG",
    },
    costs: {
      commissionRoundTrip: 2,
      marginApyPct: 7,
    },
    row: {
      holdDays: 3,
      exitBar: "close",
      entryDelayDays: 0,
      entryBar: "close",
      hardStopPct: -5,
      takeProfitPct: 10,
      trailingStopPct: null,
      breakevenAtPct: null,
      n: 20,
      winRate: 65,
      totalPnlUsd: 1234,
      avgPnlPct: 3.4,
      bestPct: 20,
      worstPct: -7,
      profitFactor: 2.1,
      sharpeRatio: 1.2,
      avgHoldDays: 2.8,
    },
  };
  return { ...input, ...overrides };
}

describe("strategy promotion", () => {
  it("maps UP cohort research to SHORT cohort filter with LONG trade override", () => {
    const { config } = buildPromotedStrategyConfig(baseInput(), "2026-04-26T00:00:00.000Z");

    expect(config.entry).toMatchObject({
      direction: "SHORT",
      trade_direction: "LONG",
      min_rise_pct: 3,
      max_rise_pct: 10,
      min_consecutive_days: 2,
      max_consecutive_days: 5,
      enrollment_source: "MOVERS",
    });
    expect(config.sizing.amount_usd).toBe(100);
    expect(config.exits).toMatchObject({
      time_exit_days: 3,
      hard_stop_pct: -5,
      take_profit_pct: 10,
    });
    expect(config.research_provenance.source).toBe("grid_sweep");
  });

  it("maps DOWN magnitude filters to negative drop bounds", () => {
    const { config } = buildPromotedStrategyConfig(baseInput({
      filters: { direction: "DOWN", minDayChangePct: 4, maxDayChangePct: 12 },
      trade: { investmentUsd: 250, leverage: 2, tradeDirection: "SHORT" },
    }));

    expect(config.entry).toMatchObject({
      direction: "LONG",
      trade_direction: "SHORT",
      min_drop_pct: -4,
      max_drop_pct: -12,
    });
  });

  it("keeps research-only axes in provenance and emits warnings", () => {
    const { config, warnings } = buildPromotedStrategyConfig(baseInput({
      row: {
        ...baseInput().row,
        entryDelayDays: 2,
        entryBar: "morning",
        exitBar: "midday",
        breakevenAtPct: 3,
      },
    }));

    expect(warnings.length).toBeGreaterThanOrEqual(4);
    expect(config.research_provenance.grid_row.entryDelayDays).toBe(2);
    expect(config.research_provenance.grid_row.breakevenAtPct).toBe(3);
  });

  it("validates promoted payload bounds", () => {
    expect(PromoteStrategySchema.safeParse(baseInput()).success).toBe(true);
    expect(PromoteStrategySchema.safeParse(baseInput({
      trade: { investmentUsd: 100, leverage: 101, tradeDirection: "LONG" },
    })).success).toBe(false);
    expect(PromoteStrategySchema.safeParse(baseInput({
      row: { ...baseInput().row, hardStopPct: 5 },
    })).success).toBe(false);
  });
});
