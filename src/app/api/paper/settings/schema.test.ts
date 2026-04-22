import { describe, it, expect } from "vitest";

import { RiskSchema } from "./route";

// Hotfix 2026-04-22 (Claude Desktop Finding #2): headed audit caught that
// `-5` typed into the "Commission — per share ($)" input was silently
// sanitized by the browser to `5` (HTMLInputElement number-mode strips the
// leading `-` when `min=0` is set, but the remainder becomes the value).
// The old Zod bound was `.max(10)` so `5` was accepted as valid — a 1000×
// inflation of the default $0.005/share. These tests pin the tightened
// bounds so no regression can push the upper limit back up silently.
describe("RiskSchema — tightened bounds (Finding #2 hotfix)", () => {
  it("accepts the default retail-grade values", () => {
    expect(
      RiskSchema.safeParse({
        slippage_bps: 5,
        commission_per_share: 0.005,
        commission_min_per_leg: 1,
        allow_fractional_shares: true,
        default_borrow_rate_pct: 2.5,
      }).success,
    ).toBe(true);
  });

  it("accepts a partial patch (every field is optional)", () => {
    expect(RiskSchema.safeParse({ commission_per_share: 0.01 }).success).toBe(true);
  });

  it("REJECTS commission_per_share = 5 (the Finding #2 value)", () => {
    const r = RiskSchema.safeParse({ commission_per_share: 5 });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join(".") === "commission_per_share");
      expect(issue).toBeDefined();
      expect(issue?.message.toLowerCase()).toMatch(/less than|at most|<=|0\.5/);
    }
  });

  it("REJECTS any negative number", () => {
    expect(RiskSchema.safeParse({ commission_per_share: -0.01 }).success).toBe(false);
    expect(RiskSchema.safeParse({ commission_min_per_leg: -1 }).success).toBe(false);
    expect(RiskSchema.safeParse({ slippage_bps: -0.5 }).success).toBe(false);
    expect(RiskSchema.safeParse({ default_borrow_rate_pct: -1 }).success).toBe(false);
  });

  it("REJECTS clearly-absurd upper bounds on each numeric field", () => {
    expect(RiskSchema.safeParse({ commission_per_share: 1 }).success).toBe(false);
    expect(RiskSchema.safeParse({ commission_min_per_leg: 11 }).success).toBe(false);
    expect(RiskSchema.safeParse({ slippage_bps: 201 }).success).toBe(false);
    expect(RiskSchema.safeParse({ default_borrow_rate_pct: 101 }).success).toBe(false);
  });

  it("accepts plausible-but-elevated values (edge of range)", () => {
    expect(RiskSchema.safeParse({ commission_per_share: 0.5 }).success).toBe(true);
    expect(RiskSchema.safeParse({ commission_min_per_leg: 10 }).success).toBe(true);
    expect(RiskSchema.safeParse({ slippage_bps: 200 }).success).toBe(true);
    expect(RiskSchema.safeParse({ default_borrow_rate_pct: 100 }).success).toBe(true);
  });
});
