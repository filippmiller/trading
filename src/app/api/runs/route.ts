import { NextResponse } from "next/server";

import { ensureSchema } from "@/lib/migrations";
import { getPool, sql } from "@/lib/db";

export async function GET(req: Request) {
  await ensureSchema();
  const { searchParams } = new URL(req.url);
  const page = Math.max(0, Number(searchParams.get("page") || 0));
  const limit = Math.min(50, Math.max(1, Number(searchParams.get("limit") || 20)));
  const offset = page * limit;

  const pool = await getPool();
  const result = await pool
    .request()
    .input("offset", sql.Int, offset)
    .input("limit", sql.Int, limit)
    .query(
      "SELECT r.id, r.created_at, r.status, r.preset_name, m.total_pnl_usd, m.total_return_pct, m.trades_count FROM strategy_runs r LEFT JOIN run_metrics m ON r.id = m.run_id ORDER BY r.created_at DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY"
    );

  type RunRow = {
    id: string;
    created_at: Date;
    status: string;
    preset_name: string | null;
    total_pnl_usd: number | null;
    total_return_pct: number | null;
    trades_count: number | null;
  };

  return NextResponse.json({
    items: (result.recordset as RunRow[]).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      status: row.status,
      preset_name: row.preset_name,
      total_pnl_usd: row.total_pnl_usd !== null ? Number(row.total_pnl_usd) : null,
      total_return_pct: row.total_return_pct !== null ? Number(row.total_return_pct) : null,
      trades_count: row.trades_count !== null ? Number(row.trades_count) : null,
    })),
  });
}
