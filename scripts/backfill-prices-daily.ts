/**
 * Backfill `prices_daily` for every symbol that has appeared in
 * `reversal_entries`. Needed so the /reversal matrix price-chart popover
 * can render historical bars for enrolled tickers — prices_daily was only
 * seeded for SPY/MU so 554 other symbols returned empty.
 *
 * Uses the existing `refreshSymbolData(symbol)` helper from src/lib/data.ts
 * which already handles:
 *   - Stooq as primary source (CSV, full history)
 *   - Yahoo Finance chart API as fallback (1-month range)
 *   - UPSERT into prices_daily (ON DUPLICATE KEY UPDATE)
 *
 * Rate-limited at 500 ms between symbols to stay under Stooq/Yahoo's
 * rate-limit thresholds when hitting ~600 symbols in a row.
 *
 * Usage (local dev, VPS MySQL via tunnel):
 *   npx tsx scripts/backfill-prices-daily.ts
 *
 * Usage (Railway prod via public proxy):
 *   MYSQL_HOST=switchback.proxy.rlwy.net MYSQL_PORT=48486 \
 *   MYSQL_USER=root MYSQL_PASSWORD=... MYSQL_DATABASE=railway \
 *   npx tsx scripts/backfill-prices-daily.ts
 *
 * The MySQL connection is driven by whatever `getPool()` picks up from
 * env — no Railway-specific logic in this script. Expect ~5 minutes for
 * 556 symbols at 500 ms throttle.
 */

import mysql from "mysql2/promise";
import { refreshSymbolData } from "../src/lib/data";
import { getPool } from "../src/lib/db";

const THROTTLE_MS = 500;
const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 2;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const pool = await getPool();

  // 1. Collect distinct symbols from the enrollment table.
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT DISTINCT symbol FROM reversal_entries WHERE symbol IS NOT NULL ORDER BY symbol ASC",
  );
  const symbols = rows.map((r) => String(r.symbol)).filter((s) => s && s.length > 0);
  console.log(`[backfill] found ${symbols.length} unique symbols in reversal_entries`);

  if (symbols.length === 0) {
    console.log("[backfill] nothing to do — no symbols in reversal_entries.");
    process.exit(0);
  }

  // 2. Loop: refresh each with retries + throttle + progress log.
  const start = Date.now();
  let ok = 0;
  let failed = 0;
  let totalRowsInserted = 0;
  const failures: Array<{ symbol: string; error: string }> = [];

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= MAX_RETRIES) {
      try {
        const res = await refreshSymbolData(symbol);
        totalRowsInserted += res.inserted;
        ok++;
        const progress = `[${i + 1}/${symbols.length}]`;
        const rate = ((i + 1) / ((Date.now() - start) / 1000)).toFixed(1);
        console.log(
          `${progress} ${symbol.padEnd(6)} ok · ${res.inserted.toString().padStart(3)} new / ${res.total} total · ${rate} sym/s`,
        );
        break;
      } catch (err) {
        lastError = err as Error;
        attempt++;
        if (attempt <= MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    if (lastError && attempt > MAX_RETRIES) {
      failed++;
      failures.push({ symbol, error: lastError.message });
      console.warn(
        `[${i + 1}/${symbols.length}] ${symbol.padEnd(6)} FAILED after ${MAX_RETRIES + 1} attempts · ${lastError.message}`,
      );
    }

    await sleep(THROTTLE_MS);
  }

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  console.log("");
  console.log(`[backfill] done in ${duration}s`);
  console.log(`[backfill] ok=${ok}, failed=${failed}, rows upserted=${totalRowsInserted}`);
  if (failures.length > 0) {
    console.log(`[backfill] failures:`);
    for (const f of failures) console.log(`  ${f.symbol}: ${f.error}`);
  }

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
