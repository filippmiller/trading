import { getPool, mysql } from "@/lib/db";
import { fillOrder, recordEquitySnapshotSafe, type FillRationale } from "@/lib/paper-fill";

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
  reserved_short_margin: number;
  created_at: string;
};

function rowToAccount(r: mysql.RowDataPacket): PaperAccount {
  return {
    id: r.id,
    name: r.name,
    initial_cash: Number(r.initial_cash),
    cash: Number(r.cash),
    reserved_cash: Number(r.reserved_cash ?? 0),
    reserved_short_margin: Number(r.reserved_short_margin ?? 0),
    created_at: r.created_at,
  };
}

/** Fetch the default paper account, creating it if missing. */
export async function getDefaultAccount(): Promise<PaperAccount> {
  const pool = await getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM paper_accounts WHERE name = 'Default' LIMIT 1"
  );
  if (rows.length > 0) return rowToAccount(rows[0]);
  await pool.execute(
    "INSERT INTO paper_accounts (name, initial_cash, cash) VALUES ('Default', 100000, 100000)"
  );
  const [created] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM paper_accounts WHERE name = 'Default' LIMIT 1"
  );
  if (created.length === 0) throw new Error("Failed to create default paper account");
  return rowToAccount(created[0]);
}

/**
 * W5 — multi-account. Fetch an account by id. Returns null if not found.
 * Used by `resolveAccount` to honor the `?account_id=<n>` query param.
 */
export async function getAccountById(id: number): Promise<PaperAccount | null> {
  const pool = await getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM paper_accounts WHERE id = ? LIMIT 1",
    [id]
  );
  return rows.length > 0 ? rowToAccount(rows[0]) : null;
}

/**
 * W5 — list every paper account with basic info. Used by the account-switcher
 * dropdown. Order: id ASC (so 'Default' — the first-created — tends to appear
 * first in the UI).
 */
export async function listPaperAccounts(): Promise<PaperAccount[]> {
  const pool = await getPool();
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM paper_accounts ORDER BY id ASC"
  );
  return rows.map(rowToAccount);
}

/**
 * W5 round-2 — thrown by `resolveAccount` when the caller passed an explicit
 * account_id that doesn't match any row. Used to let routes return 404
 * instead of silently falling back to Default. Silent fallback was a data-
 * loss hazard: stale localStorage pointing at a deleted account + user
 * clicks Reset → wipes Default instead of 404'ing.
 */
export class AccountNotFoundError extends Error {
  readonly accountId: number;
  constructor(accountId: number) {
    super(`Account ${accountId} not found`);
    this.name = "AccountNotFoundError";
    this.accountId = accountId;
  }
}

/**
 * W5 — resolve the account to operate on. Honors an optional `account_id`
 * query param (from `?account_id=<n>`).
 *
 * Semantics:
 *   - `null` / empty / missing param → Default account (backward compat;
 *     cron + background paths that don't thread account_id still work).
 *   - Numeric param matching an existing row → that account.
 *   - Numeric param with no matching row → throws `AccountNotFoundError`
 *     so callers can return 404. (Round-2 fix: previously fell through to
 *     Default, which let a stale client-side account_id wipe Default on
 *     reset.)
 *   - Non-numeric / garbage param → throws `AccountNotFoundError` as well;
 *     only `null`/empty triggers the Default fallback.
 */
export async function resolveAccount(
  accountIdParam: string | null
): Promise<PaperAccount> {
  if (accountIdParam == null || accountIdParam === "") {
    return getDefaultAccount();
  }
  if (!/^\d+$/.test(accountIdParam)) {
    throw new AccountNotFoundError(NaN);
  }
  const id = Number(accountIdParam);
  const acct = await getAccountById(id);
  if (!acct) throw new AccountNotFoundError(id);
  return acct;
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
  reserved_short_margin: number;
  positions_value: number;
  equity: number;
  open_positions: number;
  stale_positions: number;
  marks: Record<string, PositionMark>;
}> {
  const pool = await getPool();
  const [accounts] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT cash, reserved_cash, reserved_short_margin FROM paper_accounts WHERE id = ?",
    [accountId]
  );
  const cash = accounts.length > 0 ? Number(accounts[0].cash) : 0;
  const reservedCash = accounts.length > 0 ? Number(accounts[0].reserved_cash ?? 0) : 0;
  const reservedShortMargin = accounts.length > 0 ? Number(accounts[0].reserved_short_margin ?? 0) : 0;

  // W3: select side + closed_quantity so LONG vs SHORT mark-to-market
  // contributions net correctly. LONG open value contributes remaining_qty *
  // mark_price; SHORT unrealized-pnl contribution is (buy_price - mark_price)
  // * remaining_qty (direction-aware), stacking ON TOP of the held margin.
  const [positions] = await pool.execute<mysql.RowDataPacket[]>(
    `SELECT symbol, side, quantity, closed_quantity, buy_price, investment_usd
       FROM paper_trades
      WHERE account_id = ? AND status = 'OPEN'`,
    [accountId]
  );

  if (positions.length === 0) {
    return {
      cash,
      reserved_cash: reservedCash,
      reserved_short_margin: reservedShortMargin,
      positions_value: 0,
      equity: cash + reservedCash + reservedShortMargin,
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
    const totalQty = Number(p.quantity) || Number(p.investment_usd) / buyPrice;
    const closedQty = Number(p.closed_quantity ?? 0);
    const remaining = Math.max(0, totalQty - closedQty);
    const markPrice = live?.price ?? buyPrice;
    if (p.side === "SHORT") {
      // SHORT: margin is already counted in reserved_short_margin. Contribution
      // to positions_value is the UNREALIZED P&L on the short (price movement
      // in our favour = positive). (buy_price - mark_price) * remaining.
      positions_value += (buyPrice - markPrice) * remaining;
    } else {
      // LONG: contribute mark-to-market value of remaining shares.
      positions_value += remaining * markPrice;
    }
    if (!live) stale++;
    marks[p.symbol] = {
      symbol: p.symbol,
      markPrice,
      asOf: live?.asOf ?? null,
      isLive: live?.isLive ?? false,
    };
  }

  // Equity includes reserved cash AND short margin — both are still the
  // account's money, just locked against open exposure. positions_value
  // already reflects direction-aware mark contributions.
  return {
    cash,
    reserved_cash: reservedCash,
    reserved_short_margin: reservedShortMargin,
    positions_value,
    equity: cash + reservedCash + reservedShortMargin + positions_value,
    open_positions: positions.length,
    stale_positions: stale,
    marks,
  };
}

/**
 * 5-minute OHLC bar. `t` is the bar's Unix-seconds open time. W2 LIMIT-fill
 * path uses these bars to detect a limit-price touch that happened BETWEEN
 * polls (current spot may have snapped back before the poller looked).
 */
export type IntradayBar = {
  t: number;   // Unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
};

/**
 * Fetch 5-minute intraday bars for `symbol` from Yahoo. Returns the last
 * `range=1d` window at `interval=5m`. Returns an empty array on any
 * transport/parse error — callers fall back silently to the spot check.
 *
 * Exposed via a module-level reference so smoke tests can monkey-patch the
 * fetcher without touching internals; normal code paths just call
 * `fetchIntradayBars(symbol)`.
 */
export async function fetchIntradayBarsFromYahoo(symbol: string): Promise<IntradayBar[]> {
  if (!SYMBOL_RE.test(symbol)) return [];
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const ts: number[] = result?.timestamp ?? [];
    const q = result?.indicators?.quote?.[0];
    const opens: (number | null)[] = q?.open ?? [];
    const highs: (number | null)[] = q?.high ?? [];
    const lows: (number | null)[] = q?.low ?? [];
    const closes: (number | null)[] = q?.close ?? [];
    const bars: IntradayBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const open = opens[i], high = highs[i], low = lows[i], close = closes[i];
      if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
      bars.push({ t: Number(ts[i]), open: open as number, high: high as number, low: low as number, close: close as number });
    }
    return bars;
  } catch {
    return [];
  }
}

/**
 * Monkey-patch slot for tests. Default implementation hits Yahoo; smoke
 * tests replace it with a fixture-returning fn to prove the OHLC_TOUCH code
 * path runs without network dependency.
 */
export let fetchIntradayBars: (symbol: string) => Promise<IntradayBar[]> = fetchIntradayBarsFromYahoo;

/** Set a test override. Call `_resetIntradayBarsFetcher()` after the test. */
export function _setIntradayBarsFetcher(fn: (symbol: string) => Promise<IntradayBar[]>): void {
  fetchIntradayBars = fn;
}
export function _resetIntradayBarsFetcher(): void {
  fetchIntradayBars = fetchIntradayBarsFromYahoo;
}

/**
 * Decide whether a LIMIT order should fill against the intraday bars window.
 *
 * Returns the fill price (the limit price itself — the UX contract for a
 * limit order is "you get the limit or better") + rationale, or null if no
 * touch happened and the spot check also did not trigger.
 *
 * OHLC self-audit notes (W2 round-2):
 *
 * OHLC-A — Double-fill safety: `fillPendingOrders` produces exactly ONE
 *   fillOrder call per pending order per batch (spot & OHLC checks are
 *   mutually-exclusive branches of the same decision). If two batches race
 *   (UI + cron concurrent), the status-guarded UPDATE in fillOrder
 *   (`WHERE status='PENDING'`) rejects the second attempt with
 *   `ORDER_NOT_PENDING_FILLED`. No double-fill possible.
 *
 * OHLC-B — Time basis: `bar.t` is Unix seconds (from Yahoo's `timestamp`
 *   field). `createdAt` is a JS Date built from MySQL DATETIME(6) with the
 *   mysql2 pool configured `timezone: "Z"` (see src/lib/db.ts), so the Date
 *   reflects true UTC epoch. `Math.floor(createdAt.getTime() / 1000)` is
 *   Unix seconds — SAME basis as `bar.t`. Comparison is valid across any
 *   host timezone. Do NOT pass a string in; the mysql2 driver already
 *   returns Date objects for DATETIME columns.
 *
 * OHLC-C — Bar validity: non-finite high/low values are skipped defensively
 *   inside this loop even though `fetchIntradayBarsFromYahoo` already
 *   filters them — a monkey-patched test fetcher could return malformed
 *   bars, and we'd rather emit a SPOT (or null) decision than crash.
 *
 * OHLC-D — Market-hours: this function is DELIBERATELY NOT gated on
 *   `live.isLive`. LIMIT orders are allowed to trigger on historical
 *   intraday bars even when called outside RTH — a limit price pierced at
 *   10:17 ET should fill regardless of whether the next poll runs at
 *   10:20 or 17:30. The MARKET-order RTH gate lives in `fillPendingOrders`,
 *   not here.
 *
 * OHLC-E — Wall-clock drift: bars are filtered only on `bar.t >= createdAtSec`
 *   (the lower bound). There is NO upper bound — a bar whose timestamp is
 *   30 minutes old is still a valid touch detector. This is intentional
 *   for closed-market and low-activity symbols where the last bar may lag.
 *
 * @param side       BUY or SELL
 * @param limit      Order's limit price
 * @param spot       Current live price
 * @param bars       Intraday 5-min bars since the order's created_at
 * @param createdAt  Order's created_at as a Date (filters bars)
 */
export function evaluateLimitFill(
  side: "BUY" | "SELL",
  limit: number,
  spot: number,
  bars: IntradayBar[],
  createdAt: Date
): { fillPrice: number; rationale: FillRationale } | null {
  // Spot check first — cheaper, matches legacy behavior. Guard against NaN
  // spot (defensive: callers passing through `price` already guard earlier).
  if (Number.isFinite(spot)) {
    if (side === "BUY" && spot <= limit) return { fillPrice: spot, rationale: "SPOT" };
    if (side === "SELL" && spot >= limit) return { fillPrice: spot, rationale: "SPOT" };
  }

  // OHLC check — find any bar whose low..high range pierced the limit.
  const createdAtSec = Math.floor(createdAt.getTime() / 1000);
  for (const bar of bars) {
    // OHLC-C defensive filter — skip bars with non-finite high/low. The
    // Yahoo fetcher filters these already; this second check catches fixture
    // bars from tests / future fetcher implementations.
    if (!Number.isFinite(bar.high) || !Number.isFinite(bar.low)) continue;
    if (!Number.isFinite(bar.t)) continue;
    if (bar.t < createdAtSec) continue;
    if (side === "BUY" && bar.low <= limit) {
      return { fillPrice: limit, rationale: "OHLC_TOUCH" };
    }
    if (side === "SELL" && bar.high >= limit) {
      return { fillPrice: limit, rationale: "OHLC_TOUCH" };
    }
  }
  return null;
}

/**
 * Check pending limit/stop orders and fill any that are triggered by current
 * prices. Called before every GET /api/paper to keep the order book fresh.
 * Delegates each fill to the shared `fillOrder` in `src/lib/paper-fill.ts`.
 *
 * W2: LIMIT orders additionally query 5-min OHLC bars for the window since
 * `created_at` — if the limit price was pierced inside any bar the order
 * fills at the limit with `fill_rationale=OHLC_TOUCH`. Yahoo failures fall
 * back silently to the spot check so one bad symbol never poisons the batch.
 */
export async function fillPendingOrders(): Promise<number> {
  const pool = await getPool();
  // W3: select position_side too so LIMIT/STOP evaluation knows which
  // direction the order is opening/closing. SHORT orders trigger at
  // direction-aware thresholds — a SELL-SHORT LIMIT "sell at 105 or higher"
  // mirrors BUY LIMIT "buy at 95 or lower."
  const [pending] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT id, account_id, symbol, side, position_side, order_type, limit_price, stop_price, created_at FROM paper_orders WHERE status = 'PENDING'"
  );
  if (pending.length === 0) return 0;

  const symbols = Array.from(new Set(pending.map(o => o.symbol)));
  const prices = await fetchLivePrices(symbols);

  const limitSymbols = Array.from(new Set(
    pending.filter(o => o.order_type === "LIMIT").map(o => o.symbol)
  ));
  const barsBySymbol: Record<string, IntradayBar[]> = {};
  for (let i = 0; i < limitSymbols.length; i += 5) {
    const batch = limitSymbols.slice(i, i + 5);
    await Promise.all(batch.map(async (s) => {
      try {
        barsBySymbol[s] = await fetchIntradayBars(s);
      } catch {
        barsBySymbol[s] = [];
      }
    }));
  }

  let filled = 0;
  for (const order of pending) {
    const live = prices[order.symbol];
    if (live == null) continue;
    const price = live.price;

    const limit = order.limit_price != null ? Number(order.limit_price) : null;
    const stop = order.stop_price != null ? Number(order.stop_price) : null;
    const side = order.side as "BUY" | "SELL";
    const type = order.order_type as "MARKET" | "LIMIT" | "STOP";

    let fillPrice: number | null = null;
    let rationale: FillRationale | undefined;

    if (type === "MARKET") {
      if (live.isLive) {
        fillPrice = price;
        rationale = "SPOT";
      }
    } else if (type === "LIMIT" && limit != null) {
      // LIMIT semantics in terms of order `side`:
      //   BUY limit  → fill when price ≤ limit (buy cheap)
      //   SELL limit → fill when price ≥ limit (sell high)
      // This holds for both open-long (BUY+LONG), close-long (SELL+LONG),
      // open-short (SELL+SHORT — sell at limit or higher), and cover-short
      // (BUY+SHORT — buy at limit or lower). The existing evaluateLimitFill
      // already encodes this via `side`.
      const bars = barsBySymbol[order.symbol] ?? [];
      const createdAt = order.created_at instanceof Date
        ? order.created_at
        : new Date(order.created_at);
      const decision = evaluateLimitFill(side, limit, price, bars, createdAt);
      if (decision) {
        fillPrice = decision.fillPrice;
        rationale = decision.rationale;
      }
    } else if (type === "STOP" && stop != null) {
      // STOP semantics in terms of order `side`:
      //   BUY stop  → fill when price ≥ stop (breakout BUY or cover SHORT stop)
      //   SELL stop → fill when price ≤ stop (stop-loss SELL or short entry)
      const triggered = side === "BUY" ? price >= stop : price <= stop;
      if (triggered) {
        fillPrice = price;
        rationale = "SPOT";
      }
    }

    if (fillPrice == null) continue;

    const result = await fillOrder(pool, Number(order.id), fillPrice, { fillRationale: rationale });
    if (result.filled) filled++;
  }
  return filled;
}

/**
 * Re-export the Safe (cron / idle) snapshot variant. In-transaction callers
 * must import `recordEquitySnapshotInTx` directly from `@/lib/paper-fill`;
 * we don't re-export it here to keep the distinction explicit and prevent
 * accidental use from non-transactional call sites.
 */
export { recordEquitySnapshotSafe };

export { SYMBOL_RE };
