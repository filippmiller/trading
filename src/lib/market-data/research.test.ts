import { describe, expect, it } from "vitest";

import {
  computePnlPath,
  computeTradePnlPct,
  detectPriceStreak,
  detectRepeatedTopListCandidates,
  firstReversalLabel,
} from "@/lib/market-data/research";

describe("market-data research helpers", () => {
  it("detects a strict closing-price up streak and evidence moves", () => {
    const streak = detectPriceStreak([
      { date: "2026-04-14", close: 100 },
      { date: "2026-04-15", close: 98 },
      { date: "2026-04-16", close: 101 },
      { date: "2026-04-17", close: 104 },
      { date: "2026-04-20", close: 109 },
    ]);

    expect(streak?.direction).toBe("UP");
    expect(streak?.length).toBe(3);
    expect(streak?.evidence.map((row) => row.date)).toEqual([
      "2026-04-15",
      "2026-04-16",
      "2026-04-17",
      "2026-04-20",
    ]);
    expect(streak?.evidence[1].movePct).toBeCloseTo(3.0612, 4);
  });

  it("breaks a price streak on flat closes", () => {
    const streak = detectPriceStreak([
      { date: "2026-04-14", close: 100 },
      { date: "2026-04-15", close: 99 },
      { date: "2026-04-16", close: 99 },
    ]);

    expect(streak).toBeNull();
  });

  it("detects repeated top-list candidates only across consecutive cohort dates", () => {
    const candidates = detectRepeatedTopListCandidates(
      [
        { symbol: "AAA", direction: "UP", date: "2026-04-14" },
        { symbol: "AAA", direction: "UP", date: "2026-04-15" },
        { symbol: "AAA", direction: "UP", date: "2026-04-16" },
        { symbol: "AAA", direction: "UP", date: "2026-04-20" },
        { symbol: "BBB", direction: "DOWN", date: "2026-04-14" },
        { symbol: "BBB", direction: "DOWN", date: "2026-04-16" },
        { symbol: "BBB", direction: "DOWN", date: "2026-04-20" },
      ],
      ["2026-04-14", "2026-04-15", "2026-04-16", "2026-04-20"],
    );

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      entry: { symbol: "AAA", date: "2026-04-16" },
      runLength: 3,
      sequenceDates: ["2026-04-14", "2026-04-15", "2026-04-16"],
    });
    expect(candidates[1]).toMatchObject({
      entry: { symbol: "AAA", date: "2026-04-20" },
      runLength: 4,
    });
  });

  it("computes long and short pnl directionally", () => {
    expect(computeTradePnlPct(100, 110, "LONG")).toBeCloseTo(10);
    expect(computeTradePnlPct(100, 110, "SHORT")).toBeCloseTo(-10);
    expect(computeTradePnlPct(100, 90, "SHORT")).toBeCloseTo(10);
  });

  it("marks reversal path points for contrarian repeated-mover trades", () => {
    const path = computePnlPath({
      direction: "UP",
      entryPrice: 100,
      investmentUsd: 1000,
      exits: [
        { label: "d1", price: 120 },
        { label: "d2", price: 95 },
      ],
    });

    expect(path[0]).toMatchObject({ isReversal: false, tradePnlUsd: -200 });
    expect(path[1]).toMatchObject({ isReversal: true, tradePnlUsd: 50 });
    expect(firstReversalLabel(path)).toBe("d2");
  });
});
