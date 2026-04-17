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
  // Hard 8-second timeout per request — prevents hung connections from stalling batch
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal });
  } catch {
    clearTimeout(timeoutId);
    return [];
  }
  clearTimeout(timeoutId);
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
let monitorRunning = false;
let executeStrategiesRunning = false;
let executeConfirmationRunning = false;

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  console.log(`[${ts}] ${msg}`);
}

/** Returns today's date as YYYY-MM-DD in ET timezone */
function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

/**
 * Parse a MySQL DATE value into YYYY-MM-DD using ET-calendar semantics.
 * mysql2 with `timezone: "Z"` returns DATE columns as Date objects at UTC
 * midnight — using UTC accessors preserves the stored calendar date, because
 * interpreting UTC-midnight in ET would shift to the prior day (-4/-5 hours).
 */
function mysqlDateToETStr(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 10);
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v);
}

/**
 * Add `days` calendar days to a YYYY-MM-DD string using ET-calendar semantics.
 * Anchor at 12:00 UTC (= 07:00 EST / 08:00 EDT) so DST transitions never push
 * the date backward across midnight.
 */
function addCalendarDaysET(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(base);
}

/** Returns true if the given YYYY-MM-DD date string lands on Sat/Sun in ET. */
function isWeekendET(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(base);
  return dow === "Sat" || dow === "Sun";
}

/**
 * Force-close paper_signals still open against reversal_entries that the
 * 14-day auto-close just marked COMPLETED. Without this, signals on delisted
 * tickers or symbols the monitor can't price-fetch stay EXECUTED forever,
 * locking investment USD in the strategy's account in perpetuity.
 *
 * Exit price: last recorded paper_position_prices sample, falling back to
 * entry_price (flat P&L) when no price has ever been recorded. Direction-aware
 * P&L matches jobMonitorPositions. Conditional UPDATE makes this idempotent
 * with any concurrent monitor tick.
 */
async function forceCloseExpiredSignals() {
  const db = getPool();

  const [orphans] = await db.execute<mysql.RowDataPacket[]>(
    `SELECT ps.*,
            COALESCE(
              (SELECT pp.price FROM paper_position_prices pp
               WHERE pp.signal_id = ps.id ORDER BY pp.fetched_at DESC LIMIT 1),
              ps.entry_price
            ) AS last_price
     FROM paper_signals ps
     JOIN reversal_entries re ON ps.reversal_entry_id = re.id
     WHERE re.status = 'COMPLETED'
       AND ps.status = 'EXECUTED'
       AND ps.exit_at IS NULL`
  );

  if (orphans.length === 0) return;

  let closed = 0;
  for (const sig of orphans) {
    const isShort = sig.direction === "SHORT";
    const entryPrice = Number(sig.entry_price);
    const lastPrice = Number(sig.last_price);
    const leverage = Number(sig.leverage || 1);
    const investment = Number(sig.investment_usd);

    const rawPct = entryPrice > 0 ? ((lastPrice - entryPrice) / entryPrice) * 100 : 0;
    const pnlPct = isShort ? -rawPct : rawPct;
    const leveragedPct = Math.max(pnlPct * leverage, -100);
    const pnlUsd = investment * (leveragedPct / 100);

    const [upd] = await db.execute<mysql.ResultSetHeader>(
      `UPDATE paper_signals SET
         status = CASE WHEN ? > 0 THEN 'WIN' ELSE 'LOSS' END,
         exit_price = ?, exit_at = CURRENT_TIMESTAMP(6), exit_reason = 'COHORT_EXPIRED',
         pnl_usd = ?, pnl_pct = ?
       WHERE id = ? AND status = 'EXECUTED' AND exit_at IS NULL`,
      [pnlUsd, lastPrice, pnlUsd, leveragedPct, sig.id]
    );
    if (upd.affectedRows === 0) continue;

    const proceeds = investment + pnlUsd;
    if (proceeds > 0) {
      await db.execute(
        "UPDATE paper_accounts SET cash = cash + ? WHERE id = (SELECT account_id FROM paper_strategies WHERE id = ?)",
        [proceeds, sig.strategy_id]
      );
    }
    closed++;
  }

  if (closed > 0) log(`  Force-closed ${closed} orphan signal(s) from expired cohorts`);
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

    // Guard against pre-market startup runs: Yahoo's screener returns stale
    // prior-session data before market open, which would enroll with wrong
    // entry_price. Require market to be open (or past open) for today.
    const now = new Date();
    const nyClock = now.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false }).split(", ")[1];
    const [h, m] = nyClock.split(":").map(Number);
    const curMinutes = h * 60 + m;
    if (curMinutes < 9 * 60 + 45) {
      log(`  SKIP: too early (${nyClock} ET) — movers enrollment runs at 09:45 ET`);
      return;
    }

    const db = getPool();
    const today = todayET();

    // Idempotency: skip if we've already enrolled today's MOVERS cohort.
    // Filter by source so trend-scanner entries don't block morning movers enrollment.
    const [existing] = await db.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) as cnt FROM reversal_entries WHERE cohort_date = ? AND enrollment_source = 'MOVERS'",
      [today]
    );
    const existingCount = Number(existing[0]?.cnt ?? 0);
    if (existingCount > 0) {
      log(`  SKIP: already enrolled ${existingCount} MOVERS tickers for ${today}`);
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
        `INSERT INTO reversal_entries (cohort_date, symbol, direction, enrollment_source, day_change_pct, entry_price, consecutive_days, cumulative_change_pct, status)
         VALUES (?, ?, ?, 'MOVERS', ?, ?, ?, ?, 'ACTIVE')
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

    // Force-close any paper_signals still open against just-expired cohorts.
    // Delisted tickers / perpetually-failing price fetches would otherwise
    // leave cash locked in the strategy account indefinitely.
    await forceCloseExpiredSignals();

    const [entries] = await db.execute<mysql.RowDataPacket[]>(
      "SELECT * FROM reversal_entries WHERE status = 'ACTIVE' ORDER BY cohort_date DESC LIMIT 500"
    );

    // Per-sync cache of 60-day 5-min bars per symbol.
    // Dramatically reduces API calls: 1 Yahoo call per symbol covers all 30 d1-d10 slots.
    const barCache: SymbolBarCache = new Map();

    for (const row of entries) {
      // Iterate trading days (skip weekends + holidays) in ET-calendar space.
      // Previous implementation mixed UTC and local semantics: `new Date(mysql_date)`
      // parses as UTC midnight, `getDay()` used local TZ, and `toISOString()` gave
      // UTC date. In ET-container deployments this produced a dateStr 1 day ahead
      // of what getDay() reported, landing on Saturday for d1 of Friday cohorts
      // (silent Yahoo-null failure) and similar off-by-ones on other boundaries.
      const cohortStr = mysqlDateToETStr(row.cohort_date);
      let tradingDay = 0;
      let cursor = cohortStr;
      while (tradingDay < 10) {
        cursor = addCalendarDaysET(cursor, 1);
        if (isWeekendET(cursor)) continue;
        const dateStr = cursor;
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

// ─── Strategy Auto-Trader ──────────────────────────────────────────────────

/**
 * Execute all enabled trading strategies against today's newly enrolled reversal entries.
 * Runs after enrollment at 9:50 AM ET.
 *
 * For each strategy:
 *   1. Load config from paper_strategies
 *   2. Query today's reversal_entries matching config.entry criteria
 *   3. Check concurrent position cap and daily cap
 *   4. Create paper_signals as EXECUTED (auto-trade, no manual approval)
 *   5. Deduct investment from strategy's dedicated account
 */
async function jobExecuteStrategies() {
  if (executeStrategiesRunning) { log("  SKIP: execute strategies already running"); return; }
  if (!isTradingDay()) return;
  executeStrategiesRunning = true;
  try {
    await jobExecuteStrategiesImpl();
  } finally {
    executeStrategiesRunning = false;
  }
}

async function jobExecuteStrategiesImpl() {
  const db = getPool();
  const today = todayET();

  // Load all enabled TRADING strategies
  const [strategies] = await db.execute<mysql.RowDataPacket[]>(
    "SELECT s.*, a.cash FROM paper_strategies s LEFT JOIN paper_accounts a ON s.account_id = a.id WHERE s.enabled = 1 AND s.strategy_type = 'TRADING'"
  );

  if (strategies.length === 0) { log("  Strategies: none enabled"); return; }

  // Load recent ACTIVE reversal entries (last 7 trading-calendar days).
  // MOVERS cohort_date = today (enrolled 9:45 AM). TREND cohort_date = lastBar.date
  // (yesterday or older via weekends/holidays). The 7-day window acts as a
  // catch-up: if the cron was down or a strategy was disabled, pending entries
  // still enter on the next run. Dup-check on (strategy_id, reversal_entry_id)
  // below prevents any double-fire.
  const [entries] = await db.execute<mysql.RowDataPacket[]>(
    `SELECT * FROM reversal_entries
     WHERE status = 'ACTIVE'
       AND cohort_date >= DATE_SUB(?, INTERVAL 7 DAY)
       AND cohort_date <= ?
     ORDER BY cohort_date DESC`,
    [today, today]
  );

  if (entries.length === 0) { log("  Strategies: no recent active entries"); return; }

  let totalSignals = 0;

  for (const strat of strategies) {
    const config = JSON.parse(strat.config_json);
    const entry = config.entry || {};
    const sizing = config.sizing || {};
    const leverage = Number(strat.leverage || 1);
    const investmentPerTrade = Number(sizing.amount_usd || 1000);
    const maxConcurrent = Number(sizing.max_concurrent || 15);
    const maxNewPerDay = Number(sizing.max_new_per_day || 3);
    let remainingCash = Number(strat.cash || 0);

    // Count existing open positions for this strategy
    const [openCount] = await db.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) as cnt FROM paper_signals WHERE strategy_id = ? AND status = 'EXECUTED' AND exit_at IS NULL",
      [strat.id]
    );
    let currentOpen = Number(openCount[0].cnt);

    // Count signals already created today for this strategy
    const [todayCount] = await db.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) as cnt FROM paper_signals WHERE strategy_id = ? AND DATE(generated_at) = ?",
      [strat.id, today]
    );
    let todayNew = Number(todayCount[0].cnt);

    let stratSignals = 0;

    for (const e of entries) {
      // Cap checks
      if (currentOpen >= maxConcurrent) break;
      if (todayNew >= maxNewPerDay) break;
      if (remainingCash < investmentPerTrade) break;

      // Direction filter
      if (entry.direction === "LONG" && e.direction !== "LONG") continue;
      if (entry.direction === "SHORT" && e.direction !== "SHORT") continue;

      // Enrollment source filter (e.g., "MOVERS" or "TREND" or "ANY")
      if (entry.enrollment_source && entry.enrollment_source !== "ANY") {
        if (e.enrollment_source !== entry.enrollment_source) continue;
      }

      const pct = Number(e.day_change_pct);

      // Drop magnitude for LONG
      if (e.direction === "LONG") {
        if (entry.min_drop_pct != null && pct > entry.min_drop_pct) continue;
        if (entry.max_drop_pct != null && pct < entry.max_drop_pct) continue;
      }

      // Rise magnitude for SHORT
      if (e.direction === "SHORT") {
        if (entry.min_rise_pct != null && pct < entry.min_rise_pct) continue;
        if (entry.max_rise_pct != null && pct > entry.max_rise_pct) continue;
      }

      // Consecutive days filter
      if (entry.max_consecutive_days != null && e.consecutive_days != null) {
        if (Number(e.consecutive_days) > entry.max_consecutive_days) continue;
      }

      // Min price filter
      if (entry.min_price != null && Number(e.entry_price) < entry.min_price) continue;

      // Check for duplicate signal (same strategy + same reversal entry)
      const [dupCheck] = await db.execute<mysql.RowDataPacket[]>(
        "SELECT 1 FROM paper_signals WHERE strategy_id = ? AND reversal_entry_id = ?",
        [strat.id, e.id]
      );
      if (dupCheck.length > 0) continue;

      // Atomic: deduct cash FIRST (conditional on available balance), then
      // insert signal. If the cash UPDATE affects 0 rows (race with cleanup SQL
      // or concurrent deduction), rollback — signal never persists.
      const entryPrice = Number(e.entry_price);
      const conn = await db.getConnection();
      let cashExhausted = false;
      try {
        await conn.beginTransaction();
        const [cashUpdate] = await conn.execute<mysql.ResultSetHeader>(
          "UPDATE paper_accounts SET cash = cash - ? WHERE id = ? AND cash >= ?",
          [investmentPerTrade, strat.account_id, investmentPerTrade]
        );
        if (cashUpdate.affectedRows === 0) {
          cashExhausted = true;
          await conn.rollback();
        } else {
          await conn.execute(
            `INSERT INTO paper_signals
             (strategy_id, reversal_entry_id, symbol, direction, status,
              entry_price, entry_at, investment_usd, leverage, effective_exposure,
              max_price, min_price, max_pnl_pct, min_pnl_pct)
             VALUES (?, ?, ?, ?, 'EXECUTED',
                     ?, CURRENT_TIMESTAMP(6), ?, ?, ?,
                     ?, ?, 0, 0)`,
            [
              strat.id, e.id, e.symbol, e.direction,
              entryPrice, investmentPerTrade, leverage, investmentPerTrade * leverage,
              entryPrice, entryPrice,
            ]
          );
          await conn.commit();
        }
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }

      if (cashExhausted) {
        log(`    ${strat.name}: cash exhausted before filling ${e.symbol}`);
        break;
      }

      remainingCash -= investmentPerTrade;
      currentOpen++;
      todayNew++;
      stratSignals++;
      totalSignals++;
    }

    if (stratSignals > 0) {
      log(`    ${strat.name}: ${stratSignals} signals (${currentOpen} open, $${remainingCash.toFixed(0)} cash remaining)`);
    }
  }

  log(`  Strategies: ${totalSignals} total signals across ${strategies.length} strategies`);
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
  if (monitorRunning) { log("  SKIP: monitor already running"); return; }
  if (!isTradingDay()) return;
  monitorRunning = true;
  try {
    await jobMonitorPositionsImpl();
  } finally {
    monitorRunning = false;
  }
}

async function jobMonitorPositionsImpl() {
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

    const isShort = sig.direction === "SHORT";
    const entryPrice = Number(sig.entry_price);
    const leverage = Number(sig.leverage || 1);

    // Raw price move % (positive = price went up)
    const rawPricePct = entryPrice > 0 ? ((price - entryPrice) / entryPrice) * 100 : 0;
    // Direction-aware PnL: LONG profits when price goes up, SHORT profits when price goes down
    const pnlPct = isShort ? -rawPricePct : rawPricePct;
    const leveragedPnl = pnlPct * leverage;

    // Update max/min watermarks (track actual price extremes)
    const maxPrice = Math.max(Number(sig.max_price || 0), price);
    const minPrice = sig.min_price ? Math.min(Number(sig.min_price), price) : price;
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

    // Hard stop (pnlPct is direction-aware: negative = losing)
    if (exits.hard_stop_pct != null && pnlPct <= exits.hard_stop_pct) {
      exitReason = "HARD_STOP";
    }

    // Leverage liquidation
    if (leverage > 1 && leveragedPnl <= -90) {
      exitReason = "LIQUIDATED";
    }

    // Take profit (pnlPct is direction-aware: positive = winning)
    if (exits.take_profit_pct != null && pnlPct >= exits.take_profit_pct) {
      exitReason = "TAKE_PROFIT";
    }

    // Trailing stop — direction-aware
    if (exits.trailing_stop_pct != null) {
      const activateAt = exits.trailing_activates_at_profit_pct ?? 0;
      let trailActive = sig.trailing_active === 1;
      let trailStop = sig.trailing_stop_price ? Number(sig.trailing_stop_price) : null;

      if (!trailActive && pnlPct >= activateAt) {
        trailActive = true;
        // LONG: trail below price; SHORT: trail above price
        trailStop = isShort
          ? price * (1 + exits.trailing_stop_pct / 100)
          : price * (1 - exits.trailing_stop_pct / 100);
      }
      if (trailActive) {
        if (isShort) {
          // SHORT: best price is the lowest (minPrice); trail stop goes above it
          const newStop = minPrice * (1 + exits.trailing_stop_pct / 100);
          if (trailStop == null || newStop < trailStop) trailStop = newStop;
          if (price >= trailStop) exitReason = "TRAIL_STOP";
        } else {
          // LONG: best price is the highest (maxPrice); trail stop goes below it
          const newStop = maxPrice * (1 - exits.trailing_stop_pct / 100);
          if (trailStop == null || newStop > trailStop) trailStop = newStop;
          if (price <= trailStop) exitReason = "TRAIL_STOP";
        }
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
      // Direction-aware final PnL
      const finalPnlPct = isShort ? -rawPricePct : rawPricePct;
      const leveragedPctFinal = Math.max(finalPnlPct * leverage, -100);
      const pnlUsd = investment * (leveragedPctFinal / 100);
      const holdMinutes = sig.entry_at
        ? Math.round((Date.now() - new Date(sig.entry_at).getTime()) / 60000)
        : null;

      // Conditional UPDATE — only exits a signal still in EXECUTED state.
      // Prevents double cash credit if a concurrent monitor tick already exited this row.
      const [exitUpdate] = await db.execute<mysql.ResultSetHeader>(
        `UPDATE paper_signals SET
           status = CASE WHEN ? > 0 THEN 'WIN' ELSE 'LOSS' END,
           exit_price = ?, exit_at = CURRENT_TIMESTAMP(6), exit_reason = ?,
           pnl_usd = ?, pnl_pct = ?, holding_minutes = ?
         WHERE id = ? AND status = 'EXECUTED' AND exit_at IS NULL`,
        [pnlUsd, price, exitReason, pnlUsd, leveragedPctFinal, holdMinutes, sig.id]
      );

      if (exitUpdate.affectedRows === 0) {
        // Already exited by another process; do NOT credit cash a second time.
        continue;
      }

      // Return cash to strategy account
      const proceeds = investment + pnlUsd;
      if (proceeds > 0) {
        await db.execute(
          "UPDATE paper_accounts SET cash = cash + ? WHERE id = (SELECT account_id FROM paper_strategies WHERE id = ?)",
          [proceeds, sig.strategy_id]
        );
      }

      positionsClosed++;
      const dir = isShort ? "SHORT" : "LONG";
      log(`    EXIT ${dir} ${sig.symbol} [${exitReason}] P&L: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} (${leveragedPctFinal.toFixed(1)}%)`);
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

// ─── Confirmation Strategy Engine ─────────────────────────────────────────

/**
 * Execute CONFIRMATION strategies — these wait for d1/d2 price confirmation
 * before entering a trade. Runs after close sync so d1/d2 prices are available.
 *
 * For each enabled CONFIRMATION strategy:
 *   1. Load config (includes confirmation_days, d1/d2 filters)
 *   2. Query reversal_entries from N days ago with d1/d2 close prices filled
 *   3. Check confirmation conditions against actual price data
 *   4. Enter at the latest close price (d1 or d2 close depending on strategy)
 */
async function jobExecuteConfirmationStrategies() {
  if (executeConfirmationRunning) { log("  SKIP: execute confirmation already running"); return; }
  if (!isTradingDay()) return;
  executeConfirmationRunning = true;
  try {
    await jobExecuteConfirmationStrategiesImpl();
  } finally {
    executeConfirmationRunning = false;
  }
}

async function jobExecuteConfirmationStrategiesImpl() {
  const db = getPool();
  const today = todayET();

  const [strategies] = await db.execute<mysql.RowDataPacket[]>(
    "SELECT s.*, a.cash FROM paper_strategies s LEFT JOIN paper_accounts a ON s.account_id = a.id WHERE s.enabled = 1 AND s.strategy_type = 'CONFIRMATION'"
  );

  if (strategies.length === 0) { log("  Confirmation strategies: none enabled"); return; }

  // Load recent entries (enrolled 1-5 trading days ago) with at least d1 close
  const [entries] = await db.execute<mysql.RowDataPacket[]>(
    `SELECT * FROM reversal_entries
     WHERE status = 'ACTIVE'
       AND cohort_date >= DATE_SUB(?, INTERVAL 8 DAY)
       AND cohort_date < ?
       AND d1_close IS NOT NULL
     ORDER BY cohort_date DESC`,
    [today, today]
  );

  if (entries.length === 0) { log("  Confirmation strategies: no recent entries with d1 data"); return; }

  let totalSignals = 0;

  for (const strat of strategies) {
    const config = JSON.parse(strat.config_json);
    const entry = config.entry || {};
    const sizing = config.sizing || {};
    const leverage = Number(strat.leverage || 1);
    const investmentPerTrade = Number(sizing.amount_usd || 100);
    const maxConcurrent = Number(sizing.max_concurrent || 10);
    const maxNewPerDay = Number(sizing.max_new_per_day || 5);
    let remainingCash = Number(strat.cash || 0);
    const confirmDays = Number(entry.confirmation_days || 2);

    const [openCount] = await db.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) as cnt FROM paper_signals WHERE strategy_id = ? AND status = 'EXECUTED' AND exit_at IS NULL",
      [strat.id]
    );
    let currentOpen = Number(openCount[0].cnt);

    const [todayCount] = await db.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) as cnt FROM paper_signals WHERE strategy_id = ? AND DATE(generated_at) = ?",
      [strat.id, today]
    );
    let todayNew = Number(todayCount[0].cnt);

    let stratSignals = 0;

    for (const e of entries) {
      if (currentOpen >= maxConcurrent) break;
      if (todayNew >= maxNewPerDay) break;
      if (remainingCash < investmentPerTrade) break;

      const ep = Number(e.entry_price);
      const d1Close = e.d1_close != null ? Number(e.d1_close) : null;
      const d2Close = e.d2_close != null ? Number(e.d2_close) : null;
      const pct = Number(e.day_change_pct);

      // Must have required confirmation days of data
      if (confirmDays >= 1 && d1Close == null) continue;
      if (confirmDays >= 2 && d2Close == null) continue;

      // Direction filter
      if (entry.direction === "LONG" && e.direction !== "LONG") continue;
      if (entry.direction === "SHORT" && e.direction !== "SHORT") continue;

      // Enrollment source filter
      if (entry.enrollment_source && entry.enrollment_source !== "ANY") {
        if (e.enrollment_source !== entry.enrollment_source) continue;
      }

      // Consecutive days filter (for trend strategies)
      if (entry.min_consecutive_days != null) {
        if (e.consecutive_days == null || Number(e.consecutive_days) < entry.min_consecutive_days) continue;
      }
      if (entry.max_consecutive_days != null) {
        if (e.consecutive_days == null || Number(e.consecutive_days) > entry.max_consecutive_days) continue;
      }

      // Magnitude filters (same as regular strategies)
      if (e.direction === "LONG") {
        if (entry.min_drop_pct != null && pct > entry.min_drop_pct) continue;
        if (entry.max_drop_pct != null && pct < entry.max_drop_pct) continue;
      }
      if (e.direction === "SHORT") {
        if (entry.min_rise_pct != null && pct < entry.min_rise_pct) continue;
        if (entry.max_rise_pct != null && pct > entry.max_rise_pct) continue;
      }

      // Min price filter
      if (entry.min_price != null && ep < entry.min_price) continue;

      // ─── Confirmation checks ─────────────────────────────────────
      const d1Ret = d1Close != null ? ((d1Close - ep) / ep) * 100 : null;
      const d2Ret = d2Close != null && d1Close != null ? ((d2Close - d1Close) / d1Close) * 100 : null;

      // "favorable" = direction the strategy profits from
      // LONG profits when price goes UP; SHORT profits when price goes DOWN
      const d1Favorable = e.direction === "LONG" ? (d1Ret != null && d1Ret > 0) : (d1Ret != null && d1Ret < 0);
      const d2Favorable = e.direction === "LONG" ? (d2Ret != null && d2Ret > 0) : (d2Ret != null && d2Ret < 0);
      const d1Unfavorable = e.direction === "LONG" ? (d1Ret != null && d1Ret <= 0) : (d1Ret != null && d1Ret >= 0);
      const d2Unfavorable = e.direction === "LONG" ? (d2Ret != null && d2Ret <= 0) : (d2Ret != null && d2Ret >= 0);

      if (entry.d1_must_be_favorable && !d1Favorable) continue;
      if (entry.d1_must_be_unfavorable && !d1Unfavorable) continue;
      if (entry.d2_must_be_favorable && !d2Favorable) continue;
      if (entry.d2_must_be_unfavorable && !d2Unfavorable) continue;

      // Minimum d1 bounce magnitude
      if (entry.min_d1_move_pct != null && d1Ret != null) {
        if (Math.abs(d1Ret) < entry.min_d1_move_pct) continue;
      }

      // ─── Determine entry price ───────────────────────────────────
      // Enter at the latest confirmation day's close price
      const entryPrice = confirmDays >= 2 && d2Close != null ? d2Close : d1Close!;

      // Duplicate check
      const [dupCheck] = await db.execute<mysql.RowDataPacket[]>(
        "SELECT 1 FROM paper_signals WHERE strategy_id = ? AND reversal_entry_id = ?",
        [strat.id, e.id]
      );
      if (dupCheck.length > 0) continue;

      // Atomic: deduct cash FIRST (conditional), then insert signal.
      // If cash UPDATE affects 0 rows, rollback — signal never persists.
      const conn = await db.getConnection();
      let cashExhausted = false;
      try {
        await conn.beginTransaction();
        const [cashUpdate] = await conn.execute<mysql.ResultSetHeader>(
          "UPDATE paper_accounts SET cash = cash - ? WHERE id = ? AND cash >= ?",
          [investmentPerTrade, strat.account_id, investmentPerTrade]
        );
        if (cashUpdate.affectedRows === 0) {
          cashExhausted = true;
          await conn.rollback();
        } else {
          await conn.execute(
            `INSERT INTO paper_signals
             (strategy_id, reversal_entry_id, symbol, direction, status,
              entry_price, entry_at, investment_usd, leverage, effective_exposure,
              max_price, min_price, max_pnl_pct, min_pnl_pct)
             VALUES (?, ?, ?, ?, 'EXECUTED',
                     ?, CURRENT_TIMESTAMP(6), ?, ?, ?,
                     ?, ?, 0, 0)`,
            [
              strat.id, e.id, e.symbol, e.direction,
              entryPrice, investmentPerTrade, leverage, investmentPerTrade * leverage,
              entryPrice, entryPrice,
            ]
          );
          await conn.commit();
        }
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }

      if (cashExhausted) {
        log(`    ${strat.name}: cash exhausted before filling ${e.symbol}`);
        break;
      }

      log(`    ${strat.name}: ENTER ${e.direction} ${e.symbol} @ $${entryPrice.toFixed(2)} ($${investmentPerTrade} × ${leverage}x)`);

      remainingCash -= investmentPerTrade;
      currentOpen++;
      todayNew++;
      stratSignals++;
      totalSignals++;
    }

    if (stratSignals > 0) {
      log(`    ${strat.name}: ${stratSignals} new signals (${currentOpen} total open, $${remainingCash.toFixed(0)} cash remaining)`);
    }
  }

  log(`  Confirmation strategies: ${totalSignals} total signals across ${strategies.length} strategies`);
}

// ─── Trend Scanner ─────────────────────────────────────────────────────────

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import * as path from "path";

// Load universe once at startup — ~500 liquid US stocks for trend scanning
const UNIVERSE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "trend-universe.json");
let TREND_UNIVERSE: string[] = [];
try {
  const data = JSON.parse(readFileSync(UNIVERSE_PATH, "utf-8"));
  TREND_UNIVERSE = Array.isArray(data.symbols) ? data.symbols : [];
  log(`Trend universe loaded: ${TREND_UNIVERSE.length} symbols from ${UNIVERSE_PATH}`);
} catch (err) {
  log(`WARNING: Could not load trend universe (${UNIVERSE_PATH}): ${err}. Trend scanner will be disabled.`);
}

let trendScanRunning = false;

/**
 * Scan the trend universe for stocks with ≥3 consecutive same-direction days.
 * Enrolls qualifying stocks into reversal_entries with enrollment_source='TREND'.
 *
 * DOWN streaks → LONG direction (expect bounce up)
 * UP streaks → SHORT direction (expect fade down)
 *
 * Runs after market close when today's daily close is available.
 */
async function jobScanTrends() {
  if (trendScanRunning) { log("  SKIP: trend scan already running"); return; }
  if (!isTradingDay()) { log("  SKIP: trend scan — not a trading day"); return; }
  if (TREND_UNIVERSE.length === 0) { log("  SKIP: trend universe empty"); return; }

  // Guard: daily bars from Yahoo include a partial bar during market hours.
  // Skip ONLY during active trading (9:30-16:05 ET). Pre-market (before 9:30)
  // and post-close (after 16:05) are safe — Yahoo's last daily bar is the
  // previous trading day's finalized close.
  const now = new Date();
  const nyClock = now.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false }).split(", ")[1];
  const [h, m] = nyClock.split(":").map(Number);
  const curMinutes = h * 60 + m;
  const marketOpen = 9 * 60 + 30;
  const marketCloseBuffer = 16 * 60 + 5;
  if (curMinutes >= marketOpen && curMinutes < marketCloseBuffer) {
    log(`  SKIP: trend scan — market is open (${nyClock} ET). Will run at scheduled 16:15 ET.`);
    return;
  }

  trendScanRunning = true;
  const db = getPool();
  const today = todayET();

  // Tunable thresholds
  const MIN_STREAK_DAYS = 3;
  const MIN_CUMULATIVE_MOVE_PCT = 3;
  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 400;

  log(`Trend scan: checking ${TREND_UNIVERSE.length} symbols for ≥${MIN_STREAK_DAYS}d streaks...`);

  try {
    // Prefetch recent enrollments. We check the last 2 calendar days because the
    // scan's cohort_date = lastBar.date, which can be today (post-close) OR the
    // previous trading day (if scan runs pre-market). Over-scanning is safe
    // (INSERT's UNIQUE constraint prevents duplicates); under-filtering just
    // wastes API calls.
    const [existingRows] = await db.execute<mysql.RowDataPacket[]>(
      "SELECT DISTINCT symbol FROM reversal_entries WHERE cohort_date >= DATE_SUB(?, INTERVAL 2 DAY)",
      [today]
    );
    const alreadyEnrolled = new Set(existingRows.map(r => r.symbol as string));

    const candidates = TREND_UNIVERSE.filter(s => !alreadyEnrolled.has(s));
    log(`  ${alreadyEnrolled.size} already enrolled in last 2 days, scanning ${candidates.length} candidates`);

    let enrolled = 0, scanned = 0, failed = 0;
    const examples: string[] = [];

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);

      const results = await Promise.all(batch.map(async (symbol) => {
        try {
          const bars = await fetchDailyBars(symbol);
          if (bars.length < MIN_STREAK_DAYS + 1) return null;

          // Compute day-over-day returns from last 7 bars
          const recent = bars.slice(-7);
          const returns: number[] = [];
          for (let j = 1; j < recent.length; j++) {
            returns.push((recent[j].close - recent[j - 1].close) / recent[j - 1].close);
          }
          if (returns.length < MIN_STREAK_DAYS) return null;

          // Walk backward from the end, count consecutive same-direction days.
          // Flat days (exactly 0 return) break the streak — don't silently extend it.
          let consecutiveDays = 0;
          let streakDir: "UP" | "DOWN" | null = null;
          for (let j = returns.length - 1; j >= 0; j--) {
            if (returns[j] === 0) break; // flat day breaks the streak
            const dir = returns[j] > 0 ? "UP" : "DOWN";
            if (streakDir == null) { streakDir = dir; consecutiveDays = 1; }
            else if (dir === streakDir) { consecutiveDays++; }
            else break;
          }
          if (consecutiveDays < MIN_STREAK_DAYS || streakDir == null) return null;

          // Compute cumulative change over the streak
          const startIdx = recent.length - 1 - consecutiveDays;
          const startPrice = recent[Math.max(0, startIdx)].close;
          const lastBar = recent[recent.length - 1];
          const endPrice = lastBar.close;
          const cumulativeChangePct = ((endPrice - startPrice) / startPrice) * 100;
          if (Math.abs(cumulativeChangePct) < MIN_CUMULATIVE_MOVE_PCT) return null;

          const direction = streakDir === "UP" ? "SHORT" : "LONG";
          const dayChangePct = returns[returns.length - 1] * 100;
          const entryPrice = endPrice;
          // Use the date of the last bar (NOT today). If the scan runs before today's
          // bar is available (startup pre-market), cohortDate will be the prior
          // trading day — which keeps entry_price aligned with d1/d2 indexing.
          const cohortDate = lastBar.date;

          return { symbol, direction, dayChangePct, entryPrice, consecutiveDays, cumulativeChangePct, streakDir, cohortDate };
        } catch {
          return null;
        }
      }));

      for (const r of results) {
        scanned++;
        if (r == null) continue;

        try {
          await db.execute(
            `INSERT INTO reversal_entries
             (cohort_date, symbol, direction, enrollment_source, day_change_pct, entry_price, consecutive_days, cumulative_change_pct, status)
             VALUES (?, ?, ?, 'TREND', ?, ?, ?, ?, 'ACTIVE')`,
            [r.cohortDate, r.symbol, r.direction, r.dayChangePct, r.entryPrice, r.consecutiveDays, r.cumulativeChangePct]
          );
          enrolled++;
          if (examples.length < 10) {
            examples.push(`    TREND ${r.direction} ${r.symbol} ${r.consecutiveDays}d ${r.streakDir} cohort=${r.cohortDate} entry=$${r.entryPrice.toFixed(2)} (cum ${r.cumulativeChangePct.toFixed(1)}%)`);
          }
        } catch (err) {
          // Likely unique constraint conflict — another enrollment beat us
          failed++;
          if (failed <= 3) log(`    Insert failed ${r.symbol}: ${err}`);
        }
      }

      if (i + BATCH_SIZE < candidates.length) await sleep(BATCH_DELAY_MS);
    }

    for (const e of examples) log(e);
    log(`  Trend scan done: ${enrolled} enrolled (${failed} insert errors), ${scanned} scanned`);
  } finally {
    trendScanRunning = false;
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

cron.schedule("50 9 * * 1-5", async () => {
  log("=== STRATEGIES: Auto-trade ===");
  try { await jobExecuteStrategies(); } catch (err) { log(`ERROR executing strategies: ${err}`); }
}, CRON_OPTIONS);

cron.schedule("35 12 * * 1-5", async () => {
  log("=== MIDDAY: Sync prices ===");
  try { await jobSyncPrices(); } catch (err) { log(`ERROR midday sync: ${err}`); }
}, CRON_OPTIONS);

cron.schedule("5 16 * * 1-5", async () => {
  log("=== CLOSE: Sync prices ===");
  try { await jobSyncPrices(); } catch (err) { log(`ERROR close sync: ${err}`); }
}, CRON_OPTIONS);

cron.schedule("15 16 * * 1-5", async () => {
  log("=== TREND SCAN: Scanning universe for multi-day streaks ===");
  try { await jobScanTrends(); } catch (err) { log(`ERROR trend scan: ${err}`); }
}, CRON_OPTIONS);

cron.schedule("30 16 * * 1-5", async () => {
  log("=== CONFIRMATION: Execute confirmation strategies ===");
  try { await jobExecuteConfirmationStrategies(); } catch (err) { log(`ERROR confirmation strategies: ${err}`); }
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
log("  09:50 — Execute trading strategies");
log("  12:35 — Midday prices");
log("  16:05 — Close prices");
log("  16:15 — Trend scanner (detect 3+ day streaks)");
log("  16:30 — Execute confirmation strategies");
log("  18:00 — Evening catchup");
log("  */15  — Position monitor (9:00-16:59)");
log("========================================");

log("Running immediate catchup sync...");
runFullSync().then(async () => {
  log("Startup sync complete.");
  try {
    await jobExecuteStrategies();
  } catch (err) {
    log(`Startup strategy error: ${err}`);
  }
  try {
    await jobScanTrends();
  } catch (err) {
    log(`Startup trend scan error: ${err}`);
  }
  try {
    await jobExecuteConfirmationStrategies();
  } catch (err) {
    log(`Startup confirmation strategy error: ${err}`);
  }
  log("Waiting for scheduled jobs...");
}).catch(err => {
  log(`Startup sync error: ${err}`);
});
