import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export async function GET() {
  try {
    const pool = await getPool();
    
    // 1. Check Schema
    const [columns] = await pool.execute("DESCRIBE reversal_entries");
    const columnNames = (columns as any[]).map(c => c.Field);

    // 2. Check for sync activity
    const [logs] = await pool.execute("SELECT status, started_at, stats_json FROM surveillance_logs ORDER BY started_at DESC LIMIT 3");

    // 3. Check for actual captured data
    const [captured] = await pool.execute(
      "SELECT symbol, cohort_date, d1_morning, d1_midday FROM reversal_entries WHERE d1_morning IS NOT NULL OR d1_midday IS NOT NULL LIMIT 5"
    );

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      schema_verified: columnNames.includes('d10_morning'),
      latest_logs: logs,
      live_data_sample: captured
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
