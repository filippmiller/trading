import { NextResponse } from "next/server";
import { getPool, mysql } from "@/lib/db";

/**
 * GET /api/strategies
 * Returns all strategies with accounts and signal stats in 2 queries (not 48).
 */
export async function GET() {
  try {
    const pool = await getPool();

    // Single query: strategies + accounts
    const [strategies] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT s.*, a.initial_cash, a.cash
       FROM paper_strategies s
       LEFT JOIN paper_accounts a ON s.account_id = a.id
       ORDER BY s.name`
    );

    // Single aggregated query: all signal stats grouped by strategy_id
    const [allStats] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT
         strategy_id,
         COUNT(*) as total_signals,
         SUM(CASE WHEN status IN ('BACKTEST_WIN', 'WIN') THEN 1 ELSE 0 END) as wins,
         SUM(CASE WHEN status IN ('BACKTEST_LOSS', 'LOSS') THEN 1 ELSE 0 END) as losses,
         SUM(CASE WHEN status = 'EXECUTED' AND exit_at IS NULL THEN 1 ELSE 0 END) as open_positions,
         COALESCE(SUM(pnl_usd), 0) as total_pnl_usd,
         COALESCE(AVG(CASE WHEN pnl_pct IS NOT NULL THEN pnl_pct END), 0) as avg_pnl_pct,
         COALESCE(MAX(max_pnl_pct), 0) as best_trade_pct,
         COALESCE(MIN(min_pnl_pct), 0) as worst_trade_pct,
         COALESCE(SUM(CASE WHEN status = 'EXECUTED' AND exit_at IS NULL THEN investment_usd ELSE 0 END), 0) as open_invested
       FROM paper_signals
       GROUP BY strategy_id`
    );

    // Index stats by strategy_id for O(1) lookup
    const statsMap = new Map<number, mysql.RowDataPacket>();
    for (const row of allStats) statsMap.set(row.strategy_id, row);

    const results = strategies.map(s => {
      const st = statsMap.get(s.id);
      const wins = Number(st?.wins ?? 0);
      const losses = Number(st?.losses ?? 0);
      const closedTrades = wins + losses;
      const totalPnl = Number(st?.total_pnl_usd ?? 0);
      const cash = Number(s.cash ?? 0);
      const initialCash = Number(s.initial_cash ?? 100000);
      const openInvested = Number(st?.open_invested ?? 0);
      const equity = cash + openInvested + totalPnl;

      return {
        id: s.id,
        name: s.name as string,
        strategy_type: s.strategy_type,
        leverage: Number(s.leverage),
        enabled: s.enabled === 1,
        account: {
          initial_cash: initialCash,
          cash,
          equity,
          return_pct: initialCash > 0 ? ((equity - initialCash) / initialCash) * 100 : 0,
        },
        stats: {
          total_signals: Number(st?.total_signals ?? 0),
          wins,
          losses,
          open_positions: Number(st?.open_positions ?? 0),
          closed_trades: closedTrades,
          win_rate: closedTrades > 0 ? (wins / closedTrades) * 100 : 0,
          total_pnl_usd: totalPnl,
          avg_pnl_pct: Number(st?.avg_pnl_pct ?? 0),
          best_trade_pct: Number(st?.best_trade_pct ?? 0),
          worst_trade_pct: Number(st?.worst_trade_pct ?? 0),
        },
      };
    });

    // Group by base strategy name
    const grouped: Record<string, typeof results> = {};
    for (const r of results) {
      const base = r.name.replace(/ \(\d+x\)$/, "");
      if (!grouped[base]) grouped[base] = [];
      grouped[base].push(r);
    }

    return NextResponse.json({ strategies: results, grouped });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
