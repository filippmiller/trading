import { NextRequest, NextResponse } from "next/server";

import { ensureSchema } from "@/lib/migrations";
import { getPool, mysql } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureSchema();
  const pool = await getPool();
  const { id: runId } = await params;

  const [runRows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM strategy_runs WHERE id = ?",
    [runId]
  );

  if (runRows.length === 0) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  const [metricsRows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM run_metrics WHERE run_id = ?",
    [runId]
  );

  const [tradeRows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM trades WHERE run_id = ? ORDER BY entry_date ASC",
    [runId]
  );

  return NextResponse.json({
    run: runRows[0],
    metrics: metricsRows[0] ?? null,
    trades: tradeRows,
  });
}
