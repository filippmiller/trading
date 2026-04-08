#!/usr/bin/env npx tsx
/**
 * Surveillance Cron Scheduler
 *
 * Runs automatically and:
 * 1. Enrolls today's top 10 gainers + 10 losers at market open (9:45 AM ET)
 * 2. Fetches intraday prices 3x/day: morning (9:40 ET), midday (12:35 ET), close (16:05 ET)
 * 3. Backfills any missing prices for active entries
 *
 * Usage: npx tsx scripts/surveillance-cron.ts
 *
 * Runs as a long-lived process with node-cron scheduling.
 * All times are US Eastern (America/New_York).
 */

import cron from "node-cron";
import mysql from "mysql2/promise";

// ─── Config ─────────────────────────────────────────────────────────────────

function requiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const DB_CONFIG: mysql.PoolOptions = {
  host: requiredEnv("MYSQL_HOST"),
  port: Number(requiredEnv("MYSQL_PORT")),
  user: requiredEnv("MYSQL_USER"),
  password: requiredEnv("MYSQL_PASSWORD"),
  database: requiredEnv("MYSQL_DB"),
  waitForConnections: true,
  connectionLimit: 5,
  timezone: "Z",
};

const RATE_LIMIT_MS = Number(process.env.RATE_LIMIT_MS ?? 500);

let pool: mysql.Pool | null = null;
function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Yahoo Finance API ──────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const SYMBOL_RE = /^[A-Z0-9.\-]{1,16}$/;

type Mover = {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  consecutiveDays: number;
  cumulativeChangePct: number;
};

async function fetchMoversFromYahoo(type: "gainers" | "losers"): Promise<Mover[]> {
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_${type}&count=25`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Yahoo movers API ${res.status}`);
  const data = await res.json();
  const quotes = data?.finance?.result?.[0]?.quotes ?? [];
  return quotes
    .filter((q: Record<string, unknown>) => typeof q.symbol === "string" && SYMBOL_RE.test(q.symbol))
    .map((q: Record<string, unknown>) => ({
      symbol: q.symbol as string,
      name: (q.shortName || q.longName || q.symbol) as string,
      price: isFinite(Number(q.regularMarketPrice)) ? Number(q.regularMarketPrice) : 0,
      changePct: isFinite(Number(q.regularMarketChangePercent)) ? Number(q.regularMarketChangePercent) : 0,
      consecutiveDays: 1,
      cumulativeChangePct: isFinite(Number(q.regularMarketChangePercent)) ? Number(q.regularMarketChangePercent) : 0,
    }));
}

async function fetchDailyBars(symbol: string): Promise<{ date: string; close: number }[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  const timestamps: number[] = result?.timestamp || [];
  const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];
  const rows: { date: string; close: number }[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    if (c == null || !isFinite(c)) continue;
    const d = new Date(timestamps[i] * 1000);
    rows.push({ date: d.toISOString().split("T")[0], close: c });
  }
  return rows;
}

/** Enhance a mover with consecutive-day streak data (matches src/lib/surveillance.ts enhanceWithTrend) */
async function enhanceWithTrend(mover: Mover): Promise<Mover> {
  try {
    const bars = await fetchDailyBars(mover.symbol);
    if (bars.length < 2) return mover;
    const recent = bars.slice(-5);
    const history: { changePct: number }[] = [];
    for (let i = 1; i < recent.length; i++) {
      history.push({ changePct: ((recent[i].close - recent[i - 1].close) / recent[i - 1].close) * 100 });
    }
    let consecutiveDays = 0;
    let trendDirection: "UP" | "DOWN" | undefined;
    const rev = [...history].reverse();
    for (let i = 0; i < rev.length; i++) {
      const dir = rev[i].changePct > 0 ? "UP" : "DOWN";
      if (i === 0) { trendDirection = dir; consecutiveDays = 1; }
      else if (dir === trendDirection) consecutiveDays++;
      else break;
    }
    let cumulativeChangePct = mover.changePct;
    if (consecutiveDays > 0 && bars.length > consecutiveDays) {
      const startPrice = bars[bars.length - 1 - consecutiveDays].close;
      const endPrice = bars[bars.length - 1].close;
      cumulativeChangePct = ((endPrice - startPrice) / startPrice) * 100;
    }
    return { ...mover, consecutiveDays, cumulativeChangePct };
  } catch {
    return mover;
  }
}

async function fetchIntradayPrice(
  symbol: string,
  dateStr: string,
  timeType: "morning" | "midday" | "close"
): Promise<number | null> {
  try {
    const targetDate = new Date(`${dateStr}T12:00:00Z`);
    const start = Math.floor(targetDate.getTime() / 1000) - 86400;
    const end = Math.floor(targetDate.getTime() / 1000) + 86400;

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=5m`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp || [];
    const prices: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];
    if (!timestamps.length) return null;

    let targetHour = 9, targetMin = 35;
    if (timeType === "midday") { targetHour = 12; targetMin = 30; }
    if (timeType === "close") { targetHour = 15; targetMin = 55; }

    let closestPrice: number | null = null;
    let minDiff = Infinity;

    for (let i = 0; i < timestamps.length; i++) {
      const px = prices[i];
      if (px == null || !isFinite(px)) continue;

      const d = new Date(timestamps[i] * 1000);
      const nyTime = d.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
      const [nyDate, nyClock] = nyTime.split(", ");
      const [h, m] = nyClock.split(":").map(Number);
      const [targetY, targetM, targetD] = dateStr.split("-").map(Number);
      const [mNY, dNY, yNY] = nyDate.split("/").map(Number);
      if (yNY !== targetY || mNY !== targetM || dNY !== targetD) continue;

      const diff = Math.abs((h * 60 + m) - (targetHour * 60 + targetMin));
      if (diff < minDiff && diff <= 15) {
        minDiff = diff;
        closestPrice = px;
      }
    }
    return closestPrice;
  } catch {
    return null;
  }
}

// Column name allowlist to prevent SQL injection
const VALID_COLUMNS = new Set<string>();
for (let d = 1; d <= 10; d++) {
  for (const t of ["morning", "midday", "close"]) {
    VALID_COLUMNS.add(`d${d}_${t}`);
  }
}

// ─── Concurrency Guard ──────────────────────────────────────────────────────

let syncRunning = false;
let enrollRunning = false;

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  console.log(`[${ts}] ${msg}`);
}

/** Returns today's date as YYYY-MM-DD in ET timezone */
function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

/** Returns true if today (ET) is a weekday */
function isTradingDay(): boolean {
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date());
  return !["Sat", "Sun"].includes(dow);
}

function isTimePast(timeType: "morning" | "midday" | "close"): boolean {
  const now = new Date();
  const nyTime = now.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
  const [, nyClock] = nyTime.split(", ");
  const [h, m] = nyClock.split(":").map(Number);
  const curr = h * 60 + m;
  if (timeType === "morning") return curr > 9 * 60 + 35;
  if (timeType === "midday") return curr > 12 * 60 + 30;
  return curr > 15 * 60 + 55;
}

// ─── Core Jobs ──────────────────────────────────────────────────────────────

/** Enroll today's top 10 gainers + 10 losers */
async function jobEnrollMovers() {
  if (enrollRunning) { log("  SKIP: enrollment already running"); return; }
  enrollRunning = true;
  try {
    if (!isTradingDay()) {
      log("  SKIP: not a trading day");
      return;
    }

    const db = getPool();
    const today = todayET();
    log(`Enrolling movers for ${today}...`);

    const [gainersResult, losersResult] = await Promise.allSettled([
      fetchMoversFromYahoo("gainers"),
      fetchMoversFromYahoo("losers"),
    ]);

    let gainers = gainersResult.status === "fulfilled" ? gainersResult.value.slice(0, 10) : [];
    let losers = losersResult.status === "fulfilled" ? losersResult.value.slice(0, 10) : [];
    const enrollment = [...gainers, ...losers];

    if (enrollment.length === 0) {
      log("  WARNING: No movers fetched. Yahoo API may be down.");
      return;
    }

    // Enhance with trend data (consecutive days, cumulative change)
    const enhanced = await Promise.all(enrollment.map(enhanceWithTrend));

    let enrolled = 0;
    for (const item of enhanced) {
      const direction = item.changePct > 0 ? "SHORT" : "LONG";
      await db.execute(
        `INSERT INTO reversal_entries (cohort_date, symbol, direction, day_change_pct, entry_price, consecutive_days, cumulative_change_pct, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
         ON DUPLICATE KEY UPDATE
           entry_price = VALUES(entry_price),
           day_change_pct = VALUES(day_change_pct),
           consecutive_days = VALUES(consecutive_days),
           cumulative_change_pct = VALUES(cumulative_change_pct)`,
        [today, item.symbol, direction, item.changePct, item.price, item.consecutiveDays, item.cumulativeChangePct]
      );
      enrolled++;
    }
    log(`  Enrolled ${enrolled} tickers (${gainers.length}G + ${losers.length}L)`);
  } finally {
    enrollRunning = false;
  }
}

/** Fetch and store intraday prices for all active entries */
async function jobSyncPrices() {
  if (syncRunning) { log("  SKIP: previous sync still running"); return; }
  syncRunning = true;

  const db = getPool();
  let logId: number | null = null;
  let updated = 0, failed = 0, skipped = 0;
  let status: "SUCCESS" | "FAILED" = "FAILED";

  try {
    log("Syncing prices for active entries...");

    // Insert RUNNING log entry
    const [logResult] = await db.execute<mysql.ResultSetHeader>(
      "INSERT INTO surveillance_logs (status) VALUES ('RUNNING')"
    );
    logId = logResult.insertId;

    // Auto-close entries older than 14 calendar days (using ET date, not UTC)
    const cutoffDate = new Date(todayET());
    cutoffDate.setDate(cutoffDate.getDate() - 14);
    await db.execute(
      "UPDATE reversal_entries SET status = 'COMPLETED' WHERE status = 'ACTIVE' AND cohort_date < ?",
      [cutoffDate.toISOString().split("T")[0]]
    );

    const [entries] = await db.execute<mysql.RowDataPacket[]>(
      "SELECT * FROM reversal_entries WHERE status = 'ACTIVE'"
    );

    for (const row of entries) {
      const entryDate = new Date(row.cohort_date);

      // Iterate trading days (skip weekends), map to d1..d10 columns
      let tradingDay = 0;
      const obsDate = new Date(entryDate);
      while (tradingDay < 10) {
        obsDate.setDate(obsDate.getDate() + 1);
        if (obsDate.getDay() === 0 || obsDate.getDay() === 6) continue;
        tradingDay++;

        const dateStr = obsDate.toISOString().split("T")[0];
        const nowStr = todayET();
        if (dateStr > nowStr) break; // future dates — stop for this entry

        for (const timeType of ["morning", "midday", "close"] as const) {
          const colName = `d${tradingDay}_${timeType}`;
          if (!VALID_COLUMNS.has(colName)) continue;
          if (row[colName] !== null) continue;

          // Skip entries that gave up after 5 retries
          const [dlqRows] = await db.execute<mysql.RowDataPacket[]>(
            "SELECT 1 FROM surveillance_failures WHERE entry_id = ? AND field_name = ? AND status = 'GAVE_UP'",
            [row.id, colName]
          );
          if (dlqRows.length > 0) { skipped++; continue; }

          await sleep(RATE_LIMIT_MS);
          const price = await fetchIntradayPrice(row.symbol, dateStr, timeType);

          if (price != null) {
            await db.execute(
              `UPDATE reversal_entries SET ${colName} = ? WHERE id = ?`,
              [price, row.id]
            );
            updated++;
          } else if (dateStr < nowStr || (dateStr === nowStr && isTimePast(timeType))) {
            failed++;
            await db.execute(
              `INSERT INTO surveillance_failures (entry_id, symbol, field_name, error_message, last_attempt, retry_count)
               VALUES (?, ?, ?, 'Price not found', CURRENT_TIMESTAMP, 1)
               ON DUPLICATE KEY UPDATE retry_count = retry_count + 1, last_attempt = CURRENT_TIMESTAMP`,
              [row.id, row.symbol, colName]
            );
            await db.execute(
              "UPDATE surveillance_failures SET status = 'GAVE_UP' WHERE entry_id = ? AND field_name = ? AND retry_count >= 5",
              [row.id, colName]
            );
          }
        }
      }
    }

    status = "SUCCESS";
    log(`  Done: ${updated} prices filled, ${failed} failed, ${skipped} skipped (${entries.length} active entries)`);
  } finally {
    syncRunning = false;
    // Update log entry
    if (logId) {
      const stats = JSON.stringify({ updated, failed, skipped });
      await db.execute(
        "UPDATE surveillance_logs SET finished_at = CURRENT_TIMESTAMP(6), status = ?, stats_json = ? WHERE id = ?",
        [status, stats, logId]
      ).catch(err => log(`ERROR updating log: ${err}`));
    }
  }
}

// ─── Schedule ───────────────────────────────────────────────────────────────

async function runFullSync() {
  try {
    await jobEnrollMovers();
  } catch (err) {
    log(`ERROR enrolling movers: ${err}`);
  }
  try {
    await jobSyncPrices();
  } catch (err) {
    log(`ERROR syncing prices: ${err}`);
  }
}

const CRON_OPTIONS = { timezone: "America/New_York" };

cron.schedule("45 9 * * 1-5", async () => {
  log("=== MORNING: Enroll movers + sync ===");
  try { await runFullSync(); } catch (err) { log(`ERROR morning sync: ${err}`); }
}, CRON_OPTIONS);

cron.schedule("35 12 * * 1-5", async () => {
  log("=== MIDDAY: Sync prices ===");
  try { await jobSyncPrices(); } catch (err) { log(`ERROR midday sync: ${err}`); }
}, CRON_OPTIONS);

cron.schedule("5 16 * * 1-5", async () => {
  log("=== CLOSE: Sync prices ===");
  try { await jobSyncPrices(); } catch (err) { log(`ERROR close sync: ${err}`); }
}, CRON_OPTIONS);

cron.schedule("0 18 * * 1-5", async () => {
  log("=== EVENING CATCHUP: Final sync ===");
  try { await jobSyncPrices(); } catch (err) { log(`ERROR evening sync: ${err}`); }
}, CRON_OPTIONS);

// ─── Startup ────────────────────────────────────────────────────────────────

log("========================================");
log("Surveillance Cron Scheduler started");
log("Schedule (ET, Mon-Fri):");
log("  09:45 — Enroll movers + morning prices");
log("  12:35 — Midday prices");
log("  16:05 — Close prices");
log("  18:00 — Evening catchup");
log("========================================");

log("Running immediate catchup sync...");
runFullSync().then(() => {
  log("Startup sync complete. Waiting for scheduled jobs...");
}).catch(err => {
  log(`Startup sync error: ${err}`);
});
