import { NextRequest, NextResponse } from "next/server";

import { ensureSchema } from "@/lib/migrations";
import { getPool, sql } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await ensureSchema();
  const pool = await getPool();
  const { id: runId } = await params;

  const runResult = await pool
    .request()
    .input("id", sql.UniqueIdentifier, runId)
    .query("SELECT * FROM strategy_runs WHERE id = @id");

  if (runResult.recordset.length === 0) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  const metricsResult = await pool
    .request()
    .input("id", sql.UniqueIdentifier, runId)
    .query("SELECT * FROM run_metrics WHERE run_id = @id");

  const tradesResult = await pool
    .request()
    .input("id", sql.UniqueIdentifier, runId)
    .query("SELECT * FROM trades WHERE run_id = @id ORDER BY entry_date ASC");

  return NextResponse.json({
    run: runResult.recordset[0],
    metrics: metricsResult.recordset[0] ?? null,
    trades: tradesResult.recordset,
  });
}
