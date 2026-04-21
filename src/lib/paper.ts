import { getPool, mysql } from "@/lib/db";
import { fillOrder } from "@/lib/paper-fill";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const SYMBOL_RE = /^[A-Z0-9.\-]{1,16}$/;

/**
 * Live-price quote from Yahoo — price plus the timestamp the quote was
 * valid at and whether we consider it "live" (fresh during regular market
 * hours). The caller uses `isLive` to decide whether to accept a MARKET
 * order at this price (reject if stale), and `asOf` to surface staleness
 * in the UI so a user never trades on a 6-hour-old number thinking it's
 * real-time.
 */
export type LivePrice = {
  price: number;
  asOf: Date;
  isLive: boolean;
  regularMarketTime: number; // Unix seconds
};

/**
 * Weekday (Mon-Fri) 09:30–16:00 US/Eastern check. Holidays NOT honored —
 * that's deferred; a holiday-open day will simply show data as stale.
 * Good enough as a gate for MARKET order acceptance without pulling a
 * holiday calendar into the build.
 */
export function isRTH(d: Date): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(d);
  const wd = parts.find(p => p.type === "weekday")?.value ?? "";
  const hh = Number(parts.find(p => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find(p => p.type === "minute")?.value ?? "0");
  if (wd === "Sat" || wd === "Sun") return false;
  const minutes = hh * 60 + mm;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/**
 * Fetch the current (or most recent) market price for a symbol from Yahoo
 * Finance. Returns a full `LivePrice` including the quote's `asOf` timestamp
 * and an `isLive` flag. Returns null on any transport/parse error or if the
 * quote is non-finite / ≤ 0. This is the single boundary where price validity
 * is enforced — downstream code can assume `price > 0 && isFinite`.
 */
export async function fetchLivePrice(symbol: string): Promise<LivePrice | null> {
  if (!SYMBOL_RE.test(symbol)) return null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price !== "number" || !isFinite(price) || price <= 0) return null;
    const regularMarketTime = Number(meta?.regularMarketTime ?? 0);
    const asOf = regularMarketTime > 0 ? new Date(regularMarketTime * 1000) : new Date();
    const now = new Date();
    // "Live" = quote is fresh (< 60s old) AND we're in regular trading hours.
    // Outside RTH, Yahoo still serves a price, but it's the last-close, which
    // MARKET orders must NOT be allowed to consume as if it's executable.
    const isLive = (now.getTime() - asOf.getTime()) < 60_000 && isRTH(now);
    return { price, asOf, isLive, regularMarketTime };
  } catch {
    return null;
  }
}

/**
 * Legacy shim: returns just the price number. Use `fetchLivePrice` for new
 * code that cares about staleness. Kept so existing call sites that only
 * need a mark-to-market number don't all need to change today.
 */
export async function fetchLivePriceNum(symbol: string): Promise<number | null> {
  const q = await fetchLivePrice(symbol);
  return q?.price ?? null;
}

/** Fetch live prices for a batch of symbols. Deduplicates. Limits concurrency to 5. */
export async function fetchLivePrices(symbols: string[]): Promise<Record<string, LivePrice>> {
  const unique = Array.from(new Set(symbols.filter(s => SYMBOL_RE.test(s))));
  const out: Record<string, LivePrice> = {};
  for (let i = 0; i < unique.length; i += 5) {
    const batch = unique.slice(i, i + 5);
    await Promise.all(
      batch.map(async (s) => {
        const q = await fetchLivePrice(s);
        if (q != null) out[s] = q;
      })
    );
  }
  return out;
}

export type PaperAccount = {
  id: number;
  name: string;
  initial_cash: number;
  cash: number;
  reserved_cash: number;
  created_at: string;
};

/** Fetch the default paper account, creating it if missing. */
export async function getDefaultAccount(): Promise<PaperAccount> {
  const pool = await getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM paper_accounts WHERE name = 'Default' LIMIT 1"
  );
  if (rows.length > 0) {
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      initial_cash: Number(r.initial_cash),
      cash: Number(r.cash),
      reserved_cash: Number(r.reserved_cash ?? 0),
      created_at: r.created_at,
    };
  }
  await pool.execute(
    "INSERT INTO paper_accounts (name, initial_cash, cash) VALUES ('Default', 100000, 100000)"
  );
  const [created] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM paper_accounts WHERE name = 'Default' LIMIT 1"
  );
  if (created.length === 0) throw new Error("Failed to create default paper account");
  const r = created[0];
  return {
    id: r.id,
    name: r.name,
    initial_cash: Number(r.initial_cash),
    cash: Number(r.cash),
    reserved_cash: Number(r.reserved_cash ?? 0),
    created_at: r.created_at,
  };
}

export type PositionMark = {
  symbol: string;
  markPrice: number;
  asOf: Date | null;
  isLive: boolean;
};

/**
 * Compute account equity = cash + mark-to-market value of open positions.
 * Uses live prices from Yahoo. Falls back to `buy_price` ONLY when a live
 * quote fails, and surfaces `stale_positions` so callers (UI) can show the
 * user that the KPI isn't fully live.
 */
export async function computeAccountEquity(accountId: number): Promise<{
  cash: number;
  reserved_cash: number;
  positions_value: number;
  equity: number;
  open_positions: number;
  stale_positions: number;
  marks: Record<string, PositionMark>;
}> {
  const pool = await getPool();
  const [accounts] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT cash, reserved_cash FROM paper_accounts WHERE id = ?",
    [accountId]
  );
  const cash = accounts.length > 0 ? Number(accounts[0].cash) : 0;
  const reservedCash = accounts.length > 0 ? Number(accounts[0].reserved_cash ?? 0) : 0;

  const [positions] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT symbol, quantity, buy_price, investment_usd FROM paper_trades WHERE account_id = ? AND status = 'OPEN'",
    [accountId]
  );

  if (positions.length === 0) {
    return {
      cash,
      reserved_cash: reservedCash,
      positions_value: 0,
      equity: cash + reservedCash,
      open_positions: 0,
      stale_positions: 0,
      marks: {},
    };
  }

  const prices = await fetchLivePrices(positions.map(p => p.symbol));
  let positions_value = 0;
  let stale = 0;
  const marks: Record<string, PositionMark> = {};
  for (const p of positions) {
    const live = prices[p.symbol];
    const buyPrice = Number(p.buy_price);
    const qty = Number(p.quantity) || Number(p.investment_usd) / buyPrice;
    const markPrice = live?.price ?? buyPrice;
    positions_value += qty * markPrice;
    if (!live) stale++;
    // Per-symbol mark record; last-write-wins if a position has duplicate
    // symbols, which is intentional — they share the same quote.
    marks[p.symbol] = {
      symbol: p.symbol,
      markPrice,
      asOf: live?.asOf ?? null,
      isLive: live?.isLive ?? false,
    };
  }

  // Equity includes reserved cash because it's still the account's money —
  // it's just locked against a PENDING order. Not including it would show
  // a misleadingly low "equity" the instant a user places a LIMIT BUY.
  return {
    cash,
    reserved_cash: reservedCash,
    positions_value,
    equity: cash + reservedCash + positions_value,
    open_positions: positions.length,
    stale_positions: stale,
    marks,
  };
}

/**
 * Check pending limit/stop orders and fill any that are triggered by current
 * prices. Called before every GET /api/paper to keep the order book fresh.
 * Delegates each fill to the shared `fillOrder` in `src/lib/paper-fill.ts`.
 */
export async function fillPendingOrders(): Promise<number> {
  const pool = await getPool();
  const [pending] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT id, account_id, symbol, side, order_type, limit_price, stop_price FROM paper_orders WHERE status = 'PENDING'"
  );
  if (pending.length === 0) return 0;

  const symbols = Array.from(new Set(pending.map(o => o.symbol)));
  const prices = await fetchLivePrices(symbols);

  let filled = 0;
  for (const order of pending) {
    const live = prices[order.symbol];
    if (live == null) continue;
    const price = live.price;

    const limit = order.limit_price != null ? Number(order.limit_price) : null;
    const stop = order.stop_price != null ? Number(order.stop_price) : null;
    const side = order.side as "BUY" | "SELL";
    const type = order.order_type as "MARKET" | "LIMIT" | "STOP";

    let shouldFill = false;
    if (type === "MARKET") {
      // Only fill a PENDING MARKET order when the quote is live — outside
      // RTH the last-close price is not an honest execution.
      shouldFill = live.isLive;
    } else if (type === "LIMIT" && limit != null) {
      // BUY limit fills when price <= limit; SELL limit fills when price >= limit.
      shouldFill = side === "BUY" ? price <= limit : price >= limit;
    } else if (type === "STOP" && stop != null) {
      // BUY stop fills when price >= stop; SELL stop fills when price <= stop.
      shouldFill = side === "BUY" ? price >= stop : price <= stop;
    }

    if (!shouldFill) continue;

    const result = await fillOrder(pool, Number(order.id), price);
    if (result.filled) filled++;
  }
  return filled;
}

export { SYMBOL_RE };
