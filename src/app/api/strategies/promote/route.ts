import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { getPool, mysql } from "@/lib/db";
import { ensureSchema } from "@/lib/migrations";
import {
  buildPromotedStrategyConfig,
  PromoteStrategySchema,
} from "@/lib/strategy-promotion";

/**
 * POST /api/strategies/promote
 *
 * Promotes a research Grid Sweep row into a disabled paper strategy. The
 * executable subset is mapped into paper_strategies.config_json; every
 * research-only axis is retained in research_provenance with warnings.
 */
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const input = PromoteStrategySchema.parse(await req.json());
    const { config, warnings } = buildPromotedStrategyConfig(input);
    const pool = await getPool();
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      const accountName = makeAccountName(input.name);
      const [accountResult] = await conn.execute<mysql.ResultSetHeader>(
        "INSERT INTO paper_accounts (name, initial_cash, cash, reserved_cash, reserved_short_margin) VALUES (?, ?, ?, 0, 0)",
        [accountName, input.accountInitialCash, input.accountInitialCash],
      );
      const accountId = accountResult.insertId;

      const [strategyResult] = await conn.execute<mysql.ResultSetHeader>(
        `INSERT INTO paper_strategies (account_id, name, strategy_type, leverage, enabled, config_json)
         VALUES (?, ?, 'TRADING', ?, 0, ?)`,
        [accountId, input.name, input.trade.leverage, JSON.stringify(config)],
      );

      await conn.commit();

      return NextResponse.json({
        ok: true,
        strategy: {
          id: strategyResult.insertId,
          name: input.name,
          enabled: false,
          account_id: accountId,
          account_name: accountName,
          warnings,
        },
      });
    } catch (err: unknown) {
      await conn.rollback();
      if ((err as { errno?: number }).errno === 1062) {
        return NextResponse.json(
          { error: "DUPLICATE_STRATEGY_NAME", message: `Strategy '${input.name}' already exists` },
          { status: 409 },
        );
      }
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", issues: err.issues },
        { status: 400 },
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function makeAccountName(strategyName: string): string {
  const prefix = "Strategy: ";
  const suffix = ` #${Date.now().toString(36).slice(-6)}`;
  const base = `${prefix}${strategyName}`;
  if (base.length + suffix.length <= 64) return `${base}${suffix}`;
  return `${base.slice(0, 64 - suffix.length)}${suffix}`;
}
