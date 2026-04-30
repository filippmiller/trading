import { describe, it, expect } from "vitest";

import { applyExecutionPrice, DEFAULT_RISK_CONFIG } from "./paper-risk";

describe("applyExecutionPrice", () => {
  const cfg = { ...DEFAULT_RISK_CONFIG, slippageBps: 5, spreadBps: 2 };
  const quote = 100;

  it("MARKET BUY crosses half-spread and applies adverse slippage", () => {
    const fill = applyExecutionPrice(quote, "BUY", "MARKET", cfg);
    expect(fill).toBeCloseTo(100 * (1 + 0.0001 + 0.0005), 8);
    expect(fill).toBeGreaterThan(quote);
  });

  it("MARKET SELL crosses half-spread and applies adverse slippage", () => {
    const fill = applyExecutionPrice(quote, "SELL", "MARKET", cfg);
    expect(fill).toBeCloseTo(100 * (1 - 0.0001 - 0.0005), 8);
    expect(fill).toBeLessThan(quote);
  });

  it("STOP orders execute like market orders after trigger", () => {
    const buyStop = applyExecutionPrice(quote, "BUY", "STOP", cfg);
    const buyMarket = applyExecutionPrice(quote, "BUY", "MARKET", cfg);
    const sellStop = applyExecutionPrice(quote, "SELL", "STOP", cfg);
    const sellMarket = applyExecutionPrice(quote, "SELL", "MARKET", cfg);
    expect(buyStop).toBeCloseTo(buyMarket, 8);
    expect(sellStop).toBeCloseTo(sellMarket, 8);
  });

  it("LIMIT BUY pays spread when there is room but never fills above the limit", () => {
    expect(applyExecutionPrice(99.9, "BUY", "LIMIT", cfg, 100)).toBeCloseTo(99.9 * 1.0001, 8);
    expect(applyExecutionPrice(100, "BUY", "LIMIT", cfg, 100)).toBe(100);
  });

  it("LIMIT SELL receives bid when there is room but never fills below the limit", () => {
    expect(applyExecutionPrice(100.1, "SELL", "LIMIT", cfg, 100)).toBeCloseTo(100.1 * 0.9999, 8);
    expect(applyExecutionPrice(100, "SELL", "LIMIT", cfg, 100)).toBe(100);
  });

  it("zero spread and zero slippage preserves the old raw-quote behavior", () => {
    const noCosts = { ...cfg, spreadBps: 0, slippageBps: 0 };
    for (const type of ["MARKET", "LIMIT", "STOP"] as const) {
      for (const side of ["BUY", "SELL"] as const) {
        expect(applyExecutionPrice(quote, side, type, noCosts, quote)).toBe(quote);
      }
    }
  });
});
