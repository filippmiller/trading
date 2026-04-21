import { NextResponse } from "next/server";
import { getPool, mysql } from "@/lib/db";
import { ensureSchema } from "@/lib/migrations";
import {
  fetchLivePrices,
  getDefaultAccount,
  computeAccountEquity,
  fillPendingOrders,
} from "@/lib/paper";

/**
 * GET /api/paper
 * Returns account summary, open positions with live P&L, closed trades, and
 * pending orders. Also runs the order-matching engine to fill any triggered
 * pending orders.
 *
 * Each open position carries `asOf` and `is_live` so the UI can show the
 * user which marks are stale (e.g. outside RTH, or when Yahoo returned null).
 */
export async function GET() {
  try {
    await ensureSchema();
    const pool = await getPool();
    const account = await getDefaultAccount();

    const filled = await fillPendingOrders();

    const [tradeRows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT * FROM paper_trades WHERE account_id = ? ORDER BY status ASC, created_at DESC",
      [account.id]
    );

    const openTrades = tradeRows.filter(r => r.status === "OPEN");
    const prices = openTrades.length > 0
      ? await fetchLivePrices(openTrades.map(r => r.symbol))
      : {};

    const trades = tradeRows.map(r => {
      const buyPrice = Number(r.buy_price);
      const investment = Number(r.investment_usd);
      const quantity = Number(r.quantity) || (buyPrice > 0 ? investment / buyPrice : 0);
      const live = prices[r.symbol];
      const isOpen = r.status === "OPEN";
      const currentPrice = isOpen
        ? (live?.price ?? null)
        : (r.sell_price != null ? Number(r.sell_price) : null);

      let pnlPct: number | null = null;
      let pnlUsd: number | null = null;
      if (isOpen && currentPrice != null && buyPrice > 0) {
        pnlPct = ((currentPrice - buyPrice) / buyPrice) * 100;
        pnlUsd = quantity * (currentPrice - buyPrice);
      } else if (!isOpen && r.pnl_usd != null) {
        pnlUsd = Number(r.pnl_usd);
        pnlPct = r.pnl_pct != null ? Number(r.pnl_pct) : null;
      }

      return {
        id: r.id,
        symbol: r.symbol,
        quantity,
        buy_price: buyPrice,
        buy_date: r.buy_date,
        sell_date: r.sell_date,
        sell_price: r.sell_price != null ? Number(r.sell_price) : null,
        investment_usd: investment,
        current_price: currentPrice,
        live_pnl_usd: pnlUsd,
        live_pnl_pct: pnlPct,
        as_of: isOpen ? (live?.asOf?.toISOString() ?? null) : null,
        is_live: isOpen ? (live?.isLive ?? false) : true,
        strategy: r.strategy,
        status: r.status,
        notes: r.notes,
        created_at: r.created_at,
      };
    });

    const [orderRows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT * FROM paper_orders WHERE account_id = ? AND status = 'PENDING' ORDER BY created_at DESC",
      [account.id]
    );
    const pendingOrders = orderRows.map(o => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      order_type: o.order_type,
      investment_usd: o.investment_usd != null ? Number(o.investment_usd) : null,
      limit_price: o.limit_price != null ? Number(o.limit_price) : null,
      stop_price: o.stop_price != null ? Number(o.stop_price) : null,
      reserved_amount: Number(o.reserved_amount ?? 0),
      created_at: o.created_at,
      notes: o.notes,
    }));

    const equity = await computeAccountEquity(account.id);
    const totalReturn = account.initial_cash > 0
      ? ((equity.equity - account.initial_cash) / account.initial_cash) * 100
      : 0;

    const closedTrades = tradeRows.filter(r => r.status === "CLOSED");
    const wins = closedTrades.filter(r => Number(r.pnl_usd) > 0).length;
    const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;
    const realizedPnl = closedTrades.reduce((s, r) => s + Number(r.pnl_usd || 0), 0);

    return NextResponse.json({
      account: {
        id: account.id,
        name: account.name,
        initial_cash: account.initial_cash,
        cash: equity.cash,
        reserved_cash: equity.reserved_cash,
        positions_value: equity.positions_value,
        equity: equity.equity,
        open_positions: equity.open_positions,
        stale_positions: equity.stale_positions,
        total_return_pct: totalReturn,
        realized_pnl_usd: realizedPnl,
        win_rate_pct: winRate,
        closed_trades: closedTrades.length,
      },
      trades,
      pendingOrders,
      filledOnThisRequest: filled,
      server_now: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
