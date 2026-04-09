import { getPool, mysql } from "@/lib/db";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const SYMBOL_RE = /^[A-Z0-9.\-]{1,16}$/;

/**
 * Fetch the current (or most recent) market price for a symbol from Yahoo Finance.
 * Uses the same chart endpoint as the rest of the app — real-time during market hours,
 * last close outside market hours.
 */
export async function fetchLivePrice(symbol: string): Promise<number | null> {
  if (!SYMBOL_RE.test(symbol)) return null;
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price === "number" && isFinite(price) && price > 0) return price;
    return null;
  } catch {
    return null;
  }
}

/** Fetch live prices for a batch of symbols. Deduplicates. */
export async function fetchLivePrices(symbols: string[]): Promise<Record<string, number>> {
  const unique = Array.from(new Set(symbols.filter(s => SYMBOL_RE.test(s))));
  const out: Record<string, number> = {};
  await Promise.all(
    unique.map(async (s) => {
      const p = await fetchLivePrice(s);
      if (p != null) out[s] = p;
    })
  );
  return out;
}

export type PaperAccount = {
  id: number;
  name: string;
  initial_cash: number;
  cash: number;
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
      created_at: r.created_at,
    };
  }
  await pool.execute(
    "INSERT INTO paper_accounts (name, initial_cash, cash) VALUES ('Default', 100000, 100000)"
  );
  return getDefaultAccount();
}

/**
 * Compute account equity = cash + mark-to-market value of open positions.
 * Uses live prices from Yahoo. Falls back to buy_price if live fetch fails.
 */
export async function computeAccountEquity(accountId: number): Promise<{
  cash: number;
  positions_value: number;
  equity: number;
  open_positions: number;
}> {
  const pool = await getPool();
  const [accounts] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT cash FROM paper_accounts WHERE id = ?",
    [accountId]
  );
  const cash = accounts.length > 0 ? Number(accounts[0].cash) : 0;

  const [positions] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT symbol, quantity, buy_price, investment_usd FROM paper_trades WHERE account_id = ? AND status = 'OPEN'",
    [accountId]
  );

  if (positions.length === 0) {
    return { cash, positions_value: 0, equity: cash, open_positions: 0 };
  }

  const prices = await fetchLivePrices(positions.map(p => p.symbol));
  let positions_value = 0;
  for (const p of positions) {
    const live = prices[p.symbol];
    const markPrice = live ?? Number(p.buy_price);
    const qty = Number(p.quantity) || Number(p.investment_usd) / Number(p.buy_price);
    positions_value += qty * markPrice;
  }

  return {
    cash,
    positions_value,
    equity: cash + positions_value,
    open_positions: positions.length,
  };
}

/**
 * Check pending limit/stop orders and fill any that are triggered by current prices.
 * Called before every GET /api/paper to keep the order book fresh.
 */
export async function fillPendingOrders(): Promise<number> {
  const pool = await getPool();
  const [pending] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT * FROM paper_orders WHERE status = 'PENDING'"
  );
  if (pending.length === 0) return 0;

  const symbols = Array.from(new Set(pending.map(o => o.symbol)));
  const prices = await fetchLivePrices(symbols);

  let filled = 0;
  for (const order of pending) {
    const price = prices[order.symbol];
    if (price == null) continue;

    const limit = order.limit_price ? Number(order.limit_price) : null;
    const stop = order.stop_price ? Number(order.stop_price) : null;
    const side = order.side as "BUY" | "SELL";
    const type = order.order_type as "MARKET" | "LIMIT" | "STOP";

    let shouldFill = false;
    if (type === "MARKET") {
      shouldFill = true;
    } else if (type === "LIMIT" && limit != null) {
      // BUY limit fills when price <= limit; SELL limit fills when price >= limit
      shouldFill = side === "BUY" ? price <= limit : price >= limit;
    } else if (type === "STOP" && stop != null) {
      // BUY stop fills when price >= stop; SELL stop fills when price <= stop
      shouldFill = side === "BUY" ? price >= stop : price <= stop;
    }

    if (!shouldFill) continue;

    await fillOrder(order, price);
    filled++;
  }
  return filled;
}

async function fillOrder(order: mysql.RowDataPacket, fillPrice: number): Promise<void> {
  const pool = await getPool();
  const side = order.side as "BUY" | "SELL";

  if (side === "BUY") {
    const investment = Number(order.investment_usd);
    const [accountRows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT cash FROM paper_accounts WHERE id = ?",
      [order.account_id]
    );
    if (accountRows.length === 0) {
      await pool.execute(
        "UPDATE paper_orders SET status='REJECTED', rejection_reason='Account not found' WHERE id=?",
        [order.id]
      );
      return;
    }
    const cash = Number(accountRows[0].cash);
    if (cash < investment) {
      await pool.execute(
        "UPDATE paper_orders SET status='REJECTED', rejection_reason='Insufficient cash' WHERE id=?",
        [order.id]
      );
      return;
    }

    const quantity = investment / fillPrice;
    const [tradeResult] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO paper_trades
       (account_id, symbol, quantity, buy_price, buy_date, investment_usd, strategy, status, notes)
       VALUES (?, ?, ?, ?, CURRENT_DATE, ?, ?, 'OPEN', ?)`,
      [
        order.account_id,
        order.symbol,
        quantity,
        fillPrice,
        investment,
        `${order.order_type} BUY`,
        order.notes || null,
      ]
    );

    // Deduct cash
    await pool.execute(
      "UPDATE paper_accounts SET cash = cash - ? WHERE id = ?",
      [investment, order.account_id]
    );

    // Mark order filled
    await pool.execute(
      "UPDATE paper_orders SET status='FILLED', filled_price=?, filled_at=CURRENT_TIMESTAMP(6), trade_id=? WHERE id=?",
      [fillPrice, tradeResult.insertId, order.id]
    );
  } else {
    // SELL: find the linked trade (order.trade_id or by symbol + account)
    let tradeId: number | null = order.trade_id ? Number(order.trade_id) : null;
    if (tradeId == null) {
      const [tradeRows] = await pool.execute<mysql.RowDataPacket[]>(
        "SELECT id FROM paper_trades WHERE account_id=? AND symbol=? AND status='OPEN' ORDER BY id ASC LIMIT 1",
        [order.account_id, order.symbol]
      );
      if (tradeRows.length === 0) {
        await pool.execute(
          "UPDATE paper_orders SET status='REJECTED', rejection_reason='No open position' WHERE id=?",
          [order.id]
        );
        return;
      }
      tradeId = tradeRows[0].id;
    }

    const [tradeRows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT * FROM paper_trades WHERE id=? AND status='OPEN'",
      [tradeId]
    );
    if (tradeRows.length === 0) {
      await pool.execute(
        "UPDATE paper_orders SET status='REJECTED', rejection_reason='Trade not open' WHERE id=?",
        [order.id]
      );
      return;
    }

    const trade = tradeRows[0];
    const buyPrice = Number(trade.buy_price);
    const investment = Number(trade.investment_usd);
    const quantity = Number(trade.quantity) || investment / buyPrice;
    const proceeds = quantity * fillPrice;
    const pnlUsd = proceeds - investment;
    const pnlPct = (pnlUsd / investment) * 100;

    await pool.execute(
      `UPDATE paper_trades SET status='CLOSED', sell_price=?, sell_date=CURRENT_DATE, pnl_usd=?, pnl_pct=? WHERE id=?`,
      [fillPrice, pnlUsd, pnlPct, tradeId]
    );
    await pool.execute(
      "UPDATE paper_accounts SET cash = cash + ? WHERE id = ?",
      [proceeds, order.account_id]
    );
    await pool.execute(
      "UPDATE paper_orders SET status='FILLED', filled_price=?, filled_at=CURRENT_TIMESTAMP(6), trade_id=? WHERE id=?",
      [fillPrice, tradeId, order.id]
    );
  }
}

export { SYMBOL_RE };
