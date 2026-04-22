import { describe, it, expect } from "vitest";
import { calculateEntryPnL, type ReversalEntry, type ReversalSettings } from "./reversal";

const DEFAULT_SETTINGS: ReversalSettings = {
  position_size_usd: 100,
  commission_per_trade_usd: 1,
  short_borrow_rate_apr: 0.03,
  leverage_interest_apr: 0.08,
  leverage_multiplier: 1,
};

function makeEntry(overrides: Partial<ReversalEntry> = {}): ReversalEntry {
  const base: ReversalEntry = {
    id: 1,
    cohort_date: "2026-04-22",
    symbol: "AAPL",
    direction: "LONG",
    day_change_pct: -3,
    entry_price: 100,
    d1_morning: null, d1_midday: null, d1_close: null,
    d2_morning: null, d2_midday: null, d2_close: null,
    d3_morning: null, d3_midday: null, d3_close: null,
    d4_morning: null, d4_midday: null, d4_close: null,
    d5_morning: null, d5_midday: null, d5_close: null,
    d6_morning: null, d6_midday: null, d6_close: null,
    d7_morning: null, d7_midday: null, d7_close: null,
    d8_morning: null, d8_midday: null, d8_close: null,
    d9_morning: null, d9_midday: null, d9_close: null,
    d10_morning: null, d10_midday: null, d10_close: null,
    final_pnl_usd: null,
    final_pnl_pct: null,
    status: "ACTIVE",
    created_at: new Date().toISOString(),
  };
  return { ...base, ...overrides };
}

describe("calculateEntryPnL", () => {
  it("returns null when there are no populated price cells", () => {
    const e = makeEntry();
    expect(calculateEntryPnL(e, DEFAULT_SETTINGS)).toBeNull();
  });

  it("returns null when entry_price is 0 (division-guard)", () => {
    const e = makeEntry({ entry_price: 0, d1_close: 110 });
    expect(calculateEntryPnL(e, DEFAULT_SETTINGS)).toBeNull();
  });

  it("LONG profits when exit > entry, nets commissions ×2", () => {
    // $100 / $100 = 1 share; exit 110 → gross +$10; commissions = 2; net = $8
    const e = makeEntry({ direction: "LONG", entry_price: 100, d1_close: 110 });
    const r = calculateEntryPnL(e, DEFAULT_SETTINGS)!;
    expect(r.gross_pnl).toBeCloseTo(10, 6);
    expect(r.costs).toBeCloseTo(2, 6);
    expect(r.pnl_usd).toBeCloseTo(8, 6);
    expect(r.pnl_pct).toBeCloseTo(0.08, 6); // 8 / 100
  });

  it("SHORT profits when exit < entry (gross sign flipped)", () => {
    // $100 / $100 = 1 share; exit 90 → gross +$10 for SHORT
    // costs = commissions 2 + borrow (100 * 0.03/365 * 1 day) ≈ 0.008219
    const e = makeEntry({ direction: "SHORT", entry_price: 100, d1_close: 90 });
    const r = calculateEntryPnL(e, DEFAULT_SETTINGS)!;
    expect(r.gross_pnl).toBeCloseTo(10, 6);
    const expectedBorrow = 100 * (0.03 / 365) * 1;
    expect(r.costs).toBeCloseTo(2 + expectedBorrow, 6);
    expect(r.pnl_usd).toBeCloseTo(10 - (2 + expectedBorrow), 6);
  });

  it("SHORT loses money when exit > entry", () => {
    const e = makeEntry({ direction: "SHORT", entry_price: 100, d1_close: 110 });
    const r = calculateEntryPnL(e, DEFAULT_SETTINGS)!;
    expect(r.gross_pnl).toBeCloseTo(-10, 6);
    expect(r.pnl_usd).toBeLessThan(-10); // plus commissions + borrow
  });

  it("leverage multiplies position size and charges interest on borrowed portion", () => {
    // 5x leverage on $100 → $500 position, 5 shares
    // exit 110 → gross = 5 * (110-100) = $50
    // commissions = 2
    // borrowed = $400, interest = 400 * 0.08/365 * 1 day ≈ 0.0876712
    // net = 50 - 2 - 0.0876712
    const e = makeEntry({ direction: "LONG", entry_price: 100, d1_close: 110 });
    const r = calculateEntryPnL(e, { ...DEFAULT_SETTINGS, leverage_multiplier: 5 })!;
    expect(r.gross_pnl).toBeCloseTo(50, 6);
    const expectedInterest = 400 * (0.08 / 365) * 1;
    expect(r.costs).toBeCloseTo(2 + expectedInterest, 6);
    expect(r.pnl_usd).toBeCloseTo(50 - 2 - expectedInterest, 6);
    // pnl_pct is relative to position_size_usd, NOT positionValue
    expect(r.pnl_pct).toBeCloseTo((50 - 2 - expectedInterest) / 100, 6);
  });

  it("no leverage interest when leverage_multiplier == 1", () => {
    const e = makeEntry({ direction: "LONG", entry_price: 100, d1_close: 110 });
    const r = calculateEntryPnL(e, DEFAULT_SETTINGS)!;
    expect(r.costs).toBeCloseTo(2, 6); // just the 2× commission
  });

  it("scales borrow + leverage interest by daysHeld (picked from last-populated day)", () => {
    // Last populated is d5_close → daysHeld = 5
    const e = makeEntry({
      direction: "SHORT",
      entry_price: 100,
      d1_close: 98,
      d5_close: 95,
    });
    const r = calculateEntryPnL(e, { ...DEFAULT_SETTINGS, leverage_multiplier: 2 })!;
    // exit price = 95, gross SHORT = (100-95) * (200/100) = 5 * 2 = 10
    expect(r.gross_pnl).toBeCloseTo(10, 6);
    // borrow: 200 * 0.03/365 * 5
    // leverage interest: borrowed=100, 100 * 0.08/365 * 5
    const expectedBorrow = 200 * (0.03 / 365) * 5;
    const expectedLev = 100 * (0.08 / 365) * 5;
    expect(r.costs).toBeCloseTo(2 + expectedBorrow + expectedLev, 6);
  });

  it("scans backwards: prefers close, then midday, then morning within a day", () => {
    const e = makeEntry({
      direction: "LONG",
      entry_price: 100,
      d3_morning: 101,
      d3_midday: 102,
      // d3_close intentionally null — fall back to midday
    });
    const r = calculateEntryPnL(e, DEFAULT_SETTINGS)!;
    // gross = 1 share × (102-100) = +2
    expect(r.gross_pnl).toBeCloseTo(2, 6);
  });

  it("falls back to earlier day when later days are all null", () => {
    const e = makeEntry({
      direction: "LONG",
      entry_price: 100,
      d1_close: 110,
      // d2..d10 all null
    });
    const r = calculateEntryPnL(e, DEFAULT_SETTINGS)!;
    // daysHeld should resolve to 1 — under default leverage=1, interest=0
    expect(r.costs).toBeCloseTo(2, 6);
  });
});
