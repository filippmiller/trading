import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export async function GET() {
  try {
    const pool = await getPool();
    
    // 1. Check if the new schema columns exist
    const [columns] = await pool.execute("DESCRIBE reversal_entries");
    const columnNames = (columns as any[]).map(c => c.Field);
    const hasTrendColumns = columnNames.includes('consecutive_days');
    const has10DayColumns = columnNames.includes('d10_morning');

    // 2. Check for recent sync logs
    const [logs] = await pool.execute("SELECT * FROM surveillance_logs ORDER BY started_at DESC LIMIT 1");
    const lastLog = (logs as any[])[0];

    // 3. Check for any captured data points
    const [captured] = await pool.execute(
      "SELECT symbol, d1_morning, d1_midday, d1_close FROM reversal_entries WHERE d1_morning IS NOT NULL OR d1_midday IS NOT NULL LIMIT 5"
    );

    return NextResponse.json({
      success: true,
      schema: {
        hasTrendColumns,
        has10DayColumns,
        totalColumns: columnNames.length
      },
      lastSync: lastLog ? {
        status: lastLog.status,
        started: lastLog.started_at,
        stats: JSON.parse(lastLog.stats_json || '{}')
      } : "No sync logs yet",
      capturedData: captured
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
