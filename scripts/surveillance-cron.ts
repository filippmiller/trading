#!/usr/bin/env npx tsx
/**
 * Surveillance Cron Scheduler
 *
 * Runs automatically and:
 * 1. Enrolls today's top 10 gainers + 10 losers at market open (9:45 AM ET)
 * 2. Fetches intraday prices 3x/day: morning (9:45 ET), midday (12:35 ET), close (16:05 ET)
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

function targetTimeFor(timeType: "morning" | "midday" | "close"): { h: number; m: number } {
  if (timeType === "midday") return { h: 12, m: 30 };
  if (timeType === "close") return { h: 15, m: 55 };
  return { h: 9, m: 35 };
}

const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY ?? "";

/** One 5-min bar with ET-localized date + time key. */
type Bar5m = { date: string; minutes: number; close: number };

/** Per-symbol cache of 60-day 5-min bars, scoped to a single sync run. */
type SymbolBarCache = Map<string, Bar5m[]>;

/**
 * Fetch 60 days of 5-min bars from Yahoo in a single call.
 *
 * Optimization: only keep bars near target times (9:30-9:45, 12:25-12:40, 15:50-16:05 ET).
 * Reduces per-symbol memory from ~4700 bars to ~10 bars per trading day × 60 days = ~600 bars.
 */
async function fetchYahoo60d(symbol: string): Promise<Bar5m[] | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=60d`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp || [];
    const prices: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];
    if (!timestamps.length) return null;

    // Target time windows (ET minutes since midnight): ±15 min around each target
    const windows = [
      { min: 9 * 60 + 20, max: 9 * 60 + 50 },   // morning 9:35 ± 15
      { min: 12 * 60 + 15, max: 12 * 60 + 45 }, // midday 12:30 ± 15
      { min: 15 * 60 + 40, max: 16 * 60 + 10 }, // close 15:55 ± 15
    ];
    const inWindow = (mins: number) => windows.some(w => mins >= w.min && mins <= w.max);

    const bars: Bar5m[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const px = prices[i];
      if (px == null || !isFinite(px)) continue;
      const d = new Date(timestamps[i] * 1000);
      const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
      const nyTime = d.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
      const [, clock] = nyTime.split(", ");
      const [h, m] = clock.split(":").map(Number);
      const mins = h * 60 + m;
      if (!inWindow(mins)) continue; // Drop bars outside target windows to save memory
      bars.push({ date: nyDate, minutes: mins, close: px });
    }
    return bars;
  } catch {
    return null;
  }
}

// Circuit breaker: once Twelve Data returns quota exhausted (429 or error),
// stop calling it for the rest of this sync run to avoid wasting time on 1-3s error responses.
let twelveDataDisabled = false;

/** Fetch 5-min bars for a single date from Twelve Data. */
async function fetchTwelveDataDay(symbol: string, dateStr: string): Promise<Bar5m[] | null> {
  if (!TWELVEDATA_API_KEY) return null;
  if (twelveDataDisabled) return null;
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=5min&start_date=${dateStr}%2009:30:00&end_date=${dateStr}%2016:00:00&timezone=America/New_York&apikey=${TWELVEDATA_API_KEY}`;
    const res = await fetch(url);
    if (res.status === 429) {
      twelveDataDisabled = true;
      log("  NOTE: Twelve Data quota exhausted, disabling for remainder of sync");
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.code === 429 || (data?.status === "error" && typeof data?.message === "string" && data.message.includes("API credits"))) {
      twelveDataDisabled = true;
      log("  NOTE: Twelve Data quota exhausted, disabling for remainder of sync");
      return null;
    }
    if (data?.status === "error") return null;
    const values: Array<{ datetime: string; close: string }> = data?.values ?? [];
    if (!values.length) return null;

    const bars: Bar5m[] = [];
    for (const v of values) {
      const close = Number(v.close);
      if (!isFinite(close)) continue;
      const [date, clock] = v.datetime.split(" ");
      if (!clock) continue;
      const [h, m] = clock.split(":").map(Number);
      bars.push({ date, minutes: h * 60 + m, close });
    }
    return bars;
  } catch {
    return null;
  }
}

/** Look up closest bar to a target time (within 15 minutes) for a specific date. */
function lookupBar(bars: Bar5m[], dateStr: string, timeType: "morning" | "midday" | "close"): number | null {
  const { h, m } = targetTimeFor(timeType);
  const targetMinutes = h * 60 + m;
  let closestPrice: number | null = null;
  let minDiff = Infinity;
  for (const bar of bars) {
    if (bar.date !== dateStr) continue;
    const diff = Math.abs(bar.minutes - targetMinutes);
    if (diff < minDiff && diff <= 15) {
      minDiff = diff;
      closestPrice = bar.close;
    }
  }
  return closestPrice;
}

/**
 * Get a symbol's 60-day bar cache, populating from Yahoo on first access.
 * Subsequent lookups (different dates, different time slots) reuse the cached data.
 */
async function getSymbolBars(cache: SymbolBarCache, symbol: string): Promise<Bar5m[] | null> {
  if (cache.has(symbol)) return cache.get(symbol) ?? null;
  const bars = await fetchYahoo60d(symbol);
  cache.set(symbol, bars ?? []);
  return bars;
}

/**
 * Fetches intraday price for a symbol at a specific time.
 *
 * Strategy:
 * 1. Use cached Yahoo 60-day bars if already fetched for this symbol
 * 2. If not cached, fetch 60 days once (single API call per symbol per sync)
 * 3. Fall back to Twelve Data ONLY if Yahoo completely failed for this symbol
 *    (empty bars). If Yahoo succeeded but bars don't cover target time,
 *    Twelve Data won't have it either — don't waste the call.
 *
 * Yahoo free tier gives us ~60 trading days of 5-min bars per call.
 */
async function fetchIntradayPrice(
  cache: SymbolBarCache,
  symbol: string,
  dateStr: string,
  timeType: "morning" | "midday" | "close"
): Promise<number | null> {
  const bars = await getSymbolBars(cache, symbol);

  // Yahoo succeeded: look up from cache (may be null if target date not covered)
  if (bars && bars.length > 0) {
    return lookupBar(bars, dateStr, timeType);
  }

  // Yahoo completely failed for this symbol → try Twelve Data
  const tdBars = await fetchTwelveDataDay(symbol, dateStr);
  if (tdBars && tdBars.length > 0) {
    return lookupBar(tdBars, dateStr, timeType);
  }

  return null;
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

// US market holidays (NYSE/NASDAQ closures) — update annually
const MARKET_HOLIDAYS = new Set([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-04-16", "2027-05-31",
  "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

/** Returns true if the given date string is a market holiday */
function isMarketHoliday(dateStr: string): boolean {
  return MARKET_HOLIDAYS.has(dateStr);
}

/** Returns true if today (ET) is a trading day (weekday + not a holiday) */
function isTradingDay(): boolean {
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date());
  if (["Sat", "Sun"].includes(dow)) return false;
  return !isMarketHoliday(todayET());
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

/** Enroll today's top 10 gainers + 10 losers. Idempotent — skips if already enrolled today. */
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

    // Idempotency: if we've already enrolled today's cohort, skip.
    // Prevents duplicate enrollments from container restarts, manual API triggers,
    // or scheduled re-runs — Yahoo's top movers change throughout the day, so
    // running again would add new symbols to the same cohort.
    const [existing] = await db.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) as cnt FROM reversal_entries WHERE cohort_date = ?",
      [today]
    );
    const existingCount = Number(existing[0]?.cnt ?? 0);
    if (existingCount > 0) {
      log(`  SKIP: already enrolled ${existingCount} tickers for ${today}`);
      return;
    }

    log(`Enrolling movers for ${today}...`);

    const [gainersResult, losersResult] = await Promise.allSettled([
      fetchMoversFromYahoo("gainers"),
      fetchMoversFromYahoo("losers"),
    ]);

    const gainers = gainersResult.status === "fulfilled" ? gainersResult.value.slice(0, 10) : [];
    const losers = losersResult.status === "fulfilled" ? losersResult.value.slice(0, 10) : [];
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

    // Reset Twelve Data circuit breaker for this sync run
    twelveDataDisabled = false;

    // Mark any orphaned RUNNING logs as FAILED (e.g., container killed mid-sync)
    await db.execute(
      "UPDATE surveillance_logs SET status = 'FAILED', error_message = 'Orphaned — container restart', finished_at = CURRENT_TIMESTAMP(6) WHERE status = 'RUNNING' AND started_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)"
    );

    // Insert RUNNING log entry
    const [logResult] = await db.execute<mysql.ResultSetHeader>(
      "INSERT INTO surveillance_logs (status) VALUES ('RUNNING')"
    );
    logId = logResult.insertId;

    // Auto-close entries older than 14 calendar days
    await db.execute(
      "UPDATE reversal_entries SET status = 'COMPLETED' WHERE status = 'ACTIVE' AND cohort_date < DATE_SUB(CURRENT_DATE, INTERVAL 14 DAY)"
    );

    const [entries] = await db.execute<mysql.RowDataPacket[]>(
      "SELECT * FROM reversal_entries WHERE status = 'ACTIVE' ORDER BY cohort_date DESC LIMIT 500"
    );

    // Per-sync cache of 60-day 5-min bars per symbol.
    // Dramatically reduces API calls: 1 Yahoo call per symbol covers all 30 d1-d10 slots.
    const barCache: SymbolBarCache = new Map();

    for (const row of entries) {
      const entryDate = new Date(row.cohort_date);

      // Iterate trading days (skip weekends + holidays), map to d1..d10 columns
      let tradingDay = 0;
      const obsDate = new Date(entryDate);
      while (tradingDay < 10) {
        obsDate.setDate(obsDate.getDate() + 1);
        if (obsDate.getDay() === 0 || obsDate.getDay() === 6) continue;
        const dateStr = obsDate.toISOString().split("T")[0];
        if (isMarketHoliday(dateStr)) continue;
        tradingDay++;
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

          // Rate limit only on cache miss (first call per symbol).
          // Cache hits are free and instant.
          const isCacheMiss = !barCache.has(row.symbol);
          if (isCacheMiss) await sleep(RATE_LIMIT_MS);
          const price = await fetchIntradayPrice(barCache, row.symbol, dateStr, timeType);

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

// ─── Paper Position Monitor ────────────────────────────────────────────────

/**
 * Monitor open paper positions + pending orders every 15 minutes during market hours.
 * - Fetches live prices for all open positions and pending orders
 * - Records prices in paper_position_prices for charting
 * - Fills triggered limit/stop orders
 * - Checks exit conditions (hard stop, trailing stop, take profit, time exit)
 * - Updates max/min watermarks on paper_signals
 */
async function jobMonitorPositions() {
  if (!isTradingDay()) return;

  const db = getPool();

  // 1. Fetch all open signals (from paper_signals WHERE status = 'EXECUTED' AND exit_at IS NULL)
  const [openSignals] = await db.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM paper_signals WHERE status = 'EXECUTED' AND exit_at IS NULL"
  );

  // 2. Fetch all pending orders
  const [pendingOrders] = await db.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM paper_orders WHERE status = 'PENDING'"
  );

  // 3. Collect unique symbols
  const symbols = new Set<string>();
  for (const s of openSignals) symbols.add(s.symbol);
  for (const o of pendingOrders) symbols.add(o.symbol);

  if (symbols.size === 0) {
    log("  Monitor: 0 positions, 0 pending orders — nothing to do");
    return;
  }

  // 4. Fetch live prices (batched, rate-limited)
  const prices: Record<string, number> = {};
  const symbolArr = [...symbols];
  for (let i = 0; i < symbolArr.length; i += 5) {
    const batch = symbolArr.slice(i, i + 5);
    await Promise.all(batch.map(async (sym) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`;
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (!res.ok) return;
        const data = await res.json();
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (typeof price === "number" && isFinite(price) && price > 0) {
          prices[sym] = price;
        }
      } catch { /* skip */ }
    }));
    if (i + 5 < symbolArr.length) await sleep(300);
  }

  let pricesRecorded = 0, ordersFilled = 0, positionsClosed = 0;

  // 5. Record prices + update watermarks for open signals
  for (const sig of openSignals) {
    const price = prices[sig.symbol];
    if (price == null) continue;

    // Record price point
    await db.execute(
      "INSERT INTO paper_position_prices (signal_id, price) VALUES (?, ?)",
      [sig.id, price]
    );
    pricesRecorded++;

    // Update max/min watermarks
    const maxPrice = Math.max(Number(sig.max_price || 0), price);
    const minPrice = sig.min_price ? Math.min(Number(sig.min_price), price) : price;
    const entryPrice = Number(sig.entry_price);
    const pnlPct = entryPrice > 0 ? ((price - entryPrice) / entryPrice) * 100 : 0;
    const leverage = Number(sig.leverage || 1);
    const leveragedPnl = pnlPct * leverage;
    const maxPnl = Math.max(Number(sig.max_pnl_pct || -999), leveragedPnl);
    const minPnl = Math.min(Number(sig.min_pnl_pct || 999), leveragedPnl);

    await db.execute(
      `UPDATE paper_signals SET max_price = ?, min_price = ?, max_pnl_pct = ?, min_pnl_pct = ? WHERE id = ?`,
      [maxPrice, minPrice, maxPnl, minPnl, sig.id]
    );

    // Check exit conditions from strategy config
    const [stratRows] = await db.execute<mysql.RowDataPacket[]>(
      "SELECT config_json, leverage FROM paper_strategies WHERE id = ?",
      [sig.strategy_id]
    );
    if (stratRows.length === 0) continue;

    const config = JSON.parse(stratRows[0].config_json);
    const exits = config.exits || {};

    let exitReason: string | null = null;

    // Hard stop
    if (exits.hard_stop_pct != null && pnlPct <= exits.hard_stop_pct) {
      exitReason = "HARD_STOP";
    }

    // Leverage liquidation
    if (leverage > 1 && leveragedPnl <= -90) {
      exitReason = "LIQUIDATED";
    }

    // Take profit
    if (exits.take_profit_pct != null && pnlPct >= exits.take_profit_pct) {
      exitReason = "TAKE_PROFIT";
    }

    // Trailing stop
    if (exits.trailing_stop_pct != null) {
      const activateAt = exits.trailing_activates_at_profit_pct ?? 0;
      let trailActive = sig.trailing_active === 1;
      let trailStop = sig.trailing_stop_price ? Number(sig.trailing_stop_price) : null;

      if (!trailActive && pnlPct >= activateAt) {
        trailActive = true;
        trailStop = price * (1 - exits.trailing_stop_pct / 100);
      }
      if (trailActive) {
        const newStop = maxPrice * (1 - exits.trailing_stop_pct / 100);
        if (trailStop == null || newStop > trailStop) trailStop = newStop;
        if (price <= trailStop) exitReason = "TRAIL_STOP";
      }

      // Persist trailing state
      await db.execute(
        "UPDATE paper_signals SET trailing_active = ?, trailing_stop_price = ? WHERE id = ?",
        [trailActive ? 1 : 0, trailStop, sig.id]
      );
    }

    // Time exit (trading days)
    if (exits.time_exit_days != null && sig.entry_at) {
      const entryMs = new Date(sig.entry_at).getTime();
      const holdDays = (Date.now() - entryMs) / (1000 * 60 * 60 * 24);
      const tradingDays = Math.floor(holdDays * 5 / 7);
      if (tradingDays >= exits.time_exit_days) exitReason = "TIME";
    }

    // Execute exit
    if (exitReason) {
      const investment = Number(sig.investment_usd);
      const rawPct = ((price - entryPrice) / entryPrice) * 100;
      const leveragedPctFinal = Math.max(rawPct * leverage, -100);
      const pnlUsd = investment * (leveragedPctFinal / 100);
      const holdMinutes = sig.entry_at
        ? Math.round((Date.now() - new Date(sig.entry_at).getTime()) / 60000)
        : null;

      await db.execute(
        `UPDATE paper_signals SET
           status = CASE WHEN ? > 0 THEN 'WIN' ELSE 'LOSS' END,
           exit_price = ?, exit_at = CURRENT_TIMESTAMP(6), exit_reason = ?,
           pnl_usd = ?, pnl_pct = ?, holding_minutes = ?
         WHERE id = ?`,
        [pnlUsd, price, exitReason, pnlUsd, leveragedPctFinal, holdMinutes, sig.id]
      );

      // Return cash to strategy account
      const proceeds = investment + pnlUsd;
      if (proceeds > 0) {
        await db.execute(
          "UPDATE paper_accounts SET cash = cash + ? WHERE id = (SELECT account_id FROM paper_strategies WHERE id = ?)",
          [proceeds, sig.strategy_id]
        );
      }

      positionsClosed++;
      log(`    EXIT ${sig.symbol} [${exitReason}] P&L: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} (${leveragedPctFinal.toFixed(1)}%)`);
    }
  }

  // 6. Fill triggered pending orders (limit/stop)
  for (const order of pendingOrders) {
    const price = prices[order.symbol];
    if (price == null) continue;

    const limit = order.limit_price ? Number(order.limit_price) : null;
    const stop = order.stop_price ? Number(order.stop_price) : null;
    const side = order.side as string;
    const type = order.order_type as string;

    let shouldFill = false;
    if (type === "MARKET") shouldFill = true;
    else if (type === "LIMIT" && limit != null) {
      shouldFill = side === "BUY" ? price <= limit : price >= limit;
    } else if (type === "STOP" && stop != null) {
      shouldFill = side === "BUY" ? price >= stop : price <= stop;
    }

    if (!shouldFill) continue;

    // Fill via the existing paper trading engine
    if (side === "BUY" && order.investment_usd) {
      const investment = Number(order.investment_usd);
      const [acctRows] = await db.execute<mysql.RowDataPacket[]>(
        "SELECT cash FROM paper_accounts WHERE id = ?", [order.account_id]
      );
      if (acctRows.length === 0 || Number(acctRows[0].cash) < investment) {
        await db.execute("UPDATE paper_orders SET status='REJECTED', rejection_reason='Insufficient cash' WHERE id=?", [order.id]);
        continue;
      }
      const qty = investment / price;
      const [tradeResult] = await db.execute<mysql.ResultSetHeader>(
        `INSERT INTO paper_trades (account_id, symbol, quantity, buy_price, buy_date, investment_usd, strategy, status)
         VALUES (?, ?, ?, ?, CURRENT_DATE, ?, ?, 'OPEN')`,
        [order.account_id, order.symbol, qty, price, investment, `${type} BUY`]
      );
      await db.execute("UPDATE paper_accounts SET cash = cash - ? WHERE id = ?", [investment, order.account_id]);
      await db.execute(
        "UPDATE paper_orders SET status='FILLED', filled_price=?, filled_at=CURRENT_TIMESTAMP(6), trade_id=? WHERE id=?",
        [price, tradeResult.insertId, order.id]
      );
      ordersFilled++;
      log(`    FILL ${order.symbol} ${type} BUY at $${price.toFixed(2)}`);
    } else if (side === "SELL") {
      const tradeId = order.trade_id ? Number(order.trade_id) : null;
      const [tradeRows] = await db.execute<mysql.RowDataPacket[]>(
        tradeId
          ? "SELECT * FROM paper_trades WHERE id=? AND status='OPEN'"
          : "SELECT * FROM paper_trades WHERE account_id=? AND symbol=? AND status='OPEN' ORDER BY id ASC LIMIT 1",
        tradeId ? [tradeId] : [order.account_id, order.symbol]
      );
      if (tradeRows.length === 0) {
        await db.execute("UPDATE paper_orders SET status='REJECTED', rejection_reason='No open position' WHERE id=?", [order.id]);
        continue;
      }
      const trade = tradeRows[0];
      const buyPrice = Number(trade.buy_price);
      const investment = Number(trade.investment_usd);
      const qty = Number(trade.quantity) || investment / buyPrice;
      const proceeds = qty * price;
      const pnlUsd = proceeds - investment;
      const pnlPctVal = (pnlUsd / investment) * 100;

      await db.execute("UPDATE paper_trades SET status='CLOSED', sell_price=?, sell_date=CURRENT_DATE, pnl_usd=?, pnl_pct=? WHERE id=?",
        [price, pnlUsd, pnlPctVal, trade.id]);
      await db.execute("UPDATE paper_accounts SET cash = cash + ? WHERE id = ?", [proceeds, order.account_id]);
      await db.execute("UPDATE paper_orders SET status='FILLED', filled_price=?, filled_at=CURRENT_TIMESTAMP(6), trade_id=? WHERE id=?",
        [price, trade.id, order.id]);
      ordersFilled++;
      log(`    FILL ${order.symbol} ${type} SELL at $${price.toFixed(2)}`);
    }
  }

  log(`  Monitor: ${pricesRecorded} prices recorded, ${ordersFilled} orders filled, ${positionsClosed} positions closed`);
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

// Paper position monitor — every 15 minutes during market hours (9:30-16:15 ET)
cron.schedule("*/15 9-16 * * 1-5", async () => {
  log("--- Monitor: checking positions + orders ---");
  try { await jobMonitorPositions(); } catch (err) { log(`ERROR monitoring: ${err}`); }
}, CRON_OPTIONS);

// ─── Startup ────────────────────────────────────────────────────────────────

log("========================================");
log("Surveillance Cron Scheduler started");
log("Schedule (ET, Mon-Fri):");
log("  09:45 — Enroll movers + morning prices");
log("  12:35 — Midday prices");
log("  16:05 — Close prices");
log("  18:00 — Evening catchup");
log("  */15  — Position monitor (9:00-16:59)");
log("========================================");

log("Running immediate catchup sync...");
runFullSync().then(() => {
  log("Startup sync complete. Waiting for scheduled jobs...");
}).catch(err => {
  log(`Startup sync error: ${err}`);
});
