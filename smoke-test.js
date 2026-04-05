const { getPool } = require("./src/lib/db");
const { syncActiveSurveillance } = require("./src/lib/surveillance");

async function verify() {
  console.log("--- STARTING PRODUCTION SMOKE TEST ---");
  let pool;
  try {
    pool = await getPool();
  } catch (e) {
    console.error("Failed to connect to DB. Check environment variables.");
    console.error(e.message);
    process.exit(1);
  }

  // 1. Check current state
  const [before] = await pool.execute("SELECT COUNT(*) as count FROM reversal_entries");
  console.log(`Current positions in DB: ${before[0].count}`);

  // 2. Trigger the Surveillance Engine
  console.log("Triggering Sync Engine (Fetching prices from Yahoo)...");
  await syncActiveSurveillance();

  // 3. Verify Logs
  const [logs] = await pool.execute("SELECT * FROM surveillance_logs ORDER BY started_at DESC LIMIT 1");
  const latestLog = logs[0];
  console.log(`Sync Status: ${latestLog.status}`);
  console.log(`Stats: ${latestLog.stats_json}`);

  console.log("--- SMOKE TEST COMPLETE ---");
  process.exit(0);
}

verify().catch(err => {
  console.error("Verification failed:", err);
  process.exit(1);
});
