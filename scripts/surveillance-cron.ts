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
import { ensureAppBootstrapReady } from "../src/lib/bootstrap";
import { fillOrder as sharedFillOrder, recordEquitySnapshotSafe } from "../src/lib/paper-fill";
import {
  evaluateExitsAlways as sharedEvaluateExitsAlways,
  applyExitDecisionToTrade as sharedApplyExitToTrade,
  type ExitInputs,
  type ExitReason,
} from "../src/lib/paper-exits";
import { isRTH } from "../src/lib/paper";

// ─── Config ─────────────────────────────────────────────────────────────────

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

function parseDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) return null;
  const parsed = new URL(value);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace("/", ""),
  };
}

function requiredEnv(...names: string[]): string {
  const val = env(...names);
  if (!val) throw new Error(`Missing required env var: ${names.join(" or ")}`);
  return val;
}

const fromUrl = parseDatabaseUrl();

const DB_CONFIG: mysql.PoolOptions = {
  host: fromUrl?.host ?? requiredEnv("MYSQL_HOST", "MYSQLHOST"),
  port: fromUrl?.port ?? Number(requiredEnv("MYSQL_PORT", "MYSQLPORT")),
  user: fromUrl?.user ?? requiredEnv("MYSQL_USER", "MYSQLUSER"),
  password: fromUrl?.password ?? requiredEnv("MYSQL_PASSWORD", "MYSQLPASSWORD"),
  database: fromUrl?.database ?? requiredEnv("MYSQL_DB", "MYSQLDATABASE"),
  waitForConnections: true,
  connectionLimit: 5,
  timezone: "Z",
};

const RATE_LIMIT_MS = Number(process.env.RATE_LIMIT_MS ?? 500);
/**
 * How many days of paper_position_prices history to keep. Grows at roughly
 * (open_positions × 26 ticks/day) rows/day; at 80 open positions that is
 * ~2k rows/day, so 30d ≈ 60k rows — small, fast self-join.
 * Tune via PRICE_RETENTION_DAYS env var.
 */
const PRICE_RETENTION_DAYS = Number(process.env.PRICE_RETENTION_DAYS ?? 30);

let pool: mysql.Pool | null = null;
function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Yahoo Finance API ──────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const SYMBOL_RE = /^[A-Z0-9.\-]{1,16}$/;

/** Default per-request timeout. A hung connection on any upstream wedges
 *  the containing job and (via *Running guards) stops the entire pipeline,
 *  so every external fetch must be bounded. */
const FETCH_TIMEOUT_MS = 8000;

/**
 * fetch() with a hard AbortController timeout. Returns null on network
 * failure, non-2xx response, or timeout — callers uniformly guard on null.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

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
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA } });
  if (!res) throw new Error(`Yahoo movers API failed or timed out (type=${type})`);
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
    // 60-day payloads can be ~4700 bars; allow extra budget vs default.
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA } }, 15000);
    if (!res) return null;
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
    // Must call fetch directly here — we need access to status=429 before the
    // ok-check. fetchWithTimeout would null-on-non-2xx and we'd lose the
    // quota-exhausted signal. Apply AbortController inline.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch {
      clearTimeout(timeoutId);
      return null;
    }
    clearTimeout(timeoutId);
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

/**
 * Prune paper_position_prices older than PRICE_RETENTION_DAYS.
 * Without this the table grows unbounded (~2k rows/trading day at current
 * open-position count), and the MAX/GROUP BY self-join in /api/strategies
 * degrades superlinearly. 30-day default keeps only what charts need.
 *
 * Runs nightly at 03:00 ET — outside market hours, never races the monitor.
 */
async function jobPruneOldPrices() {
  const db = getPool();
  const [res] = await db.execute<mysql.ResultSetHeader>(
    "DELETE FROM paper_position_prices WHERE fetched_at < DATE_SUB(NOW(), INTERVAL ? DAY)",
    [PRICE_RETENTION_DAYS]
  );
  log(`  Pruned ${res.affectedRows} paper_position_prices rows older than ${PRICE_RETENTION_DAYS} days`);
}

// US market holidays (NYSE/NASDAQ full closures) — REVIEW BY 2028-10-01.
// Observation rules: holiday on Sat → observed Friday (except NY Day exception),
// holiday on Sun → observed Monday. Juneteenth is an NYSE holiday since 2022.
const MARKET_HOLIDAYS = new Set([
  // 2026
  "2026-01-01", // New Year's Day (Thu)
  "2026-01-19", // MLK Day (Mon)
  "2026-02-16", // Presidents Day (Mon)
  "2026-04-03", // Good Friday (Fri) — Easter 2026 = Apr 5
  "2026-05-25", // Memorial Day (Mon)
  "2026-06-19", // Juneteenth (Fri)
  "2026-07-03", // Independence Day observed — Jul 4 is Sat
  "2026-09-07", // Labor Day (Mon)
  "2026-11-26", // Thanksgiving (Thu)
  "2026-12-25", // Christmas (Fri)
  // 2027
  "2027-01-01", // New Year's Day (Fri)
  "2027-01-18", // MLK Day (Mon)
  "2027-02-15", // Presidents Day (Mon)
  "2027-03-26", // Good Friday (Fri) — Easter 2027 = Mar 28 (previous entry 2027-04-16 was 2028's date)
  "2027-05-31", // Memorial Day (Mon)
  "2027-06-18", // Juneteenth observed — Jun 19 is Sat
  "2027-07-05", // Independence Day observed — Jul 4 is Sun
  "2027-09-06", // Labor Day (Mon)
  "2027-11-25", // Thanksgiving (Thu)
  "2027-12-24", // Christmas observed — Dec 25 is Sat
  // 2028
  "2028-01-17", // MLK Day (Mon) — Jan 1 is Sat; NYSE exception: no preceding-Friday observation for NY Day
  "2028-02-21", // Presidents Day (Mon)
  "2028-04-14", // Good Friday (Fri) — Easter 2028 = Apr 16
  "2028-05-29", // Memorial Day (Mon)
  "2028-06-19", // Juneteenth (Mon)
  "2028-07-04", // Independence Day (Tue)
  "2028-09-04", // Labor Day (Mon)
  "2028-11-23", // Thanksgiving (Thu)
  "2028-12-25", // Christmas (Mon)
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

    // Guard: enrollment runs AFTER close so `day_change_pct` reflects the
    // full open-to-close move (not overnight + first 15 min). Yahoo's
    // screener at 16:05+ ET returns end-of-day top gainers/losers with
    // regularMarketPrice = close and regularMarketChangePercent = full day.
    // Before close, the screener is mid-session and ranks stocks by
    // partial-day move — polluted signal we're trying to avoid.
    const now = new Date();
    const nyClock = now.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false }).split(", ")[1];
    const [h, m] = nyClock.split(":").map(Number);
    const curMinutes = h * 60 + m;
    if (curMinutes < 16 * 60) {
      log(`  SKIP: too early (${nyClock} ET) — post-close movers enrollment runs at 16:05 ET`);
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

    // Auto-close entries older than 14 calendar days.
    // Use explicit ET-today parameter — MySQL's CURRENT_DATE evaluates in the
    // server session TZ (UTC in this deployment), which diverges from ET
    // after 20:00 ET. Passing todayET() decouples the comparison from server
    // TZ drift.
    await db.execute(
      "UPDATE reversal_entries SET status = 'COMPLETED' WHERE status = 'ACTIVE' AND cohort_date < DATE_SUB(?, INTERVAL 14 DAY)",
      [todayET()]
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
      // DATE(generated_at) evaluates the stored UTC TIMESTAMP in server TZ
      // (UTC). CONVERT_TZ shifts to ET so "signals generated today in ET" is
      // what we actually count — robust against post-20:00 ET writes.
      "SELECT COUNT(*) as cnt FROM paper_signals WHERE strategy_id = ? AND DATE(CONVERT_TZ(generated_at, '+00:00', 'America/New_York')) = ?",
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
      // If the INSERT violates UNIQUE KEY (errno 1062 — concurrent executor
      // beat us to it despite the dup-check above), rollback auto-refunds
      // cash and we skip this candidate rather than halt the loop.
      const entryPrice = Number(e.entry_price);
      const conn = await db.getConnection();
      let cashExhausted = false;
      let dupeKey = false;
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
        if ((err as { errno?: number }).errno === 1062) {
          dupeKey = true;
        } else {
          throw err;
        }
      } finally {
        conn.release();
      }

      if (dupeKey) {
        log(`    ${strat.name}: SKIP ${e.symbol} — signal already exists (UX_signal_strat_entry race)`);
        continue;
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
        const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA } });
        if (!res) return;
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

  // Pre-fetch every distinct strategy config referenced by an open signal in
  // a single query, instead of 1 SELECT per signal inside the loop. Configs
  // don't change within a tick.
  const stratIdsArr = Array.from(new Set(openSignals.map(s => Number(s.strategy_id))));
  const stratConfigById = new Map<number, { config_json: string; leverage: number }>();
  if (stratIdsArr.length > 0) {
    const placeholders = stratIdsArr.map(() => "?").join(",");
    const [stratRows] = await db.execute<mysql.RowDataPacket[]>(
      `SELECT id, config_json, leverage FROM paper_strategies WHERE id IN (${placeholders})`,
      stratIdsArr
    );
    for (const r of stratRows) {
      stratConfigById.set(Number(r.id), { config_json: String(r.config_json), leverage: Number(r.leverage) });
    }
  }

  // Collect price-point rows and flush in a single multi-row INSERT after the
  // loop. Previously a per-signal INSERT ran inside the loop, producing one
  // round-trip per signal per tick (~80 trips on today's portfolio).
  const priceInserts: Array<[number, number]> = [];

  // 5. Record prices + update watermarks for open signals.
  //
  // W3: exit-evaluation logic was extracted into `src/lib/paper-exits.ts` so
  // the SAME algorithm drives both paper_signals (strategy engine, this loop)
  // and paper_trades (new `monitorPaperTrades` hook below). Strategy `exits`
  // config is translated into the shared `ExitInputs` struct — hard_stop_pct
  // + take_profit_pct are percentages relative to the entry price so we
  // compute absolute bracket prices up-front (same formula used by
  // `insertOpenTrade` for user-placed brackets). time_exit_days uses signals'
  // trading-days semantics (weekend compression); we keep that here rather
  // than in the shared module because it's signal-specific.
  //
  // Exit-reason strings: the shared module emits TRAILING_STOP / TIME_EXIT
  // but paper_signals historically used TRAIL_STOP / TIME. Translate back at
  // write time so the paper_signals.exit_reason column keeps its historical
  // values for analytics continuity.
  for (const sig of openSignals) {
    const price = prices[sig.symbol];
    if (price == null) continue;

    priceInserts.push([Number(sig.id), price]);
    pricesRecorded++;

    const isShort = sig.direction === "SHORT";
    const side: "LONG" | "SHORT" = isShort ? "SHORT" : "LONG";
    const entryPrice = Number(sig.entry_price);
    const leverage = Number(sig.leverage || 1);

    // Build ExitInputs from signal row + strategy config.
    const stratInfo = stratConfigById.get(Number(sig.strategy_id));
    const exits = stratInfo ? (JSON.parse(stratInfo.config_json).exits || {}) : {};

    // Pct → absolute price. `hard_stop_pct` is typically NEGATIVE (e.g. -5),
    // `take_profit_pct` typically POSITIVE (e.g. 10). Formula:
    //   LONG:  stop = entry * (1 + pct/100)   (pct negative → price drops)
    //   SHORT: stop = entry * (1 - pct/100)   (pct negative → price rises)
    const stopLossPrice = exits.hard_stop_pct != null && entryPrice > 0
      ? (isShort ? entryPrice * (1 - exits.hard_stop_pct / 100) : entryPrice * (1 + exits.hard_stop_pct / 100))
      : null;
    const takeProfitPrice = exits.take_profit_pct != null && entryPrice > 0
      ? (isShort ? entryPrice * (1 - exits.take_profit_pct / 100) : entryPrice * (1 + exits.take_profit_pct / 100))
      : null;

    // Translate time_exit_days (trading days) into an absolute date. Same
    // weekend-compression formula the original cron used — trading_days =
    // floor(calendar_days * 5/7) crossing the threshold means we're due.
    let timeExitDate: string | null = null;
    if (exits.time_exit_days != null && sig.entry_at) {
      const entryMs = new Date(sig.entry_at).getTime();
      // Find the minimum calendar_days such that floor(cal*5/7) >= time_exit_days.
      // cal = ceil(time_exit_days * 7 / 5). Add to entry_date to get target date.
      const targetCalDays = Math.ceil(exits.time_exit_days * 7 / 5);
      const targetMs = entryMs + targetCalDays * 86_400_000;
      timeExitDate = new Date(targetMs).toISOString().slice(0, 10);
    }

    const input: ExitInputs = {
      entryPrice,
      side,
      leverage,
      stopLossPrice,
      takeProfitPrice,
      trailingStopPct: exits.trailing_stop_pct != null ? Number(exits.trailing_stop_pct) : null,
      trailingActivatesAtProfitPct: exits.trailing_activates_at_profit_pct != null ? Number(exits.trailing_activates_at_profit_pct) : 0,
      trailingStopPrice: sig.trailing_stop_price != null ? Number(sig.trailing_stop_price) : null,
      trailingActive: Number(sig.trailing_active) === 1,
      timeExitDate,
      maxPnlPct: sig.max_pnl_pct != null ? Number(sig.max_pnl_pct) : null,
      minPnlPct: sig.min_pnl_pct != null ? Number(sig.min_pnl_pct) : null,
      maxPrice: sig.max_price != null ? Number(sig.max_price) : null,
      minPrice: sig.min_price != null ? Number(sig.min_price) : null,
    };

    const result = sharedEvaluateExitsAlways(input, price, new Date());

    // Always persist updated watermarks + trailing state. If no exit fires,
    // these are the only changes; if an exit DOES fire, they're baked into
    // the exit UPDATE below so the historical watermark isn't lost.
    await db.execute(
      `UPDATE paper_signals
          SET max_price = ?, min_price = ?, max_pnl_pct = ?, min_pnl_pct = ?,
              trailing_active = ?, trailing_stop_price = ?
        WHERE id = ?`,
      [
        result.watermarks.maxPrice,
        result.watermarks.minPrice,
        result.watermarks.maxPnlPct,
        result.watermarks.minPnlPct,
        result.watermarks.trailingActive ? 1 : 0,
        result.watermarks.trailingStopPrice,
        sig.id,
      ]
    );

    if (result.reason != null) {
      // Translate shared reasons → paper_signals historical strings.
      const legacyReason =
        result.reason === "TRAILING_STOP" ? "TRAIL_STOP"
        : result.reason === "TIME_EXIT"   ? "TIME"
        : result.reason;

      const investment = Number(sig.investment_usd);
      // Recompute final pnl at the close price (same math as before —
      // direction-aware, leveraged, clamped at -100%).
      const rawPricePct = entryPrice > 0 ? ((price - entryPrice) / entryPrice) * 100 : 0;
      const finalPnlPct = isShort ? -rawPricePct : rawPricePct;
      const leveragedPctFinal = Math.max(finalPnlPct * leverage, -100);
      const pnlUsd = investment * (leveragedPctFinal / 100);
      const holdMinutes = sig.entry_at
        ? Math.round((Date.now() - new Date(sig.entry_at).getTime()) / 60000)
        : null;

      // Conditional UPDATE — only exits a signal still in EXECUTED state.
      const [exitUpdate] = await db.execute<mysql.ResultSetHeader>(
        `UPDATE paper_signals SET
           status = CASE WHEN ? > 0 THEN 'WIN' ELSE 'LOSS' END,
           exit_price = ?, exit_at = CURRENT_TIMESTAMP(6), exit_reason = ?,
           pnl_usd = ?, pnl_pct = ?, holding_minutes = ?
         WHERE id = ? AND status = 'EXECUTED' AND exit_at IS NULL`,
        [pnlUsd, price, legacyReason, pnlUsd, leveragedPctFinal, holdMinutes, sig.id]
      );

      if (exitUpdate.affectedRows === 0) continue;

      const proceeds = investment + pnlUsd;
      if (proceeds > 0) {
        await db.execute(
          "UPDATE paper_accounts SET cash = cash + ? WHERE id = (SELECT account_id FROM paper_strategies WHERE id = ?)",
          [proceeds, sig.strategy_id]
        );
      }

      positionsClosed++;
      const dir = isShort ? "SHORT" : "LONG";
      log(`    EXIT ${dir} ${sig.symbol} [${legacyReason}] P&L: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} (${leveragedPctFinal.toFixed(1)}%)`);
    }
  }

  // Flush all price points in one multi-row INSERT — uses .query() (not
  // .execute()) because mysql2 prepared statements don't accept the VALUES ?
  // nested-array shape.
  if (priceInserts.length > 0) {
    await db.query("INSERT INTO paper_position_prices (signal_id, price) VALUES ?", [priceInserts]);
  }

  // 6. Fill triggered pending orders (limit/stop) via the shared
  //    `fillOrder` in `src/lib/paper-fill.ts`. Both the UI path and this
  //    cron call into the same transactional routine so there's one
  //    implementation of atomic cash moves / status-guarded transitions.
  for (const order of pendingOrders) {
    const price = prices[order.symbol];
    if (price == null) continue;

    const limit = order.limit_price ? Number(order.limit_price) : null;
    const stop = order.stop_price ? Number(order.stop_price) : null;
    const side = order.side as string;
    const type = order.order_type as string;

    let shouldFill = false;
    if (type === "MARKET") shouldFill = true; // cron runs during RTH; if it didn't, there's no live price above
    else if (type === "LIMIT" && limit != null) {
      shouldFill = side === "BUY" ? price <= limit : price >= limit;
    } else if (type === "STOP" && stop != null) {
      shouldFill = side === "BUY" ? price >= stop : price <= stop;
    }

    if (!shouldFill) continue;

    // Cron-path fill. strategyId is DELIBERATELY NOT passed here — codex F2.
    // These `pendingOrders` rows come from `paper_orders`, which is the user's
    // UI-queued LIMIT/STOP book. The strategy engine writes to `paper_signals`
    // (different table, different cash flow, handled above this block). So
    // cron-generated trades from this call will store `paper_trades.strategy_id
    // = NULL` — same as manual MARKET BUYs from the UI. That's CORRECT, not
    // a bug: these orders have no strategy attribution by construction.
    // When W3+ introduces strategy-emits-an-order (e.g. to route a signal
    // through the same limit-fill machinery), add `paper_orders.strategy_id`
    // and pass `{ strategyId: order.strategy_id }` here.
    const result = await sharedFillOrder(db, Number(order.id), price, {
      fillRationale: "SPOT",
    });
    if (result.filled) {
      ordersFilled++;
      log(`    FILL ${order.symbol} ${type} ${side} at $${price.toFixed(2)}`);
    } else {
      log(`    SKIP ${order.symbol} ${type} ${side}: ${result.rejection}`);
    }
  }

  log(`  Monitor: ${pricesRecorded} prices recorded, ${ordersFilled} orders filled, ${positionsClosed} positions closed`);
}

// ─── Paper Trades Monitor (W3) ────────────────────────────────────────────

/**
 * W3 — monitor user-placed `paper_trades` (NOT `paper_signals`) and close any
 * that hit their protective exit bracket. Runs every 15 min during RTH
 * alongside the existing `jobMonitorPositions`.
 *
 * Uses the SAME shared `paper-exits.ts` module as the signal-monitor loop
 * above, so hard-stop / take-profit / trailing / time-exit semantics are
 * identical across both tables. The adapter below maps the paper_trades row
 * shape into `ExitInputs` and calls `applyExitDecisionToTrade` to close.
 *
 * Differences from the signals path:
 *   - Brackets are stored ON THE TRADE ROW (stop_loss_price absolute, etc.)
 *     rather than derived from a strategy config. No per-tick pct→price math.
 *   - time_exit_date is an absolute DATE column; no trading-days compression.
 *   - Direction-aware arithmetic is the same: LONG profits on rise, SHORT on fall.
 */
let monitorPaperTradesRunning = false;
async function jobMonitorPaperTrades() {
  if (monitorPaperTradesRunning) { log("  SKIP: paper-trades monitor already running"); return; }
  if (!isTradingDay()) return;
  // C1 — gate outside regular trading hours. `isTradingDay()` only rules out
  // weekends; the monitor ticks every 15 min and would otherwise fire at
  // pre-market / after-hours when Yahoo feeds stale quotes. Match the
  // behaviour of MARKET order acceptance (`paper.ts:isRTH`).
  if (!isRTH(new Date())) { log("  SKIP: paper-trades monitor outside RTH"); return; }
  monitorPaperTradesRunning = true;
  try {
    await jobMonitorPaperTradesImpl();
  } finally {
    monitorPaperTradesRunning = false;
  }
}

async function jobMonitorPaperTradesImpl() {
  const db = getPool();

  // Scan only OPEN trades that have ANY bracket field set. If all four are
  // NULL there's no way an exit triggers, so skip. The index
  // IX_paper_trades_status_timeexit is still useful for the time-exit prefix
  // scan; full bracket eligibility is evaluated in-memory after the scan.
  const [openTrades] = await db.execute<mysql.RowDataPacket[]>(
    `SELECT * FROM paper_trades
      WHERE status = 'OPEN'
        AND (stop_loss_price IS NOT NULL
             OR take_profit_price IS NOT NULL
             OR trailing_stop_pct IS NOT NULL
             OR time_exit_date IS NOT NULL)`
  );

  if (openTrades.length === 0) {
    log("  Paper-trades monitor: 0 positions with brackets — nothing to do");
    return;
  }

  // Fetch live prices (batched).
  const prices: Record<string, number> = {};
  const symbols = Array.from(new Set(openTrades.map(t => t.symbol)));
  for (let i = 0; i < symbols.length; i += 5) {
    const batch = symbols.slice(i, i + 5);
    await Promise.all(batch.map(async (sym) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m`;
        const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA } });
        if (!res) return;
        const data = await res.json();
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (typeof price === "number" && isFinite(price) && price > 0) {
          prices[sym] = price;
        }
      } catch { /* skip */ }
    }));
    if (i + 5 < symbols.length) await sleep(300);
  }

  let closed = 0;
  const now = new Date();

  for (const trade of openTrades) {
    const price = prices[trade.symbol];
    if (price == null) continue;

    const entryPrice = Number(trade.buy_price);
    const side: "LONG" | "SHORT" = trade.side === "SHORT" ? "SHORT" : "LONG";

    // Hotfix (Bug #12 — 2026-04-21, revised 2026-04-21 for SHORT): derive
    // max/min PRICE watermarks from the persisted max_pnl_pct / min_pnl_pct
    // percentages so the trailing-stop ratchet holds across ticks.
    // paper_trades has no `max_price` column.
    //
    // The EVALUATOR (paper-exits.ts:169-189) reads LONG trailing from
    // `maxPrice` (highest observed price) and SHORT trailing from `minPrice`
    // (lowest observed price). So the SLOT the derived price lands in is
    // side-aware — not just the derivation formula.
    //
    //   LONG:  best-pnl (max_pnl_pct)  = highest-price → maxPrice slot
    //          worst-pnl (min_pnl_pct) = lowest-price  → minPrice slot
    //   SHORT: best-pnl (max_pnl_pct)  = lowest-price  → minPrice slot
    //          worst-pnl (min_pnl_pct) = highest-price → maxPrice slot
    //
    // Previous hotfix mapped max_pnl_pct→maxPrice for BOTH sides. The SHORT
    // best-pnl (a LOW price) correctly landed in the maxPrice slot but the
    // evaluator ignores maxPrice for SHORT — it uses minPrice, which got
    // derived from min_pnl_pct (a HIGH squeeze price). Result: SHORT trailing
    // ratcheted from the squeeze peak instead of the historical low.
    const maxPnlPctPersisted = trade.max_pnl_pct != null ? Number(trade.max_pnl_pct) : null;
    const minPnlPctPersisted = trade.min_pnl_pct != null ? Number(trade.min_pnl_pct) : null;
    let maxPriceDerived: number | null = null;
    let minPriceDerived: number | null = null;
    if (side === "SHORT") {
      // SHORT best (max_pnl_pct) → lowest observed price → minPrice slot.
      // cur = entry * (1 - pnl/100). pnl=+10 ⇒ cur = entry*0.90 (low).
      if (maxPnlPctPersisted !== null && Number.isFinite(maxPnlPctPersisted) && entryPrice > 0) {
        minPriceDerived = entryPrice * (1 - maxPnlPctPersisted / 100);
      }
      // SHORT worst (min_pnl_pct) → highest observed price → maxPrice slot.
      // pnl=-3 ⇒ cur = entry*1.03 (high).
      if (minPnlPctPersisted !== null && Number.isFinite(minPnlPctPersisted) && entryPrice > 0) {
        maxPriceDerived = entryPrice * (1 - minPnlPctPersisted / 100);
      }
    } else {
      // LONG best (max_pnl_pct) → highest observed price → maxPrice slot.
      if (maxPnlPctPersisted !== null && Number.isFinite(maxPnlPctPersisted) && entryPrice > 0) {
        maxPriceDerived = entryPrice * (1 + maxPnlPctPersisted / 100);
      }
      // LONG worst (min_pnl_pct) → lowest observed price → minPrice slot.
      if (minPnlPctPersisted !== null && Number.isFinite(minPnlPctPersisted) && entryPrice > 0) {
        minPriceDerived = entryPrice * (1 + minPnlPctPersisted / 100);
      }
    }

    // Direction-aware PnL % for watermark tracking. Computed inside the
    // shared module too, but we also need it to decide trailing activation.
    // The shared module handles that internally.
    const input: ExitInputs = {
      entryPrice,
      side,
      leverage: 1,
      stopLossPrice: trade.stop_loss_price != null ? Number(trade.stop_loss_price) : null,
      takeProfitPrice: trade.take_profit_price != null ? Number(trade.take_profit_price) : null,
      trailingStopPct: trade.trailing_stop_pct != null ? Number(trade.trailing_stop_pct) : null,
      trailingActivatesAtProfitPct: trade.trailing_activates_at_profit_pct != null ? Number(trade.trailing_activates_at_profit_pct) : 0,
      trailingStopPrice: trade.trailing_stop_price != null ? Number(trade.trailing_stop_price) : null,
      trailingActive: Number(trade.trailing_active) === 1,
      timeExitDate: trade.time_exit_date
        ? (trade.time_exit_date instanceof Date
            ? trade.time_exit_date.toISOString().slice(0, 10)
            : String(trade.time_exit_date).slice(0, 10))
        : null,
      maxPnlPct: maxPnlPctPersisted,
      minPnlPct: minPnlPctPersisted,
      maxPrice: maxPriceDerived,
      minPrice: minPriceDerived,
    };

    const result = sharedEvaluateExitsAlways(input, price, now);

    // Persist watermarks (same as signals path). Write even when no exit
    // fires so trailing_active / trailing_stop_price advance between ticks.
    await db.execute(
      `UPDATE paper_trades
          SET max_pnl_pct = ?, min_pnl_pct = ?,
              trailing_active = ?, trailing_stop_price = ?
        WHERE id = ? AND status = 'OPEN'`,
      [
        result.watermarks.maxPnlPct,
        result.watermarks.minPnlPct,
        result.watermarks.trailingActive ? 1 : 0,
        result.watermarks.trailingStopPrice,
        trade.id,
      ]
    );

    if (result.reason != null) {
      const applied = await sharedApplyExitToTrade(db, Number(trade.id), price, {
        reason: result.reason,
        closePrice: price,
        watermarks: result.watermarks,
      });
      if (applied.closed) {
        closed++;
        log(`    EXIT_TRADE ${side} ${trade.symbol} [${result.reason}] P&L: ${applied.pnlUsd >= 0 ? '+' : ''}$${applied.pnlUsd.toFixed(2)}`);
      }
    }
  }

  log(`  Paper-trades monitor: ${closed} positions closed`);
}

// Silence unused ExitReason import without removing the type (it's part of
// the contract with paper-exits.ts even if this module doesn't name it).
void (null as unknown as ExitReason | null);

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
      // DATE(generated_at) evaluates the stored UTC TIMESTAMP in server TZ
      // (UTC). CONVERT_TZ shifts to ET so "signals generated today in ET" is
      // what we actually count — robust against post-20:00 ET writes.
      "SELECT COUNT(*) as cnt FROM paper_signals WHERE strategy_id = ? AND DATE(CONVERT_TZ(generated_at, '+00:00', 'America/New_York')) = ?",
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

      // Atomic: deduct cash FIRST (conditional), then insert signal. If
      // cash UPDATE affects 0 rows, rollback — signal never persists. If
      // INSERT hits UX_signal_strat_entry (errno 1062), rollback refunds
      // cash and we skip this candidate.
      const conn = await db.getConnection();
      let cashExhausted = false;
      let dupeKey = false;
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
        if ((err as { errno?: number }).errno === 1062) {
          dupeKey = true;
        } else {
          throw err;
        }
      } finally {
        conn.release();
      }

      if (dupeKey) {
        log(`    ${strat.name}: SKIP ${e.symbol} — signal already exists (UX_signal_strat_entry race)`);
        continue;
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
import * as path from "path";

// Load universe once at startup — ~500 liquid US stocks for trend scanning.
// Fail LOUDLY on read/parse error so deployment bugs (file not copied, JSON
// malformed) surface as container crashes rather than a silently disabled
// scanner. An intentionally-empty `{ "symbols": [] }` is allowed.
//
// Resolve relative to process.cwd() (set by Dockerfile WORKDIR) rather than
// import.meta.url — tsx's `import.meta.url` behavior can change across
// versions depending on how it transforms the module URL; cwd is stable.
// `UNIVERSE_PATH` env var overrides for local dev / alternate layouts.
const UNIVERSE_PATH = process.env.UNIVERSE_PATH ?? path.join(process.cwd(), "scripts", "trend-universe.json");
let TREND_UNIVERSE: string[] = [];
try {
  const raw = readFileSync(UNIVERSE_PATH, "utf-8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data?.symbols)) {
    throw new Error(`trend-universe.json: "symbols" must be an array`);
  }
  TREND_UNIVERSE = data.symbols.filter((s: unknown): s is string => typeof s === "string" && SYMBOL_RE.test(s));
  log(`Trend universe loaded: ${TREND_UNIVERSE.length} symbols from ${UNIVERSE_PATH}`);
  if (TREND_UNIVERSE.length === 0) {
    log(`NOTE: trend-universe.json contains 0 valid symbols — trend scanner will no-op by design.`);
  }
} catch (err) {
  console.error(`FATAL: Failed to load trend universe at ${UNIVERSE_PATH}: ${err instanceof Error ? err.message : err}`);
  console.error(`       This indicates a deployment bug (file not copied into container, or malformed JSON).`);
  console.error(`       Exiting(1) so the container restart policy surfaces the failure.`);
  process.exit(1);
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

  // Guard: Yahoo's daily bar is in-progress during market hours AND briefly
  // after close. Earlier window was 9:30-16:05 which missed the 16:05-16:14
  // bar-finalization tail — startup catchup in that window could ingest a
  // partial "today" bar, enroll on a streak detected from in-progress data,
  // then flip direction after the real close finalizes. Widen to 16:15 ET
  // to match the scheduled scan time. Pre-market (before 9:30) remains safe
  // because Yahoo's latest daily bar there is yesterday's finalized close.
  const now = new Date();
  const nyClock = now.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false }).split(", ")[1];
  const [h, m] = nyClock.split(":").map(Number);
  const curMinutes = h * 60 + m;
  const marketOpen = 9 * 60 + 30;
  const barFinalizedAfter = 16 * 60 + 15;
  if (curMinutes >= marketOpen && curMinutes < barFinalizedAfter) {
    log(`  SKIP: trend scan — today's daily bar not finalized (${nyClock} ET). Will run at scheduled 16:15 ET.`);
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

// ─── Hourly equity snapshot ─────────────────────────────────────────────────

/**
 * Take a paper_equity_snapshots row for every non-dormant paper account
 * once per hour during RTH. "Non-dormant" = has at least one OPEN trade OR
 * cash changed since the last snapshot (skipped: fully-closed idle accounts
 * that would just write duplicate rows forever).
 *
 * This is the IDLE-time path — the fill-time path (see paper-fill.ts) writes
 * a snapshot on every cash-moving fill so we always have a data point for
 * every transaction. The hourly tick adds coverage for long positions with
 * no trading activity so a chart doesn't have gaps.
 */
async function jobHourlyEquitySnapshots() {
  const db = getPool();
  const [accounts] = await db.execute<mysql.RowDataPacket[]>(
    `SELECT a.id
       FROM paper_accounts a
       LEFT JOIN paper_trades t ON t.account_id = a.id AND t.status = 'OPEN'
      GROUP BY a.id
     HAVING COUNT(t.id) > 0
         OR EXISTS (
           SELECT 1 FROM paper_equity_snapshots s
            WHERE s.account_id = a.id
              AND s.snapshot_at > DATE_SUB(NOW(), INTERVAL 2 DAY)
         )`
  );
  let written = 0;
  for (const acct of accounts) {
    // Safe variant: catches + logs per-account errors so one bad account
    // (missing row, schema skew) can't poison the whole hourly batch.
    const ok = await recordEquitySnapshotSafe(db, Number(acct.id));
    if (ok) written++;
  }
  log(`  Hourly snapshots: wrote ${written} rows across ${accounts.length} non-dormant accounts`);
}

/**
 * W4 — borrow-cost accrual for OPEN SHORT positions.
 *
 * For every `OPEN SHORT` with `borrow_daily_rate_pct > 0`, debit accrued
 * interest since the last accrual. Runs once per weekday at 17:00 ET
 * (post-close); skips weekends.
 *
 * Daily charge = quantity × buy_price × (borrow_daily_rate_pct / 100) / 365.
 * `borrow_daily_rate_pct` is persisted as an ANNUALIZED % (e.g. 2.5 = 2.5%
 * APR). Dividing by 365 gets the per-day dollar cost on the short's notional.
 *
 * CODEX ROUND-2 FIXES (2026-04-21):
 *   - Bug #3 — race with concurrent cover. Each short is processed in its
 *     own per-trade transaction that locks account + trade FOR UPDATE and
 *     re-checks status='OPEN' under the lock, skipping cleanly if the
 *     position was covered between snapshot-SELECT and per-trade tx.
 *   - Bug #4 — idempotency via `paper_trades.last_borrow_accrued_date`.
 *     `days_to_accrue = DATEDIFF(target_date, last_date)` where `last_date`
 *     is `last_borrow_accrued_date` if set, else `buy_date`. Re-running
 *     the same day → 0 days → no-op.
 *   - Bug #5 — calendar-day accrual, NOT business-day. Monday's run after
 *     Friday's run charges 3 days (Sat+Sun+Mon) via MySQL DATEDIFF.
 *   - Bug #6 — partial-day accrual on cover is NOT implemented (documented
 *     MVP limitation). Positions covered intraday before the day's 17:00
 *     run miss that final day's borrow. Acceptable precision; daily is OK.
 *
 * Logged in `surveillance_logs` with status='SUCCESS' (or PARTIAL on errors).
 * Each per-position debit is its own transaction so one bad row cannot
 * poison the batch.
 */
export async function jobAccrueBorrowCost() {
  const db = getPool();
  const targetDate = new Date().toISOString().slice(0, 10);
  const [shorts] = await db.execute<mysql.RowDataPacket[]>(
    `SELECT t.id, t.account_id
       FROM paper_trades t
      WHERE t.status = 'OPEN'
        AND t.side = 'SHORT'
        AND COALESCE(t.borrow_daily_rate_pct, 0) > 0`
  );
  let debited = 0;
  let skipped = 0;
  let errors = 0;
  let totalUsd = 0;
  for (const row of shorts) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      // LOCK STEP 1 — account (canonical order).
      const [acct] = await conn.execute<mysql.RowDataPacket[]>(
        "SELECT id FROM paper_accounts WHERE id = ? FOR UPDATE",
        [row.account_id]
      );
      if (acct.length === 0) { await conn.rollback(); skipped++; continue; }

      // LOCK STEP 2 — trade. Re-check status under lock; race-safe against
      // a concurrent cover that committed between snapshot and this tx.
      const [tradeRows] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT status, quantity, closed_quantity, buy_price,
                borrow_daily_rate_pct, buy_date, last_borrow_accrued_date
           FROM paper_trades WHERE id = ? FOR UPDATE`,
        [row.id]
      );
      if (tradeRows.length === 0) { await conn.rollback(); skipped++; continue; }
      const t = tradeRows[0];
      if (t.status !== "OPEN") { await conn.rollback(); skipped++; continue; }

      // Calendar-day accrual via MySQL DATEDIFF (weekends included).
      const lastDateRaw = t.last_borrow_accrued_date ?? t.buy_date;
      const [[dd]] = await conn.execute<mysql.RowDataPacket[]>(
        "SELECT DATEDIFF(?, ?) AS days",
        [targetDate, lastDateRaw]
      ) as unknown as [mysql.RowDataPacket[], unknown];
      const daysToAccrue = Math.max(0, Number(dd.days ?? 0));
      if (daysToAccrue <= 0) { await conn.rollback(); skipped++; continue; }

      const qty = Math.max(0, Number(t.quantity) - Number(t.closed_quantity ?? 0));
      const entryPrice = Number(t.buy_price);
      const annualPct = Number(t.borrow_daily_rate_pct);
      const daily = qty * entryPrice * (annualPct / 100) / 365;
      if (!(daily > 0)) { await conn.rollback(); skipped++; continue; }
      const accrual = daily * daysToAccrue;

      const [debitRes] = await conn.execute<mysql.ResultSetHeader>(
        "UPDATE paper_accounts SET cash = cash - ? WHERE id = ? AND cash >= ?",
        [accrual, row.account_id, accrual]
      );
      if (debitRes.affectedRows !== 1) { await conn.rollback(); errors++; continue; }

      const [markRes] = await conn.execute<mysql.ResultSetHeader>(
        "UPDATE paper_trades SET last_borrow_accrued_date = ? WHERE id = ? AND status = 'OPEN'",
        [targetDate, row.id]
      );
      if (markRes.affectedRows !== 1) { await conn.rollback(); errors++; continue; }

      await conn.commit();
      debited++;
      totalUsd += accrual;
    } catch (err) {
      try { await conn.rollback(); } catch { /* ignore */ }
      errors++;
      log(`  borrow accrual error trade=${row.id}: ${err}`);
    } finally {
      conn.release();
    }
  }
  await db.execute(
    `INSERT INTO surveillance_logs (status, stats_json, finished_at)
     VALUES (?, ?, CURRENT_TIMESTAMP(6))`,
    [
      errors > 0 ? "PARTIAL" : "SUCCESS",
      JSON.stringify({ job: "borrow_accrual", open_shorts: shorts.length, debited, skipped, errors, total_usd: totalUsd }),
    ]
  );
  log(`  Borrow accrual: ${debited}/${shorts.length} shorts debited (skipped ${skipped}), total $${totalUsd.toFixed(4)}, errors=${errors}`);
}

// ─── Schedule ───────────────────────────────────────────────────────────────

/**
 * Morning sync — runs at 09:45 ET. Fetches overnight price updates for
 * yesterday's (and earlier) cohorts. Does NOT enroll new movers — enrollment
 * was moved to post-close (16:05 ET) so day_change_pct reflects full-day
 * movement rather than overnight gap + first 15 min.
 */
async function runMorningSync() {
  try {
    await jobSyncPrices();
  } catch (err) {
    log(`ERROR syncing prices: ${err}`);
  }
}

/**
 * Close sync + enrollment — runs at 16:05 ET. First fills d_close for
 * existing active cohorts, then enrolls today's top movers based on
 * full-day close move.
 */
async function runCloseSync() {
  try {
    await jobSyncPrices();
  } catch (err) {
    log(`ERROR syncing close prices: ${err}`);
  }
  try {
    await jobEnrollMovers();
  } catch (err) {
    log(`ERROR enrolling movers (post-close): ${err}`);
  }
}

const CRON_OPTIONS = { timezone: "America/New_York" };

cron.schedule("45 9 * * 1-5", async () => {
  log("=== MORNING: Sync prior-cohort morning prices (no enrollment) ===");
  try { await runMorningSync(); } catch (err) { log(`ERROR morning sync: ${err}`); }
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
  log("=== CLOSE: Sync d_close + enroll today's post-close movers ===");
  try { await runCloseSync(); } catch (err) { log(`ERROR close sync: ${err}`); }
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

// W3 — paper_trades monitor (user-placed positions with exit brackets).
// Runs 7 minutes offset from the signals monitor to avoid a thundering-herd
// on Yahoo. Same 15-min cadence, same RTH gate.
cron.schedule("7/15 9-16 * * 1-5", async () => {
  log("--- Paper-trades monitor: checking bracketed positions ---");
  try { await jobMonitorPaperTrades(); } catch (err) { log(`ERROR paper-trades monitor: ${err}`); }
}, CRON_OPTIONS);

// Hourly equity snapshot — at :07 to avoid stepping on the :00 / :15 ticks.
// Covers idle hours (positions held with no fills) so the equity curve has
// no gaps. Runs 9-16 ET, Mon-Fri — no point snapshotting at 03:00 ET.
cron.schedule("7 9-16 * * 1-5", async () => {
  log("--- Hourly equity snapshot ---");
  try { await jobHourlyEquitySnapshots(); } catch (err) { log(`ERROR hourly snapshot: ${err}`); }
}, CRON_OPTIONS);

// Retention — daily at 03:00 ET (well outside market + job windows)
cron.schedule("0 3 * * *", async () => {
  log("=== RETENTION: Prune old paper_position_prices ===");
  try { await jobPruneOldPrices(); } catch (err) { log(`ERROR pruning: ${err}`); }
}, CRON_OPTIONS);

// W4 — Borrow cost accrual. Weekdays 17:00 ET (post-close). Debits one day
// of interest per OPEN SHORT with a non-zero borrow rate.
cron.schedule("0 17 * * 1-5", async () => {
  log("=== BORROW ACCRUAL: Debit daily interest on OPEN SHORTs ===");
  try { await jobAccrueBorrowCost(); } catch (err) { log(`ERROR borrow accrual: ${err}`); }
}, CRON_OPTIONS);

// ─── Startup ────────────────────────────────────────────────────────────────

async function main() {
  await ensureAppBootstrapReady();

  log("========================================");
  log("Surveillance Cron Scheduler started");
  log("Schedule (ET, Mon-Fri):");
  log("  09:45 — Morning price sync (d_morning) — no enrollment");
  log("  09:50 — Execute trading strategies (trades yesterday's close cohort)");
  log("  12:35 — Midday prices (d_midday)");
  log("  16:05 — Close prices (d_close) + ENROLL today's post-close movers");
  log("  16:15 — Trend scanner (detect 3+ day streaks)");
  log("  16:30 — Execute confirmation strategies");
  log("  18:00 — Evening catchup sync");
  log("  */15  — Position monitor (9:00-16:59)");
  log(`  03:00 — Retention prune (>${PRICE_RETENTION_DAYS}d paper_position_prices, daily)`);
  log("========================================");

  // Startup catchup: prior-cohort price sync only. Never enroll on startup —
  // enrollment only via the scheduled 16:05 ET tick (or will be picked up
  // the next trading day if container restarts after close).
  log("Running immediate catchup sync (no enrollment)...");
  try {
    await runMorningSync();
    log("Startup sync complete.");
  } catch (err) {
    log(`Startup sync error: ${err}`);
  }

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
}

main().catch((err) => {
  console.error(`FATAL: scheduler bootstrap failed: ${err instanceof Error ? err.stack ?? err.message : err}`);
  process.exit(1);
});
