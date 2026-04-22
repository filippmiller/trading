import { describe, it, expect, vi } from "vitest";
import { persistWatermarks } from "./paper-exits";

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
    expect(String(sql)).toMatch(/max_pnl_pct=\?.*min_pnl_pct=\?/s);
    expect(String(sql)).toMatch(/trailing_active=\?.*trailing_stop_price=\?/s);
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
