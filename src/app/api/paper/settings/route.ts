import { NextResponse } from "next/server";
import { z } from "zod";

import { getPool, mysql } from "@/lib/db";
import { ensureSchema } from "@/lib/migrations";
import { loadRiskConfig, invalidateRiskConfigCache } from "@/lib/paper-risk";

/**
 * GET /api/paper/settings
 *
 * Returns the W4 risk-model config (slippage bps, commission schedule,
 * fractional-share toggle, default borrow rate). Used by the /paper buy
 * form to surface the fractional mode, and by /settings to render the
 * editor. Loads via `loadRiskConfig()` so the 30s cache protects reads.
 */
export async function GET() {
  try {
    await ensureSchema();
    const cfg = await loadRiskConfig();
    return NextResponse.json({
      slippage_bps: cfg.slippageBps,
      commission_per_share: cfg.commissionPerShare,
      commission_min_per_leg: cfg.commissionMinPerLeg,
      allow_fractional_shares: cfg.allowFractionalShares,
      default_borrow_rate_pct: cfg.defaultBorrowRatePct,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// Hotfix 2026-04-22 (Claude Desktop headed audit, Finding #2): bounds were
// laxer than any real retail-broker schedule, which let a `-5` sanitized by
// the browser's number input land as a saved `5.00/share` (1000× the default
// 0.005). Tighter upper bounds now reject the typo on the server even if the
// client slips it through. Retail brokers cap commission at <$0.02/share and
// slippage on major symbols at well under 1%; 0.5 / 10 / 200 / 100 leave
// generous headroom for illiquid edge cases but reject clearly-wrong input.
export const RiskSchema = z.object({
  slippage_bps: z.number().min(0).max(200).optional(),
  commission_per_share: z.number().min(0).max(0.5).optional(),
  commission_min_per_leg: z.number().min(0).max(10).optional(),
  allow_fractional_shares: z.boolean().optional(),
  default_borrow_rate_pct: z.number().min(0).max(100).optional(),
});

/**
 * PATCH /api/paper/settings  — upsert any subset of the risk knobs.
 *
 * Each key is stored as its own `app_settings` row for atomic, independent
 * editing. Bust the in-process cache after write so the next fill sees
 * the new value (don't wait 30s for TTL).
 */
export async function PATCH(req: Request) {
  try {
    await ensureSchema();
    const body = await req.json();
    const parsed = RiskSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid settings", issues: parsed.error.issues }, { status: 400 });
    }
    const pool = await getPool();
    const pairs: Array<[string, string]> = [];
    if (parsed.data.slippage_bps != null) pairs.push(["risk.slippage_bps", String(parsed.data.slippage_bps)]);
    if (parsed.data.commission_per_share != null) pairs.push(["risk.commission_per_share", String(parsed.data.commission_per_share)]);
    if (parsed.data.commission_min_per_leg != null) pairs.push(["risk.commission_min_per_leg", String(parsed.data.commission_min_per_leg)]);
    if (parsed.data.allow_fractional_shares != null) pairs.push(["risk.allow_fractional_shares", parsed.data.allow_fractional_shares ? "true" : "false"]);
    if (parsed.data.default_borrow_rate_pct != null) pairs.push(["risk.default_borrow_rate_pct", String(parsed.data.default_borrow_rate_pct)]);

    // Hotfix 2026-04-22 (Bug #6) — atomic batch upsert. Previously each
    // INSERT...ON DUPLICATE ran in its own autocommit; a mid-batch failure
    // (server restart, deadlock, row lock timeout) would leave some keys
    // updated and others stale, producing a hybrid config. Wrap the loop
    // in a single transaction so either all keys land together or none do.
    // Zod validation above already filtered garbage, but atomicity matters
    // for operational failures (connection drop, lock contention) too.
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const [k, v] of pairs) {
        await conn.execute<mysql.ResultSetHeader>(
          "INSERT INTO app_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), updated_at = CURRENT_TIMESTAMP(6)",
          [k, v]
        );
      }
      await conn.commit();
    } catch (err) {
      try { await conn.rollback(); } catch { /* ignore */ }
      throw err;
    } finally {
      conn.release();
    }

    // Invalidate the cache so the next fillOrder picks up the change.
    // Placed AFTER commit so we never show cleared cache + rolled-back DB.
    invalidateRiskConfigCache();
    const cfg = await loadRiskConfig();
    return NextResponse.json({
      ok: true,
      config: {
        slippage_bps: cfg.slippageBps,
        commission_per_share: cfg.commissionPerShare,
        commission_min_per_leg: cfg.commissionMinPerLeg,
        allow_fractional_shares: cfg.allowFractionalShares,
        default_borrow_rate_pct: cfg.defaultBorrowRatePct,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
