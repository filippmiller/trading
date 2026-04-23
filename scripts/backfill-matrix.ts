/**
 * Backfill the reversal matrix with historical data.
 *
 * 1. Fetch S&P 500 component list from Wikipedia
 * 2. Download ~20 trading days of daily bars for each
 * 3. For each past day, rank by daily % change, pick top 10 gainers + losers
 * 4. Insert into reversal_entries and fill follow-up close prices
 */

import mysql from "mysql2/promise";

// DATABASE_URL must be set explicitly — credentials must never be hardcoded.
// Local dev: ensure .env.local is present with DATABASE_URL, then run tunnel-db.sh.
function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL environment variable is required. Never hardcode credentials.");
    process.exit(1);
  }
  return url;
}
const DB_URL: string = requireDatabaseUrl();

// ── Step 1: Get S&P 500 tickers ──────────────────────────────────────────

async function getSP500Tickers(): Promise<string[]> {
  // Fetch from Wikipedia's S&P 500 page
  const url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";
  const res = await fetch(url);
  const html = await res.text();

  // Parse tickers from the first table - they're in the first <td> of each row
  const tickers: string[] = [];
  const rowRegex = /<tr>\s*<td[^>]*><a[^>]*>([A-Z.]+)<\/a>/g;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    // Convert BRK.B -> BRK-B for Yahoo compatibility
    tickers.push(match[1].replace(".", "-"));
  }
  return tickers;
}

// ── Step 2: Fetch daily bars from Yahoo ──────────────────────────────────

type DailyBar = { date: string; open: number; close: number; volume: number };

async function fetchDailyBars(symbol: string): Promise<DailyBar[]> {
  const range = process.env.BACKFILL_RANGE || '1mo';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) return [];

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars: DailyBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = Number(q.close?.[i]);
    const o = Number(q.open?.[i]);
    const v = Number(q.volume?.[i] ?? 0);
    if (isNaN(c) || c <= 0) continue;
    bars.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: o,
      close: c,
      volume: v,
    });
  }
  return bars;
}

async function fetchAllBars(tickers: string[], concurrency = 10): Promise<Map<string, DailyBar[]>> {
  const results = new Map<string, DailyBar[]>();
  let idx = 0;
  const total = tickers.length;

  async function worker() {
    while (idx < total) {
      const i = idx++;
      const symbol = tickers[i];
      try {
        const bars = await fetchDailyBars(symbol);
        if (bars.length > 1) results.set(symbol, bars);
      } catch { /* skip */ }
      if (i % 50 === 0) process.stdout.write(`\r  Fetched ${i}/${total} tickers...`);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  process.stdout.write(`\r  Fetched ${total}/${total} tickers.     \n`);
  return results;
}

// ── Step 3: Compute daily movers ─────────────────────────────────────────

type Mover = {
  symbol: string;
  date: string;
  changePct: number;
  closePrice: number;
};

function computeDailyMovers(allBars: Map<string, DailyBar[]>): Map<string, { gainers: Mover[]; losers: Mover[] }> {
  // Collect all trading dates
  const allDates = new Set<string>();
  for (const bars of allBars.values()) {
    for (const b of bars) allDates.add(b.date);
  }
  const sortedDates = [...allDates].sort();

  const dailyMovers = new Map<string, { gainers: Mover[]; losers: Mover[] }>();

  for (let di = 1; di < sortedDates.length; di++) {
    const today = sortedDates[di];
    const yesterday = sortedDates[di - 1];
    const changes: Mover[] = [];

    for (const [symbol, bars] of allBars) {
      const todayBar = bars.find(b => b.date === today);
      const yesterdayBar = bars.find(b => b.date === yesterday);
      if (!todayBar || !yesterdayBar || yesterdayBar.close <= 0) continue;
      // Skip low-volume / penny stocks
      if (todayBar.close < 5 || todayBar.volume < 100000) continue;

      const changePct = ((todayBar.close - yesterdayBar.close) / yesterdayBar.close) * 100;
      changes.push({ symbol, date: today, changePct, closePrice: todayBar.close });
    }

    // Sort by change %, pick top 10 each direction
    const sorted = changes.sort((a, b) => b.changePct - a.changePct);
    const gainers = sorted.slice(0, 10);
    const losers = sorted.slice(-10).reverse(); // most negative first

    dailyMovers.set(today, { gainers, losers });
  }

  return dailyMovers;
}

// ── Step 4: Backfill database ────────────────────────────────────────────

async function backfillDatabase(
  dailyMovers: Map<string, { gainers: Mover[]; losers: Mover[] }>,
  allBars: Map<string, DailyBar[]>
) {
  const parsed = new URL(DB_URL);
  const pool = mysql.createPool({
    host: parsed.hostname,
    port: Number(parsed.port) || 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace("/", ""),
    connectionLimit: 5,
    timezone: "Z",
  });

  // Get sorted dates for follow-up price lookups
  const allDates = [...dailyMovers.keys()].sort();

  // Skip today (already handled by live sync) and the last 0 days that don't have enough follow-up
  const today = new Date().toISOString().slice(0, 10);
  const cohortDates = allDates.filter(d => d < today);

  console.log(`\n  Backfilling ${cohortDates.length} cohort days...`);

  let totalEnrolled = 0;
  let totalPricesFilled = 0;

  for (const cohortDate of cohortDates) {
    const { gainers, losers } = dailyMovers.get(cohortDate)!;
    const enrollment = [
      ...gainers.map(m => ({ ...m, direction: "SHORT" as const })),
      ...losers.map(m => ({ ...m, direction: "LONG" as const })),
    ];

    for (const item of enrollment) {
      // Insert the entry
      await pool.execute(
        `INSERT INTO reversal_entries
         (cohort_date, symbol, direction, day_change_pct, entry_price, consecutive_days, cumulative_change_pct, status)
         VALUES (?, ?, ?, ?, ?, 1, ?, 'ACTIVE')
         ON DUPLICATE KEY UPDATE
           entry_price = VALUES(entry_price),
           day_change_pct = VALUES(day_change_pct)`,
        [cohortDate, item.symbol, item.direction, item.changePct, item.closePrice, item.changePct]
      );
      totalEnrolled++;

      // Fill follow-up close prices
      const bars = allBars.get(item.symbol);
      if (!bars) continue;

      // Find trading days after cohort date
      const futureBars = bars.filter(b => b.date > cohortDate).sort((a, b) => a.date.localeCompare(b.date));

      const updates: string[] = [];
      const params: (number | string)[] = [];

      for (let d = 0; d < Math.min(10, futureBars.length); d++) {
        const bar = futureBars[d];
        // Fill morning with open, evening with close
        const dayNum = d + 1;
        updates.push(`d${dayNum}_morning = COALESCE(d${dayNum}_morning, ?)`);
        params.push(bar.open);
        updates.push(`d${dayNum}_close = COALESCE(d${dayNum}_close, ?)`);
        params.push(bar.close);
        totalPricesFilled += 2;
      }

      if (updates.length > 0) {
        // Get the entry ID
        const [rows] = await pool.execute<mysql.RowDataPacket[]>(
          "SELECT id FROM reversal_entries WHERE cohort_date = ? AND symbol = ?",
          [cohortDate, item.symbol]
        );
        if (rows.length > 0) {
          params.push(rows[0].id);
          await pool.execute(
            `UPDATE reversal_entries SET ${updates.join(", ")} WHERE id = ?`,
            params
          );
        }
      }
    }

    process.stdout.write(`\r  Processed cohort ${cohortDate} (${enrollment.length} tickers)`);
  }

  // Mark old entries as COMPLETED (14+ days ago)
  await pool.execute(
    "UPDATE reversal_entries SET status = 'COMPLETED' WHERE cohort_date < DATE_SUB(CURRENT_DATE, INTERVAL 14 DAY)"
  );

  console.log(`\n\n  Done! Enrolled ${totalEnrolled} entries, filled ${totalPricesFilled} price points.`);

  // Summary
  const [countResult] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) as total, COUNT(d1_close) as with_d1, COUNT(d5_close) as with_d5, COUNT(d10_close) as with_d10 FROM reversal_entries"
  );
  const c = countResult[0];
  console.log(`  Matrix: ${c.total} total entries | D1: ${c.with_d1} | D5: ${c.with_d5} | D10: ${c.with_d10}`);

  const [cohortCount] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT COUNT(DISTINCT cohort_date) as cohorts FROM reversal_entries"
  );
  console.log(`  Cohort dates: ${cohortCount[0].cohorts}`);

  await pool.end();
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Matrix Backfill — Historical Mean Reversion  ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  console.log("Step 1: Fetching S&P 500 ticker list...");
  const tickers = await getSP500Tickers();
  console.log(`  Found ${tickers.length} tickers.\n`);

  console.log("Step 2: Downloading daily bars from Yahoo Finance...");
  const allBars = await fetchAllBars(tickers, 10);
  console.log(`  Got data for ${allBars.size} tickers.\n`);

  console.log("Step 3: Computing daily movers...");
  const dailyMovers = computeDailyMovers(allBars);
  console.log(`  Computed movers for ${dailyMovers.size} trading days.\n`);

  // Show a sample
  const sampleDate = [...dailyMovers.keys()].sort().slice(-2, -1)[0];
  if (sampleDate) {
    const { gainers, losers } = dailyMovers.get(sampleDate)!;
    console.log(`  Sample (${sampleDate}):`);
    console.log(`    Top gainers: ${gainers.slice(0, 3).map(g => `${g.symbol} +${g.changePct.toFixed(1)}%`).join(", ")}`);
    console.log(`    Top losers:  ${losers.slice(0, 3).map(l => `${l.symbol} ${l.changePct.toFixed(1)}%`).join(", ")}`);
  }

  console.log("\nStep 4: Backfilling database...");
  await backfillDatabase(dailyMovers, allBars);

  console.log("\n✓ Backfill complete.");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
