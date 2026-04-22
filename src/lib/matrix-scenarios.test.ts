import { describe, it, expect } from "vitest";
import {
  SCENARIOS,
  getScenario,
  computeStreak,
  resolveDirection,
  evaluateScenario,
  summarizeScenario,
  computeRecurrences,
  compareAllScenarios,
  type ScenarioTickerInput,
  type ScenarioSnapshotInput,
  type ScenarioParams,
  type MatrixScenario,
} from "./matrix-scenarios";

const params: ScenarioParams = { investment: 100, leverage: 5 };

function ticker(overrides: Partial<ScenarioTickerInput> = {}): ScenarioTickerInput {
  return {
    symbol: "AAPL",
    entryPrice: 100,
    dayChangePct: 1,
    consecutiveDays: 1,
    ...overrides,
  };
}

function tl(...entries: Array<[string, number | null]>): ScenarioSnapshotInput[] {
  return entries.map(([key, price]) => ({ key, price }));
}

// -----------------------------------------------------------------------------
// SCENARIOS catalog — stable contract
// -----------------------------------------------------------------------------

describe("SCENARIOS catalog", () => {
  it("exposes exactly the 5 documented scenario ids", () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual([
      "momentum",
      "reversal",
      "three_day_slide_bounce",
      "four_day_rally_fade",
      "extreme_streak_reversal",
    ]);
  });

  it("getScenario throws on unknown id", () => {
    // @ts-expect-error — intentionally bad id
    expect(() => getScenario("not_a_scenario")).toThrow(/Unknown scenario/);
  });
});

// -----------------------------------------------------------------------------
// computeStreak — pure UP/DOWN/MIXED classifier
// -----------------------------------------------------------------------------

describe("computeStreak", () => {
  it("returns UP for strictly increasing closes", () => {
    expect(computeStreak([100, 101, 102, 103], 3)).toBe("UP");
  });

  it("returns DOWN for strictly decreasing closes", () => {
    expect(computeStreak([103, 102, 101, 100], 3)).toBe("DOWN");
  });

  it("returns MIXED for a reversal inside the window", () => {
    expect(computeStreak([100, 101, 100, 102], 3)).toBe("MIXED");
  });

  it("returns MIXED when there isn't enough history for n diffs", () => {
    expect(computeStreak([100, 101], 3)).toBe("MIXED");
  });

  it("treats flat day (==) as MIXED — strict monotonicity", () => {
    expect(computeStreak([100, 101, 101, 102], 3)).toBe("MIXED");
  });

  it("handles n=1", () => {
    expect(computeStreak([100, 101], 1)).toBe("UP");
    expect(computeStreak([101, 100], 1)).toBe("DOWN");
  });

  it("returns MIXED for invalid input (n<1, non-array)", () => {
    expect(computeStreak([100, 101, 102], 0)).toBe("MIXED");
    // @ts-expect-error
    expect(computeStreak(null, 3)).toBe("MIXED");
  });
});

// -----------------------------------------------------------------------------
// resolveDirection — scenario ↔ ticker direction logic
// -----------------------------------------------------------------------------

describe("resolveDirection", () => {
  const momentum = getScenario("momentum");
  const reversal = getScenario("reversal");
  const slideBounce = getScenario("three_day_slide_bounce");
  const rallyFade = getScenario("four_day_rally_fade");
  const extreme = getScenario("extreme_streak_reversal");

  it("momentum follows sign of dayChangePct", () => {
    expect(resolveDirection(momentum, ticker({ dayChangePct: 2 }))).toBe(1);
    expect(resolveDirection(momentum, ticker({ dayChangePct: -2 }))).toBe(-1);
  });

  it("momentum returns 0 for a perfectly flat day", () => {
    expect(resolveDirection(momentum, ticker({ dayChangePct: 0 }))).toBe(0);
  });

  it("reversal is the exact opposite of momentum", () => {
    expect(resolveDirection(reversal, ticker({ dayChangePct: 2 }))).toBe(-1);
    expect(resolveDirection(reversal, ticker({ dayChangePct: -2 }))).toBe(1);
  });

  it("three_day_slide_bounce rejects shorter streaks", () => {
    expect(
      resolveDirection(slideBounce, ticker({ consecutiveDays: 2, dayChangePct: -1 })),
    ).toBe(0);
  });

  it("three_day_slide_bounce rejects UP days even with long streak", () => {
    // streak gate requires DOWN side; UP day disqualifies
    expect(
      resolveDirection(slideBounce, ticker({ consecutiveDays: 5, dayChangePct: 1 })),
    ).toBe(0);
  });

  it("three_day_slide_bounce fires LONG on 3+ day DOWN streak", () => {
    expect(
      resolveDirection(slideBounce, ticker({ consecutiveDays: 3, dayChangePct: -1 })),
    ).toBe(1);
    expect(
      resolveDirection(slideBounce, ticker({ consecutiveDays: 7, dayChangePct: -0.1 })),
    ).toBe(1);
  });

  it("four_day_rally_fade fires SHORT on 4+ day UP streak", () => {
    expect(
      resolveDirection(rallyFade, ticker({ consecutiveDays: 4, dayChangePct: 0.5 })),
    ).toBe(-1);
    expect(
      resolveDirection(rallyFade, ticker({ consecutiveDays: 3, dayChangePct: 0.5 })),
    ).toBe(0);
  });

  it("extreme_streak_reversal (EITHER side) is contrarian", () => {
    expect(
      resolveDirection(extreme, ticker({ consecutiveDays: 6, dayChangePct: 2 })),
    ).toBe(-1); // long UP streak → fade SHORT
    expect(
      resolveDirection(extreme, ticker({ consecutiveDays: 6, dayChangePct: -2 })),
    ).toBe(1); // long DOWN streak → buy LONG
  });

  it("EITHER side rejects dayChangePct == 0 (no sign to flip)", () => {
    expect(
      resolveDirection(extreme, ticker({ consecutiveDays: 6, dayChangePct: 0 })),
    ).toBe(0);
  });

  it("handles null consecutiveDays as streak=0 → gated scenarios return 0", () => {
    expect(
      resolveDirection(slideBounce, ticker({ consecutiveDays: null, dayChangePct: -1 })),
    ).toBe(0);
  });

  it("uses |consecutiveDays| when given a negative streak value", () => {
    // guards against upstream encoding that stores sign in streak length
    expect(
      resolveDirection(
        slideBounce,
        ticker({ consecutiveDays: -5, dayChangePct: -1 }),
      ),
    ).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// evaluateScenario — per-snapshot PnL, liquidation, daysHeld
// -----------------------------------------------------------------------------

describe("evaluateScenario", () => {
  it("produces grey row (pnl null, direction 0) for non-matching ticker but keeps snapshot keys", () => {
    const r = evaluateScenario(
      "three_day_slide_bounce",
      ticker({ consecutiveDays: 1, dayChangePct: 1 }), // doesn't qualify
      tl(["d1_morning", 101], ["d1_close", 102]),
      params,
    );
    expect(r.matches).toBe(false);
    expect(r.direction).toBe(0);
    expect(r.snapshots).toHaveLength(2);
    expect(r.snapshots.every((s) => s.pnlUsd === null && s.pnlPct === null)).toBe(true);
    expect(r.latestPnlUsd).toBeNull();
  });

  it("computes momentum LONG PnL across snapshots with 5x leverage", () => {
    const r = evaluateScenario(
      "momentum",
      ticker({ entryPrice: 100, dayChangePct: 1 }),
      tl(["d1_morning", 101], ["d1_close", 102], ["d2_close", 104]),
      params,
    );
    expect(r.direction).toBe(1);
    // 1% move × 5x = 5% = $5 on $100
    expect(r.snapshots[0].pnlPct).toBeCloseTo(5, 6);
    expect(r.snapshots[0].pnlUsd).toBeCloseTo(5, 6);
    // 4% move × 5x = 20% = $20
    expect(r.snapshots[2].pnlPct).toBeCloseTo(20, 6);
    expect(r.snapshots[2].pnlUsd).toBeCloseTo(20, 6);
    expect(r.latestSnapshotKey).toBe("d2_close");
    expect(r.latestPnlUsd).toBeCloseTo(20, 6);
    expect(r.daysHeld).toBe(2);
  });

  it("computes reversal SHORT PnL (sign flipped)", () => {
    const r = evaluateScenario(
      "reversal",
      ticker({ entryPrice: 100, dayChangePct: 1 }), // UP → SHORT
      tl(["d1_close", 95]), // price dropped → short wins
      params,
    );
    expect(r.direction).toBe(-1);
    // move = -5%, × -1 × 5 = +25%
    expect(r.snapshots[0].pnlPct).toBeCloseTo(25, 6);
    expect(r.snapshots[0].pnlUsd).toBeCloseTo(25, 6);
  });

  it("liquidates when leveraged move would exceed 100% loss and stays liquidated on later cells", () => {
    const r = evaluateScenario(
      "momentum",
      ticker({ entryPrice: 100, dayChangePct: 1 }),
      tl(
        ["d1_morning", 95], // -25% of $100
        ["d1_midday", 79], // -105% leveraged → liquidation
        ["d1_close", 90], // recovery — but position already liquidated
      ),
      params,
    );
    expect(r.snapshots[0].liquidated).toBe(false);
    expect(r.snapshots[1].liquidated).toBe(true);
    expect(r.snapshots[2].liquidated).toBe(true); // sticky
    expect(r.snapshots[1].pnlPct).toBe(-100);
    expect(r.snapshots[1].pnlUsd).toBe(-params.investment); // -$100
    expect(r.snapshots[2].pnlPct).toBe(-100); // doesn't un-liquidate
    expect(r.liquidated).toBe(true);
    expect(r.firstLiquidatedKey).toBe("d1_midday");
  });

  it("null snapshot price yields null pnl and doesn't advance latest snapshot", () => {
    const r = evaluateScenario(
      "momentum",
      ticker({ dayChangePct: 1 }),
      tl(["d1_morning", 101], ["d1_midday", null], ["d1_close", 102]),
      params,
    );
    expect(r.snapshots[1].pnlUsd).toBeNull();
    expect(r.latestSnapshotKey).toBe("d1_close");
  });

  it("guards against zero entry price", () => {
    const r = evaluateScenario(
      "momentum",
      ticker({ entryPrice: 0, dayChangePct: 1 }),
      tl(["d1_close", 200]),
      params,
    );
    expect(r.snapshots[0].pnlUsd).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// summarizeScenario — aggregate report
// -----------------------------------------------------------------------------

describe("summarizeScenario", () => {
  it("aggregates long/short split, best/worst, in-profit, asOfKey across tickers", () => {
    const longWin = evaluateScenario(
      "momentum",
      ticker({ symbol: "UP1", entryPrice: 100, dayChangePct: 1 }),
      tl(["d1_close", 104]), // +4% × 5x = +20%
      params,
    );
    const longLoss = evaluateScenario(
      "momentum",
      ticker({ symbol: "UP2", entryPrice: 100, dayChangePct: 1 }),
      tl(["d2_midday", 98]), // -2% × 5x = -10%
      params,
    );
    const shortWin = evaluateScenario(
      "momentum",
      ticker({ symbol: "DN1", entryPrice: 100, dayChangePct: -1 }),
      tl(["d1_close", 96]), // short on -4% move: 4% × 5x = +20%
      params,
    );
    const greyed = evaluateScenario(
      "momentum",
      ticker({ symbol: "FLAT", dayChangePct: 0 }), // direction 0
      tl(["d1_close", 101]),
      params,
    );

    const report = summarizeScenario(
      "momentum",
      [longWin, longLoss, shortWin, greyed],
      params,
    );
    expect(report.totalCohort).toBe(4);
    expect(report.eligibleCount).toBe(3); // greyed excluded
    expect(report.capitalDeployed).toBe(300);
    expect(report.longCount).toBe(2);
    expect(report.shortCount).toBe(1);
    expect(report.inProfitCount).toBe(2);
    expect(report.atLossCount).toBe(1);
    expect(report.liquidatedCount).toBe(0);
    expect(report.longSumPnl).toBeCloseTo(20 + -10, 6);
    expect(report.shortSumPnl).toBeCloseTo(20, 6);
    expect(report.longAvgPnlPct).toBeCloseTo((20 + -10) / 2, 6);
    expect(report.shortAvgPnlPct).toBeCloseTo(20, 6);
    expect(report.unrealizedPnlUsd).toBeCloseTo(30, 6);
    expect(report.unrealizedPnlPct).toBeCloseTo((30 / 300) * 100, 6);
    expect(report.best?.symbol === "UP1" || report.best?.symbol === "DN1").toBe(true);
    expect(report.best?.pnlUsd).toBeCloseTo(20, 6);
    expect(report.worst?.symbol).toBe("UP2");
    expect(report.worst?.pnlUsd).toBeCloseTo(-10, 6);
    // as-of: ordinal of "d2_midday" (2*10+1=21) > "d1_close" (1*10+2=12)
    expect(report.asOfKey).toBe("d2_midday");
  });

  it("asOfKey picks latest intraday slot within same day (close > midday > morning)", () => {
    const earlier = evaluateScenario(
      "momentum",
      ticker({ symbol: "A", entryPrice: 100, dayChangePct: 1 }),
      tl(["d3_morning", 101]),
      params,
    );
    const later = evaluateScenario(
      "momentum",
      ticker({ symbol: "B", entryPrice: 100, dayChangePct: 1 }),
      tl(["d3_close", 102]),
      params,
    );
    const report = summarizeScenario("momentum", [earlier, later], params);
    expect(report.asOfKey).toBe("d3_close");
  });

  it("returns zero-value report for empty / all-greyed cohorts", () => {
    const greyed = evaluateScenario(
      "momentum",
      ticker({ dayChangePct: 0 }),
      tl(["d1_close", 100]),
      params,
    );
    const r = summarizeScenario("momentum", [greyed], params);
    expect(r.eligibleCount).toBe(0);
    expect(r.capitalDeployed).toBe(0);
    expect(r.unrealizedPnlPct).toBe(0); // no divide-by-zero explosion
    expect(r.best).toBeNull();
    expect(r.worst).toBeNull();
    expect(r.asOfKey).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// computeRecurrences — dedup + newest-first ordering
// -----------------------------------------------------------------------------

describe("computeRecurrences", () => {
  it("groups by symbol and dedupes same-date appearances", () => {
    const out = computeRecurrences([
      { symbol: "AAPL", cohort_date: "2026-04-20", direction: "LONG", entry_price: 100, day_change_pct: 1 },
      { symbol: "AAPL", cohort_date: "2026-04-20", direction: "LONG", entry_price: 101, day_change_pct: 1 }, // same date — dedup
      { symbol: "AAPL", cohort_date: "2026-04-15", direction: "SHORT", entry_price: 110, day_change_pct: -2 },
      { symbol: "MSFT", cohort_date: "2026-04-20", direction: "LONG", entry_price: 300, day_change_pct: 0.5 },
    ]);
    expect(out.get("AAPL")?.count).toBe(2);
    expect(out.get("MSFT")?.count).toBe(1);
  });

  it("sorts appearances newest-first", () => {
    const out = computeRecurrences([
      { symbol: "X", cohort_date: "2026-04-10", direction: "LONG", entry_price: 10, day_change_pct: 1 },
      { symbol: "X", cohort_date: "2026-04-22", direction: "SHORT", entry_price: 11, day_change_pct: -1 },
      { symbol: "X", cohort_date: "2026-04-15", direction: "LONG", entry_price: 12, day_change_pct: 2 },
    ]);
    expect(out.get("X")?.appearances.map((a) => a.cohortDate)).toEqual([
      "2026-04-22",
      "2026-04-15",
      "2026-04-10",
    ]);
  });

  it("accepts Date objects for cohort_date and slices to YYYY-MM-DD", () => {
    const d = new Date("2026-04-22T14:30:00Z");
    const out = computeRecurrences([
      { symbol: "X", cohort_date: d, direction: "LONG", entry_price: 10, day_change_pct: 1 },
    ]);
    expect(out.get("X")?.appearances[0].cohortDate).toBe("2026-04-22");
  });

  it("skips malformed entries without a symbol", () => {
    const out = computeRecurrences([
      // @ts-expect-error — no symbol
      { cohort_date: "2026-04-22", direction: "LONG", entry_price: 10, day_change_pct: 1 },
      { symbol: "OK", cohort_date: "2026-04-22", direction: "LONG", entry_price: 10, day_change_pct: 1 },
    ]);
    expect(out.size).toBe(1);
    expect(out.has("OK")).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// compareAllScenarios — integration smoke across all 5
// -----------------------------------------------------------------------------

describe("compareAllScenarios", () => {
  it("returns one row per scenario, preserving catalog order", () => {
    const pairs = [
      {
        ticker: ticker({ symbol: "A", dayChangePct: 1, consecutiveDays: 1 }),
        timeline: tl(["d1_close", 102]),
      },
      {
        ticker: ticker({ symbol: "B", dayChangePct: -1, consecutiveDays: 4 }),
        timeline: tl(["d1_close", 98]),
      },
    ];
    const rows = compareAllScenarios(pairs, params);
    expect(rows.map((r) => r.scenarioId)).toEqual([
      "momentum",
      "reversal",
      "three_day_slide_bounce",
      "four_day_rally_fade",
      "extreme_streak_reversal",
    ]);
    rows.forEach((r) => expect(r.totalCohort).toBe(2));
  });

  it("best/worst carry entryId + cohortDate so UI can target the exact enrollment on duplicate symbols", () => {
    // Codex finding #2 regression: AAPL appears in two cohorts; the better
    // enrollment should win Best and be identifiable by its id, not just symbol.
    const pairs = [
      {
        ticker: ticker({
          symbol: "AAPL",
          entryId: 101,
          cohortDate: "2026-04-15",
          entryPrice: 100,
          dayChangePct: 1,
        }),
        timeline: tl(["d1_close", 101]), // +1% × 5x = +5% → +$5
      },
      {
        ticker: ticker({
          symbol: "AAPL",
          entryId: 202,
          cohortDate: "2026-04-22",
          entryPrice: 100,
          dayChangePct: 1,
        }),
        timeline: tl(["d1_close", 110]), // +10% × 5x = +50% → +$50
      },
    ];
    const perTicker = pairs.map((p) =>
      evaluateScenario("momentum", p.ticker, p.timeline, params),
    );
    const report = summarizeScenario("momentum", perTicker, params);
    expect(report.best?.symbol).toBe("AAPL");
    expect(report.best?.entryId).toBe(202); // the winner enrollment, not the first-by-symbol
    expect(report.best?.cohortDate).toBe("2026-04-22");
    expect(report.worst?.entryId).toBe(101);
    expect(report.worst?.cohortDate).toBe("2026-04-15");
  });

  it("does NOT collapse duplicate symbols from different cohorts (per-pair evaluation)", () => {
    // Same ticker, two different enrollment timelines; both must be evaluated
    // with the correct direction/entry and counted separately.
    const pairs = [
      {
        ticker: ticker({ symbol: "AAPL", entryPrice: 100, dayChangePct: 1 }),
        timeline: tl(["d1_close", 105]),
      },
      {
        ticker: ticker({ symbol: "AAPL", entryPrice: 200, dayChangePct: -1 }),
        timeline: tl(["d1_close", 210]),
      },
    ];
    const momentumRow = compareAllScenarios(pairs, params).find(
      (r) => r.scenarioId === "momentum",
    )!;
    expect(momentumRow.eligibleCount).toBe(2);
    // +25% + (+25%) if first is LONG winner and second is SHORT loser
    // loser: move = +5%, dir=-1, leverage=5 → -25% → -$25
    // winner: +5% × 5 → +25% → +$25
    expect(momentumRow.totalPnlUsd).toBeCloseTo(0, 6);
  });
});

function assertMatrixScenario(_: MatrixScenario) {
  // type-only check that the exported MatrixScenario type is usable from a test
}
assertMatrixScenario(getScenario("momentum"));
