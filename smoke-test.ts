import { getPool } from "./src/lib/db";
import { syncActiveSurveillance } from "./src/lib/surveillance";

async function verify() {
  console.log("--- STARTING PRODUCTION SMOKE TEST ---");
  const pool = await getPool();

  // 1. Check current state
  const [before] = await pool.execute("SELECT COUNT(*) as count FROM reversal_entries");
  console.log(`Current positions in DB: ${(before as any)[0].count}`);

  // 2. Trigger the Surveillance Engine
  console.log("Triggering Sync Engine (Fetching prices from Yahoo)...");
  await syncActiveSurveillance();

  // 3. Verify Logs
  const [logs] = await pool.execute("SELECT * FROM surveillance_logs ORDER BY started_at DESC LIMIT 1");
  const latestLog = (logs as any)[0];
  console.log(`Sync Status: ${latestLog.status}`);
  console.log(`Stats: ${latestLog.stats_json}`);

  // 4. Verify Data (Look for any newly filled price points)
  const [points] = await pool.execute("SELECT symbol, d1_morning, d1_midday FROM reversal_entries WHERE d1_morning IS NOT NULL LIMIT 5");
  console.log("Recently Captured Data Points:");
  console.table(points);

  console.log("--- SMOKE TEST COMPLETE ---");
  process.exit(0);
}

verify().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
