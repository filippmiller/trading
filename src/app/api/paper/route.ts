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

    // Left join paper_strategies so the UI can render the strategy NAME
    // (not just the denormalized VARCHAR label) for cron-generated trades.
    // Manual trades have strategy_id=NULL so strategy_name stays NULL too.
    const [tradeRows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT t.*, s.name AS strategy_name
         FROM paper_trades t
         LEFT JOIN paper_strategies s ON s.id = t.strategy_id
        WHERE t.account_id = ?
        ORDER BY t.status ASC, t.created_at DESC`,
      [account.id]
    );

    const openTrades = tradeRows.filter(r => r.status === "OPEN");
    const prices = openTrades.length > 0
      ? await fetchLivePrices(openTrades.map(r => r.symbol))
      : {};

    const trades = tradeRows.map(r => {
      const buyPrice = Number(r.buy_price);
      const investment = Number(r.investment_usd);
      const totalQty = Number(r.quantity) || (buyPrice > 0 ? investment / buyPrice : 0);
      const closedQty = Number(r.closed_quantity ?? 0);
      const remainingQty = Math.max(0, totalQty - closedQty);
      const live = prices[r.symbol];
      const isOpen = r.status === "OPEN";
      const side = r.side === "SHORT" ? "SHORT" : "LONG";
      const currentPrice = isOpen
        ? (live?.price ?? null)
        : (r.sell_price != null ? Number(r.sell_price) : null);

      // Direction-aware live P&L. For CLOSED trades we trust the stored value.
      let pnlPct: number | null = null;
      let pnlUsd: number | null = null;
      if (isOpen && currentPrice != null && buyPrice > 0) {
        if (side === "SHORT") {
          pnlPct = ((buyPrice - currentPrice) / buyPrice) * 100;
          pnlUsd = remainingQty * (buyPrice - currentPrice);
        } else {
          pnlPct = ((currentPrice - buyPrice) / buyPrice) * 100;
          pnlUsd = remainingQty * (currentPrice - buyPrice);
        }
      } else if (!isOpen && r.pnl_usd != null) {
        pnlUsd = Number(r.pnl_usd);
        pnlPct = r.pnl_pct != null ? Number(r.pnl_pct) : null;
      }

      return {
        id: r.id,
        symbol: r.symbol,
        side,
        quantity: totalQty,
        closed_quantity: closedQty,
        remaining_quantity: remainingQty,
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
        strategy_id: r.strategy_id != null ? Number(r.strategy_id) : null,
        strategy_name: r.strategy_name ?? null,
        status: r.status,
        notes: r.notes,
        // W3 bracket surfacing — UI renders chips for non-null values.
        stop_loss_price: r.stop_loss_price != null ? Number(r.stop_loss_price) : null,
        take_profit_price: r.take_profit_price != null ? Number(r.take_profit_price) : null,
        trailing_stop_pct: r.trailing_stop_pct != null ? Number(r.trailing_stop_pct) : null,
        trailing_stop_price: r.trailing_stop_price != null ? Number(r.trailing_stop_price) : null,
        trailing_active: Number(r.trailing_active ?? 0) === 1,
        time_exit_date: r.time_exit_date ?? null,
        exit_reason: r.exit_reason ?? null,
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
      position_side: o.position_side ?? "LONG",
      order_type: o.order_type,
      investment_usd: o.investment_usd != null ? Number(o.investment_usd) : null,
      limit_price: o.limit_price != null ? Number(o.limit_price) : null,
      stop_price: o.stop_price != null ? Number(o.stop_price) : null,
      reserved_amount: Number(o.reserved_amount ?? 0),
      reserved_short_margin: Number(o.reserved_short_margin ?? 0),
      close_quantity: o.close_quantity != null ? Number(o.close_quantity) : null,
      created_at: o.created_at,
      notes: o.notes,
    }));

    const equity = await computeAccountEquity(account.id);
    const totalReturn = account.initial_cash > 0
      ? ((equity.equity - account.initial_cash) / account.initial_cash) * 100
      : 0;

    // Win-rate math (W2, finding #14 + codex F3):
    //
    //   - `win_rate_pct` keeps its ORIGINAL denominator (`wins / closed_trades`)
    //     for backward-compat. Any external consumer that joined the KPI to
    //     `closed_trades` stays correct.
    //   - `win_rate_excl_scratched_pct` is the new SCRATCHED-excluded variant
    //     — the KPI we actually want to show in the UI, where a break-even
    //     trade is treated as noise rather than a 0%-win dilution.
    //   - profit_factor = gross_wins / |gross_losses|. If there were any
    //     winning trades but no losers, returns `null` (JSON-safe sentinel
    //     for infinity) — UI renders as "∞".
    //   - scratched_count exposes the excluded count so UI can show
    //     "X wins · Y losses · Z scratched" honestly.
    const closedTrades = tradeRows.filter(r => r.status === "CLOSED");
    const scratchedCount = closedTrades.filter(r => Number(r.pnl_usd) === 0).length;
    const nonScratched = closedTrades.filter(r => Number(r.pnl_usd) !== 0);
    const wins = nonScratched.filter(r => Number(r.pnl_usd) > 0).length;
    const losses = nonScratched.length - wins;
    // Original (backward-compat) win rate: wins ÷ ALL closed trades.
    const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;
    // New (scratched-excluded) win rate: wins ÷ non-scratched closed trades.
    const winRateExclScratched = nonScratched.length > 0 ? (wins / nonScratched.length) * 100 : 0;
    const realizedPnl = closedTrades.reduce((s, r) => s + Number(r.pnl_usd || 0), 0);

    const grossWins = nonScratched
      .filter(r => Number(r.pnl_usd) > 0)
      .reduce((s, r) => s + Number(r.pnl_usd), 0);
    const grossLosses = nonScratched
      .filter(r => Number(r.pnl_usd) < 0)
      .reduce((s, r) => s + Math.abs(Number(r.pnl_usd)), 0);
    let profitFactor: number | null;
    if (grossLosses > 0) {
      profitFactor = grossWins / grossLosses;
    } else if (grossWins > 0) {
      profitFactor = null; // ∞ — all-winners case; UI renders "∞"
    } else {
      profitFactor = 0;    // no wins AND no losses (all scratched / empty)
    }

    return NextResponse.json({
      account: {
        id: account.id,
        name: account.name,
        initial_cash: account.initial_cash,
        cash: equity.cash,
        reserved_cash: equity.reserved_cash,
        reserved_short_margin: equity.reserved_short_margin,
        positions_value: equity.positions_value,
        equity: equity.equity,
        open_positions: equity.open_positions,
        stale_positions: equity.stale_positions,
        total_return_pct: totalReturn,
        realized_pnl_usd: realizedPnl,
        // Original (backward-compat) denominator = `closed_trades`.
        win_rate_pct: winRate,
        // Scratched-excluded variant — prefer this in UI displays.
        win_rate_excl_scratched_pct: winRateExclScratched,
        closed_trades: closedTrades.length,
        wins_count: wins,
        losses_count: losses,
        scratched_count: scratchedCount,
        profit_factor: profitFactor,
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
