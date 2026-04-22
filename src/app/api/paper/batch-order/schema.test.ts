import { describe, it, expect } from "vitest";

import { BatchOrderItemSchema, BatchOrderSchema } from "./route";

describe("BatchOrderItemSchema", () => {
  it("accepts a minimal LONG order", () => {
    const r = BatchOrderItemSchema.safeParse({
      symbol: "AAPL",
      side: "LONG",
      qty: 10,
      fill_price: 195.2,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.symbol).toBe("AAPL");
  });

  it("uppercases lowercase symbol input", () => {
    const r = BatchOrderItemSchema.safeParse({
      symbol: "aapl",
      side: "LONG",
      qty: 1,
      fill_price: 100,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.symbol).toBe("AAPL");
  });

  it("rejects a symbol that does not match SYMBOL_RE", () => {
    expect(BatchOrderItemSchema.safeParse({
      symbol: "NOT-A-SYMBOL!",
      side: "LONG",
      qty: 1,
      fill_price: 100,
    }).success).toBe(false);
  });

  it("rejects side outside LONG/SHORT", () => {
    expect(BatchOrderItemSchema.safeParse({
      symbol: "AAPL",
      side: "BUY",
      qty: 1,
      fill_price: 100,
    }).success).toBe(false);
  });

  it("rejects non-positive qty and fill_price", () => {
    expect(BatchOrderItemSchema.safeParse({
      symbol: "AAPL", side: "LONG", qty: 0, fill_price: 100,
    }).success).toBe(false);
    expect(BatchOrderItemSchema.safeParse({
      symbol: "AAPL", side: "LONG", qty: 10, fill_price: -5,
    }).success).toBe(false);
    expect(BatchOrderItemSchema.safeParse({
      symbol: "AAPL", side: "LONG", qty: -1, fill_price: 100,
    }).success).toBe(false);
  });

  it("rejects absurd upper bounds (typo protection)", () => {
    expect(BatchOrderItemSchema.safeParse({
      symbol: "AAPL", side: "LONG", qty: 100001, fill_price: 100,
    }).success).toBe(false);
    expect(BatchOrderItemSchema.safeParse({
      symbol: "AAPL", side: "LONG", qty: 1, fill_price: 100001,
    }).success).toBe(false);
  });

  it("REJECTS bracket values outside [0.1..max] (the same class of bug as PR #36 /settings)", () => {
    // stop_loss_pct must be in [0.1, 50]
    expect(BatchOrderItemSchema.safeParse({
      symbol: "AAPL", side: "LONG", qty: 1, fill_price: 100, stop_loss_pct: 0,
    }).success).toBe(false);
    expect(BatchOrderItemSchema.safeParse({
      symbol: "AAPL", side: "LONG", qty: 1, fill_price: 100, stop_loss_pct: 51,
    }).success).toBe(false);
    // trailing_stop_pct must be in [0.1, 20]
    expect(BatchOrderItemSchema.safeParse({
      symbol: "AAPL", side: "LONG", qty: 1, fill_price: 100, trailing_stop_pct: 21,
    }).success).toBe(false);
    // take_profit_pct must be in [0.1, 100]
    expect(BatchOrderItemSchema.safeParse({
      symbol: "AAPL", side: "LONG", qty: 1, fill_price: 100, take_profit_pct: 101,
    }).success).toBe(false);
  });

  it("accepts boundary-max bracket values", () => {
    expect(BatchOrderItemSchema.safeParse({
      symbol: "AAPL", side: "SHORT", qty: 1, fill_price: 100,
      stop_loss_pct: 50, take_profit_pct: 100, trailing_stop_pct: 20,
    }).success).toBe(true);
  });
});

describe("BatchOrderSchema", () => {
  it("rejects an empty array", () => {
    expect(BatchOrderSchema.safeParse({ orders: [] }).success).toBe(false);
  });

  it("rejects >50 orders per batch", () => {
    const orders = Array.from({ length: 51 }, () => ({
      symbol: "AAPL", side: "LONG" as const, qty: 1, fill_price: 100,
    }));
    expect(BatchOrderSchema.safeParse({ orders }).success).toBe(false);
  });

  it("accepts 1 order", () => {
    expect(BatchOrderSchema.safeParse({
      orders: [{ symbol: "AAPL", side: "LONG", qty: 1, fill_price: 100 }],
    }).success).toBe(true);
  });

  it("accepts 50 orders (boundary)", () => {
    const orders = Array.from({ length: 50 }, (_, i) => ({
      symbol: "AAPL", side: "LONG" as const, qty: 1, fill_price: 100 + i,
    }));
    expect(BatchOrderSchema.safeParse({ orders }).success).toBe(true);
  });

  it("rejects a payload missing the `orders` key entirely", () => {
    expect(BatchOrderSchema.safeParse({}).success).toBe(false);
  });
});
