#!/usr/bin/env npx tsx
/**
 * Backfill script — migrate existing MOVERS reversal_entries from
 * 09:45 AM enrollment semantics to post-close semantics.
 *
 * For each existing entry with enrollment_source='MOVERS':
 *   - Fetch Yahoo daily bars for the symbol (range=3mo covers Mar-Apr 2026)
 *   - Find the bar matching cohort_date → take its close as new entry_price
 *   - Find the previous trading bar → compute day_change_pct = (close - prev_close) / prev_close * 100
 *   - UPDATE entry_price + day_change_pct in place
 *
 * d1..d10 columns are NOT touched — they're already correct (follow-up days
 * after cohort_date, which did not change).
 *
 * Usage:
 *   bash scripts/tunnel-db.sh        # in one terminal
 *   npx tsx scripts/backfill-movers-post-close.ts
 *
 * Safe to re-run: uses the symbol's historical daily close, which is stable.
 * Idempotent on repeated execution.
 */

import mysql from "mysql2/promise";

// DATABASE_URL must be set explicitly — credentials must never be hardcoded.
function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL environment variable is required. Never hardcode credentials.");
    process.exit(1);
  }
  return url;
}
const DB_URL: string = requireDatabaseUrl();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const FETCH_TIMEOUT_MS = 10000;
const RATE_LIMIT_MS = 300; // delay between Yahoo calls

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response | null> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

/** Fetch daily bars covering at least 3 months back for a symbol. */
async function fetchDailyBars(symbol: string): Promise<{ date: string; close: number }[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA } });
  if (!res) return [];
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  const timestamps: number[] = result?.timestamp || [];
  const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];
  const rows: { date: string; close: number }[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    if (c == null || !isFinite(c)) continue;
    const d = new Date(timestamps[i] * 1000);
    // Yahoo daily bar timestamps are end-of-day UTC; convert to ET calendar date.
    const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
    rows.push({ date: nyDate, close: c });
  }
  return rows;
}

function dateToStr(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v);
}

async function main() {
  console.log("═══ Backfill: migrate MOVERS entries to post-close semantics ═══\n");

  const parsed = new URL(DB_URL);
  const pool = mysql.createPool({
    host: parsed.hostname,
    port: Number(parsed.port) || 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace("/", ""),
    connectionLimit: 3,
    timezone: "Z",
  });

  try {
    // Dry-run mode: set DRY_RUN=1 to preview changes without UPDATEing.
    const dryRun = process.env.DRY_RUN === "1";
    if (dryRun) console.log("⚠ DRY RUN MODE — no UPDATEs will be executed.\n");

    // Load all MOVERS entries in the past (exclude today — today's cohort
    // will be re-enrolled by the new post-close cron naturally).
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, symbol, cohort_date, entry_price, day_change_pct
         FROM reversal_entries
        WHERE enrollment_source = 'MOVERS'
          AND cohort_date < CURDATE()
        ORDER BY symbol, cohort_date`
    );
    console.log(`Found ${rows.length} MOVERS entries to backfill.\n`);
    if (rows.length === 0) {
      console.log("Nothing to do.");
      return;
    }

    // Group entries by symbol to minimize Yahoo calls
    const bySymbol = new Map<string, mysql.RowDataPacket[]>();
    for (const r of rows) {
      const sym = String(r.symbol);
      if (!bySymbol.has(sym)) bySymbol.set(sym, []);
      bySymbol.get(sym)!.push(r);
    }
    console.log(`Across ${bySymbol.size} unique symbols.\n`);

    let updated = 0, missedBar = 0, missedPrev = 0, fetchFailed = 0;
    const changes: Array<{ id: number; symbol: string; date: string; oldPrice: number; newPrice: number; oldPct: number; newPct: number }> = [];

    let symIdx = 0;
    for (const [symbol, entries] of bySymbol) {
      symIdx++;
      process.stdout.write(`\r[${symIdx}/${bySymbol.size}] ${symbol.padEnd(6)}  `);

      const bars = await fetchDailyBars(symbol);
      if (bars.length === 0) {
        fetchFailed += entries.length;
        continue;
      }

      // Build a map date → close, plus sorted array for prev-close lookup
      const dateToClose = new Map<string, number>();
      for (const b of bars) dateToClose.set(b.date, b.close);
      const sortedDates = bars.map(b => b.date).sort();

      for (const entry of entries) {
        const cohortStr = dateToStr(entry.cohort_date);
        const close = dateToClose.get(cohortStr);
        if (close == null) {
          missedBar++;
          continue;
        }

        // Find previous trading day (prior bar in sortedDates)
        const idx = sortedDates.indexOf(cohortStr);
        if (idx <= 0) {
          missedPrev++;
          continue;
        }
        const prevDate = sortedDates[idx - 1];
        const prevClose = dateToClose.get(prevDate)!;

        const newDayChangePct = ((close - prevClose) / prevClose) * 100;
        const oldPrice = Number(entry.entry_price);
        const oldPct = Number(entry.day_change_pct);

        changes.push({
          id: Number(entry.id), symbol, date: cohortStr,
          oldPrice, newPrice: close, oldPct, newPct: newDayChangePct,
        });

        if (!dryRun) {
          await pool.execute(
            "UPDATE reversal_entries SET entry_price = ?, day_change_pct = ? WHERE id = ?",
            [close, newDayChangePct, entry.id]
          );
          updated++;
        }
      }

      await sleep(RATE_LIMIT_MS);
    }

    console.log("\n");
    console.log("═══ Results ═══");
    console.log(`  Updated (or would update): ${dryRun ? changes.length : updated}`);
    console.log(`  Missed (cohort_date not in Yahoo history, beyond 3mo):  ${missedBar}`);
    console.log(`  Missed (no prior bar for day_change_pct calc):          ${missedPrev}`);
    console.log(`  Yahoo fetch failed (symbol):                            ${fetchFailed}`);
    console.log();

    // Show top 10 samples
    if (changes.length > 0) {
      console.log("Sample of changes (up to 10):");
      console.log("  symbol  cohort       old_entry → new_entry   old_pct  → new_pct");
      for (const c of changes.slice(0, 10)) {
        const priceChg = `$${c.oldPrice.toFixed(2).padStart(8)} → $${c.newPrice.toFixed(2).padStart(8)}`;
        const pctChg = `${c.oldPct >= 0 ? "+" : ""}${c.oldPct.toFixed(1).padStart(5)}% → ${c.newPct >= 0 ? "+" : ""}${c.newPct.toFixed(1).padStart(5)}%`;
        console.log(`  ${c.symbol.padEnd(7)} ${c.date}   ${priceChg}   ${pctChg}`);
      }
      if (changes.length > 10) console.log(`  ... and ${changes.length - 10} more`);
    }

    if (dryRun) {
      console.log("\n(dry run — nothing persisted. Re-run without DRY_RUN=1 to apply.)");
    } else {
      console.log("\n✓ Backfill complete.");
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error("\nFAIL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
