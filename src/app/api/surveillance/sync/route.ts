import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { syncActiveSurveillance, fetchAndAnalyzeMovers } from "@/lib/surveillance";

/**
 * GET /api/surveillance/sync
 * Manually trigger the sync of prices and auto-enroll new trenders.
 */
export async function GET() {
  try {
    // 1. Sync prices for existing 10-day active positions
    await syncActiveSurveillance();

    // 2. Auto-enroll today's 3-day trenders
    await autoEnrollTrenders();

    return NextResponse.json({ success: true, message: "Surveillance sync complete." });
  } catch (err) {
    console.error("Surveillance sync error", err);
    return NextResponse.json({ error: "Failed to sync surveillance." }, { status: 500 });
  }
}

async function autoEnrollTrenders() {
  const pool = await getPool();
  const today = new Date().toISOString().split('T')[0];

  // Call the library function directly instead of fetch
  const { gainers, losers } = await fetchAndAnalyzeMovers();

  // Filter for 2+ days
  const enrollment = [
    ...gainers.filter((m: any) => (m.consecutiveDays || 0) >= 2).slice(0, 5),
    ...losers.filter((m: any) => (m.consecutiveDays || 0) >= 2).slice(0, 5)
  ];

  for (const item of enrollment) {
    const direction = item.changePct > 0 ? 'SHORT' : 'LONG';
    await pool.execute(
      `INSERT IGNORE INTO reversal_entries (cohort_date, symbol, direction, day_change_pct, entry_price, consecutive_days, cumulative_change_pct, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [today, item.symbol, direction, item.changePct, item.price, item.consecutiveDays, item.cumulativeChangePct]
    );
  }
}
