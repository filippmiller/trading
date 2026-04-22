import { describe, it, expect } from "vitest";
import { checkFillPriceDeviation, FILL_PRICE_DEVIATION_BAND } from "./paper-risk";

describe("checkFillPriceDeviation — synthetic-fill fat-finger guard", () => {
  it("allows fill at the exact last close", () => {
    const r = checkFillPriceDeviation(100, 100);
    expect(r.ok).toBe(true);
  });

  it("allows fill within the default 20% band (symmetric)", () => {
    // +19.9% above close
    expect(checkFillPriceDeviation(119.9, 100).ok).toBe(true);
    // -19.9% below close
    expect(checkFillPriceDeviation(80.1, 100).ok).toBe(true);
  });

  it("accepts the exact 20% edge in both directions", () => {
    expect(checkFillPriceDeviation(120, 100).ok).toBe(true);
    expect(checkFillPriceDeviation(80, 100).ok).toBe(true);
  });

  it("REJECTS fill > 20% above close", () => {
    const r = checkFillPriceDeviation(125, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/SYNTHETIC_DEVIATION_TOO_LARGE/);
      expect(r.reason).toMatch(/25\.0%/);
      expect(r.reason).toMatch(/max 20%/);
      expect(r.lastClose).toBe(100);
    }
  });

  it("REJECTS fill > 20% below close", () => {
    const r = checkFillPriceDeviation(50, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/50\.0%/);
  });

  it("REJECTS the Codex-interview scenario: $1 fill on a $300 stock", () => {
    const r = checkFillPriceDeviation(1, 300);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.deviation).toBeGreaterThan(0.99);
      expect(r.reason).toMatch(/SYNTHETIC_DEVIATION_TOO_LARGE/);
    }
  });

  it("allows ANY price when lastClose is missing (null / undefined / 0)", () => {
    expect(checkFillPriceDeviation(1, null).ok).toBe(true);
    expect(checkFillPriceDeviation(1, undefined).ok).toBe(true);
    expect(checkFillPriceDeviation(1, 0).ok).toBe(true);
    expect(checkFillPriceDeviation(9999, null).ok).toBe(true);
  });

  it("REJECTS a non-finite or non-positive fillPrice even when lastClose is known", () => {
    expect(checkFillPriceDeviation(0, 100).ok).toBe(false);
    expect(checkFillPriceDeviation(-5, 100).ok).toBe(false);
    expect(checkFillPriceDeviation(NaN, 100).ok).toBe(false);
    expect(checkFillPriceDeviation(Infinity, 100).ok).toBe(false);
  });

  it("accepts a custom wider band", () => {
    // 50% deviation, band=0.6 → allowed
    const r = checkFillPriceDeviation(150, 100, 0.6);
    expect(r.ok).toBe(true);
  });

  it("the default band constant is 20%", () => {
    expect(FILL_PRICE_DEVIATION_BAND).toBe(0.2);
  });
});
