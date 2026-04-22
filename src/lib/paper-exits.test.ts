import { describe, it, expect, vi } from "vitest";
import { persistWatermarks, computeExitFillPrice } from "./paper-exits";
import { DEFAULT_RISK_CONFIG } from "./paper-risk";

/**
 * Unit contract tests for persistWatermarks — the helper that the monitor
 * cron now calls on non-exit ticks (internal-critic finding #1 fix). Full
 * behavior requires a live MySQL; these tests pin the SQL shape and the
 * accepted argument types so a regression (wrong WHERE, wrong columns,
 * dropped null-tolerance) fails loudly.
 */

type ExecuteSpy = ReturnType<typeof vi.fn>;

function mockPool(execute: ExecuteSpy) {
  return { execute } as unknown as Parameters<typeof persistWatermarks>[0];
}

describe("persistWatermarks", () => {
  it("writes the watermark columns with status='OPEN' guard and id bind", async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
    await persistWatermarks(mockPool(execute), 42, 3.5, -1.2, true, 99.5);
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(String(sql)).toMatch(/UPDATE\s+paper_trades/i);
    expect(String(sql)).toMatch(/max_pnl_pct=\?[\s\S]*min_pnl_pct=\?/);
    expect(String(sql)).toMatch(/trailing_active=\?[\s\S]*trailing_stop_price=\?/);
    expect(String(sql)).toMatch(/status\s*=\s*'OPEN'/i);
    expect(params).toEqual([3.5, -1.2, 1, 99.5, 42]);
  });

  it("accepts null watermarks (early-tick state before PnL history is computed)", async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
    await persistWatermarks(mockPool(execute), 7, null, null, false, null);
    const [, params] = execute.mock.calls[0];
    // MySQL driver will translate null → SQL NULL; we just need to make sure
    // the helper didn't coerce them to 0 (which would lie about the state).
    expect(params).toEqual([null, null, 0, null, 7]);
  });

  it("maps trailingActive boolean to 1/0 (MySQL TINYINT convention)", async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
    await persistWatermarks(mockPool(execute), 1, 0, 0, false, null);
    expect(execute.mock.calls[0][1][2]).toBe(0);
    await persistWatermarks(mockPool(execute), 1, 0, 0, true, null);
    expect(execute.mock.calls[1][1][2]).toBe(1);
  });
});

/**
 * computeExitFillPrice — finding #3 regression tests.
 *
 * Default risk config: slippageBps=5 → edge = 0.0005 (5 bps).
 * LONG auto-exit closes via SELL (price drops a hair).
 * SHORT auto-exit covers via BUY (price rises a hair).
 * TAKE_PROFIT is a LIMIT — no slippage.
 */
describe("computeExitFillPrice", () => {
  const cfg = DEFAULT_RISK_CONFIG;
  const trigger = 100;
  const bpsEdge = cfg.slippageBps / 10_000; // 0.0005

  it("LONG + HARD_STOP → SELL fill a hair below trigger (market)", () => {
    const r = computeExitFillPrice("HARD_STOP", "LONG", trigger, cfg);
    expect(r.isLimit).toBe(false);
    expect(r.fillPrice).toBeCloseTo(trigger * (1 - bpsEdge), 8);
    expect(r.fillPrice).toBeLessThan(trigger);
  });

  it("LONG + TRAILING_STOP → SELL fill adjusted down (market)", () => {
    const r = computeExitFillPrice("TRAILING_STOP", "LONG", trigger, cfg);
    expect(r.isLimit).toBe(false);
    expect(r.fillPrice).toBeCloseTo(trigger * (1 - bpsEdge), 8);
  });

  it("LONG + TIME_EXIT → SELL fill adjusted down (market)", () => {
    const r = computeExitFillPrice("TIME_EXIT", "LONG", trigger, cfg);
    expect(r.isLimit).toBe(false);
    expect(r.fillPrice).toBeLessThan(trigger);
  });

  it("LONG + LIQUIDATED → SELL fill adjusted down (forced market)", () => {
    const r = computeExitFillPrice("LIQUIDATED", "LONG", trigger, cfg);
    expect(r.isLimit).toBe(false);
    expect(r.fillPrice).toBeLessThan(trigger);
  });

  it("LONG + TAKE_PROFIT → filled AT the limit (no slippage)", () => {
    const r = computeExitFillPrice("TAKE_PROFIT", "LONG", trigger, cfg);
    expect(r.isLimit).toBe(true);
    expect(r.fillPrice).toBe(trigger);
  });

  it("SHORT + HARD_STOP → BUY fill a hair above trigger (cover is more expensive)", () => {
    const r = computeExitFillPrice("HARD_STOP", "SHORT", trigger, cfg);
    expect(r.isLimit).toBe(false);
    expect(r.fillPrice).toBeCloseTo(trigger * (1 + bpsEdge), 8);
    expect(r.fillPrice).toBeGreaterThan(trigger);
  });

  it("SHORT + TRAILING_STOP → BUY fill adjusted up", () => {
    const r = computeExitFillPrice("TRAILING_STOP", "SHORT", trigger, cfg);
    expect(r.fillPrice).toBeGreaterThan(trigger);
  });

  it("SHORT + TAKE_PROFIT → no slippage (limit cover at target)", () => {
    const r = computeExitFillPrice("TAKE_PROFIT", "SHORT", trigger, cfg);
    expect(r.isLimit).toBe(true);
    expect(r.fillPrice).toBe(trigger);
  });

  it("zero slippage config → fillPrice == triggerPrice on every reason/side combo", () => {
    const noSlip = { ...cfg, slippageBps: 0 };
    for (const reason of ["HARD_STOP", "TRAILING_STOP", "TIME_EXIT", "LIQUIDATED", "TAKE_PROFIT"] as const) {
      for (const side of ["LONG", "SHORT"] as const) {
        const r = computeExitFillPrice(reason, side, trigger, noSlip);
        expect(r.fillPrice).toBe(trigger);
      }
    }
  });

  it("is symmetric: LONG adjustment and SHORT adjustment are equal-magnitude, opposite-sign", () => {
    const longR = computeExitFillPrice("HARD_STOP", "LONG", trigger, cfg);
    const shortR = computeExitFillPrice("HARD_STOP", "SHORT", trigger, cfg);
    expect(trigger - longR.fillPrice).toBeCloseTo(shortR.fillPrice - trigger, 8);
  });
});
