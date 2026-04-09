import { NextResponse } from "next/server";
import { getPool, mysql } from "@/lib/db";
import { syncActiveSurveillance, fetchAndAnalyzeMovers } from "@/lib/surveillance";
import { ensureSchema } from "@/lib/migrations";

/**
 * GET /api/surveillance/sync
 * Manually trigger the sync of prices and auto-enroll new trenders.
 * Requires SYNC_SECRET header or query param to prevent abuse.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret = request.headers.get("x-sync-secret") || url.searchParams.get("secret");
  if (process.env.SYNC_SECRET && secret !== process.env.SYNC_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await ensureSchema();

    // 1. Sync prices for existing 10-day active positions
    await syncActiveSurveillance();

    // 2. Enroll today's top 10 gainers + top 10 losers
    await autoEnrollTrenders();

    return NextResponse.json({ success: true, message: "Surveillance sync complete." });
  } catch (err) {
    console.error("Surveillance sync error", err);
    return NextResponse.json({ error: "Failed to sync surveillance." }, { status: 500 });
  }
}

async function autoEnrollTrenders() {
  const pool = await getPool();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

  // Idempotency: skip if today's cohort is already enrolled.
  // Yahoo's top movers change throughout the day, so re-running would add new
  // symbols to the same cohort, ballooning it past 20.
  const [existing] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) as cnt FROM reversal_entries WHERE cohort_date = ?",
    [today]
  );
  if (Number(existing[0]?.cnt ?? 0) > 0) {
    return; // already enrolled
  }

  // Call the library function directly instead of fetch
  const { gainers, losers } = await fetchAndAnalyzeMovers();

  // Top 10 gainers + top 10 losers every day — no filtering
  const enrollment = [
    ...gainers.slice(0, 10),
    ...losers.slice(0, 10)
  ];

  for (const item of enrollment) {
    const direction = item.changePct > 0 ? 'SHORT' : 'LONG';
    await pool.execute(
      `INSERT INTO reversal_entries (cohort_date, symbol, direction, day_change_pct, entry_price, consecutive_days, cumulative_change_pct, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
       ON DUPLICATE KEY UPDATE
         entry_price = VALUES(entry_price),
         day_change_pct = VALUES(day_change_pct),
         consecutive_days = VALUES(consecutive_days),
         cumulative_change_pct = VALUES(cumulative_change_pct)`,
      [today, item.symbol, direction, item.changePct, item.price, item.consecutiveDays, item.cumulativeChangePct]
    );
  }
}
