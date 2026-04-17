import { getPool, mysql } from "@/lib/db";
import { fetchDailyBars } from "@/lib/data";

/**
 * Utility to sleep between API calls to avoid rate limiting
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const SYMBOL_RE = /^[A-Z0-9.\-]{1,16}$/;

// US market holidays (NYSE/NASDAQ full closures) — mirrors cron's list.
// Observation rules: holiday on Sat → observed Friday (except NY-Day
// exception). Juneteenth is a holiday since 2022.
const MARKET_HOLIDAYS = new Set([
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  // 2028
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19",
  "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
]);

// Column name allowlist to prevent SQL injection
const VALID_COLUMNS = new Set<string>();
for (let d = 1; d <= 10; d++) {
  for (const t of ["morning", "midday", "close"]) {
    VALID_COLUMNS.add(`d${d}_${t}`);
  }
}

/** Returns today's date as YYYY-MM-DD in ET timezone */
function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

/** Parse a MySQL DATE (returned as UTC-midnight Date under timezone:"Z") into
 *  a YYYY-MM-DD ET-calendar string. Uses UTC accessors so the stored
 *  calendar date is preserved (reading in ET would shift -4h = prior day). */
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

/** Add N calendar days to a YYYY-MM-DD string using ET-calendar semantics. */
function addCalendarDaysET(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(base);
}

/** Returns true if the given YYYY-MM-DD lands on Sat/Sun in ET. */
function isWeekendET(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(base);
  return dow === "Sat" || dow === "Sun";
}

/**
 * Fetches intraday prices for specific times from Yahoo Finance.
 * Uses America/New_York timezone for precise market hour targeting.
 */
export async function fetchIntradayPrice(symbol: string, dateStr: string, timeType: 'morning' | 'midday' | 'close'): Promise<number | null> {
  try {
    // 1. Calculate the query range (around the target date)
    const targetDate = new Date(`${dateStr}T12:00:00Z`);
    const start = Math.floor(targetDate.getTime() / 1000) - 86400; 
    const end = Math.floor(targetDate.getTime() / 1000) + 86400;

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=5m`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    if (!response.ok) return null;
    const data = await response.json();
    const result = data?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const prices = result?.indicators?.quote?.[0]?.close || [];

    if (timestamps.length === 0) return null;

    // 2. Define target times in ET
    let targetHour = 9, targetMin = 35;
    if (timeType === 'midday') { targetHour = 12; targetMin = 30; }
    if (timeType === 'close') { targetHour = 15; targetMin = 55; }

    let closestPrice: number | null = null;
    let minDiff = Infinity;

    // 3. Find the price point closest to our target ET time
    for (let i = 0; i < timestamps.length; i++) {
      const d = new Date(timestamps[i] * 1000);
      
      // Get the time in New York to be DST-aware
      const nyTime = d.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
      // Format: "MM/DD/YYYY, HH:mm:ss"
      const [nyDate, nyClock] = nyTime.split(", ");
      const [h, m] = nyClock.split(":").map(Number);
      
      // Check if this point is on the correct calendar day in NY
      const [targetY, targetM, targetD] = dateStr.split("-").map(Number);
      const [mNY, dNY, yNY] = nyDate.split("/").map(Number);
      
      if (yNY !== targetY || mNY !== targetM || dNY !== targetD) continue;

      const diff = Math.abs((h * 60 + m) - (targetHour * 60 + targetMin));
      if (diff < minDiff && diff <= 15) { // Must be within 15 minutes of target
        minDiff = diff;
        closestPrice = prices[i];
      }
    }

    return closestPrice;
  } catch (err) {
    console.error(`[Surveillance] Error fetching ${symbol} for ${dateStr} ${timeType}:`, err);
    return null;
  }
}
export type Mover = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  consecutiveDays?: number;
  trendDirection?: "UP" | "DOWN";
  cumulativeChangePct?: number;
  history?: { date: string; close: number; changePct: number }[];
};

/**
 * Fetches top movers and analyzes their trends without network overhead.
 */
export async function fetchAndAnalyzeMovers() {
  const [gainersResult, losersResult] = await Promise.allSettled([
    fetchMoversFromYahoo("gainers"),
    fetchMoversFromYahoo("losers"),
  ]);

  let gainers = gainersResult.status === "fulfilled" ? gainersResult.value : [];
  let losers = losersResult.status === "fulfilled" ? losersResult.value : [];

  gainers = await Promise.all(gainers.slice(0, 10).map(enhanceWithTrend));
  losers = await Promise.all(losers.slice(0, 10).map(enhanceWithTrend));

  return { gainers, losers, timestamp: new Date().toISOString() };
}

async function fetchMoversFromYahoo(type: "gainers" | "losers" | "most_actives"): Promise<Mover[]> {
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_${type}&count=25`;
  const response = await fetch(url, { headers: { "User-Agent": UA } });
  if (!response.ok) throw new Error(`Yahoo API error: ${response.status}`);
  const data = await response.json();
  const quotes = data?.finance?.result?.[0]?.quotes ?? [];
  return quotes
    .filter((q: Record<string, unknown>) => typeof q.symbol === "string" && SYMBOL_RE.test(q.symbol as string))
    .map((q: Record<string, unknown>) => ({
      symbol: q.symbol as string,
      name: (q.shortName || q.longName || q.symbol) as string,
      price: isFinite(Number(q.regularMarketPrice)) ? Number(q.regularMarketPrice) : 0,
      change: isFinite(Number(q.regularMarketChange)) ? Number(q.regularMarketChange) : 0,
      changePct: isFinite(Number(q.regularMarketChangePercent)) ? Number(q.regularMarketChangePercent) : 0,
    }));
}

async function enhanceWithTrend(mover: Mover): Promise<Mover> {
  try {
    const bars = await fetchDailyBars(mover.symbol);
    if (bars.length < 2) return mover;
    const recent = bars.slice(-5); 
    const history = [];
    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i-1];
      const curr = recent[i];
      const changePct = ((curr.close - prev.close) / prev.close) * 100;
      history.push({ date: curr.date, close: curr.close, changePct });
    }
    let consecutiveDays = 0, trendDirection: "UP" | "DOWN" | undefined, cumulativeChangePct = 0;
    const revHistory = [...history].reverse();
    for (let i = 0; i < revHistory.length; i++) {
      const day = revHistory[i], dayDirection = day.changePct > 0 ? "UP" : "DOWN";
      if (i === 0) { trendDirection = dayDirection; consecutiveDays = 1; }
      else if (dayDirection === trendDirection) consecutiveDays++;
      else break;
    }
    if (consecutiveDays > 0 && bars.length > consecutiveDays) {
      const startPrice = bars[bars.length - 1 - consecutiveDays].close;
      const endPrice = bars[bars.length - 1].close;
      if (startPrice > 0) cumulativeChangePct = ((endPrice - startPrice) / startPrice) * 100;
    }
    return { ...mover, consecutiveDays, trendDirection, cumulativeChangePct, history: history.reverse() };
  } catch { return mover; }
}

/**
 * Automatically syncs prices for all ACTIVE reversal entries.
 */
export async function syncActiveSurveillance() {
  const pool = await getPool();

  // Auto-close logic: Mark anything older than 14 days as COMPLETED
  // (10 business days ≈ 14 calendar days). Pass ET today explicitly — MySQL
  // CURRENT_DATE runs in server TZ (UTC in this deployment) which diverges
  // from ET after 20:00 ET.
  await pool.execute(
    "UPDATE reversal_entries SET status = 'COMPLETED' WHERE status = 'ACTIVE' AND cohort_date < DATE_SUB(?, INTERVAL 14 DAY)",
    [todayET()]
  );

  const [logResult] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO surveillance_logs (status) VALUES ('RUNNING')"
  );
  const logId = logResult.insertId;

  let updatedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  try {
    const [entries] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT * FROM reversal_entries WHERE status = 'ACTIVE' ORDER BY cohort_date DESC LIMIT 500"
    );

    for (const row of entries) {
      const updates: string[] = [];
      const params: (number | string)[] = [];

      // Walk trading days (skip weekends + holidays) in ET-calendar space.
      // Previous implementation mixed UTC (`new Date(mysql_date)` → UTC
      // midnight), LOCAL (`.getDay()`), and UTC again (`.toISOString()`),
      // which produced dateStr values one day ahead of what getDay reported
      // on TZ boundaries — same P0-4 bug the cron had.
      const cohortStr = mysqlDateToETStr(row.cohort_date);
      let tradingDay = 0;
      let cursor = cohortStr;
      while (tradingDay < 10) {
        cursor = addCalendarDaysET(cursor, 1);
        if (isWeekendET(cursor)) continue;
        const dateStr = cursor;
        if (MARKET_HOLIDAYS.has(dateStr)) continue;
        tradingDay++;
        const nowStr = todayET();
        if (dateStr > nowStr) break;

        for (const timeType of ['morning', 'midday', 'close'] as const) {
          const colName = `d${tradingDay}_${timeType}`;
          if (!VALID_COLUMNS.has(colName)) continue;
          if (row[colName] === null) {
            
            const [dlqRows] = await pool.execute<mysql.RowDataPacket[]>(
              "SELECT * FROM surveillance_failures WHERE entry_id = ? AND field_name = ? AND status = 'GAVE_UP'",
              [row.id, colName]
            );
            if (dlqRows.length > 0) {
              skippedCount++;
              continue;
            }

            // Rate limiting delay
            await sleep(500); 
            const price = await fetchIntradayPrice(row.symbol, dateStr, timeType);
            
            if (price != null) {
              updates.push(`${colName} = ?`);
              params.push(price);
              updatedCount++;
            } else {
              // Record in DLQ if the date is actually in the past (not today's missing data)
              if (dateStr < nowStr || (dateStr === nowStr && isTimePast(timeType))) {
                failedCount++;
                await pool.execute(
                  `INSERT INTO surveillance_failures (entry_id, symbol, field_name, error_message, last_attempt, retry_count)
                   VALUES (?, ?, ?, 'Price not found in intraday chart', CURRENT_TIMESTAMP, 1)
                   ON DUPLICATE KEY UPDATE retry_count = retry_count + 1, last_attempt = CURRENT_TIMESTAMP`,
                  [row.id, row.symbol, colName]
                );

                await pool.execute(
                  "UPDATE surveillance_failures SET status = 'GAVE_UP' WHERE entry_id = ? AND field_name = ? AND retry_count >= 5",
                  [row.id, colName]
                );
              }
            }
          }
        }
      }

      if (updates.length > 0) {
        params.push(row.id);
        await pool.execute(
          `UPDATE reversal_entries SET ${updates.join(", ")} WHERE id = ?`,
          params
        );
      }
    }

    const stats = JSON.stringify({ updated: updatedCount, failed: failedCount, skipped: skippedCount });
    await pool.execute(
      "UPDATE surveillance_logs SET finished_at = CURRENT_TIMESTAMP(6), status = 'SUCCESS', stats_json = ? WHERE id = ?",
      [stats, logId]
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await pool.execute(
      "UPDATE surveillance_logs SET finished_at = CURRENT_TIMESTAMP(6), status = 'FAILED', error_message = ? WHERE id = ?",
      [msg, logId]
    );
    throw err;
  }
}

/**
 * Checks if the target market time has actually passed in NY
 */
function isTimePast(timeType: 'morning' | 'midday' | 'close'): boolean {
  const now = new Date();
  const nyTime = now.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
  const [, nyClock] = nyTime.split(", ");
  const [h, m] = nyClock.split(":").map(Number);
  const currentTotal = h * 60 + m;

  let targetTotal = 9 * 60 + 35;
  if (timeType === 'midday') targetTotal = 12 * 60 + 30;
  if (timeType === 'close') targetTotal = 16 * 60 + 0;

  return currentTotal > targetTotal;
}
