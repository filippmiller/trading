import { NextResponse } from "next/server";
import { getPool, mysql } from "@/lib/db";

// GET - fetch all paper trades with live prices
export async function GET() {
  try {
    const pool = await getPool();
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT * FROM paper_trades ORDER BY status ASC, created_at DESC"
    );

    // Fetch live prices for OPEN trades
    const openTrades = rows.filter(r => r.status === 'OPEN');
    const liveData: Record<string, { price: number; change: number }> = {};

    for (const trade of openTrades) {
      if (liveData[trade.symbol]) continue;
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${trade.symbol}?range=1d&interval=5m`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        });
        if (res.ok) {
          const data = await res.json();
          const result = data?.chart?.result?.[0];
          const meta = result?.meta;
          if (meta?.regularMarketPrice) {
            liveData[trade.symbol] = {
              price: meta.regularMarketPrice,
              change: meta.regularMarketPrice - (meta.chartPreviousClose || meta.previousClose || 0),
            };
          }
        }
      } catch { /* skip */ }
    }

    const trades = rows.map(r => {
      const live = liveData[r.symbol];
      const buyPrice = Number(r.buy_price);
      const currentPrice = live?.price || (r.sell_price ? Number(r.sell_price) : null);
      const pnlPct = currentPrice ? ((currentPrice - buyPrice) / buyPrice) * 100 : null;
      const pnlUsd = currentPrice ? (pnlPct! / 100) * Number(r.investment_usd) : null;

      return {
        id: r.id,
        symbol: r.symbol,
        buy_price: buyPrice,
        buy_date: r.buy_date,
        sell_date: r.sell_date,
        sell_price: r.sell_price ? Number(r.sell_price) : null,
        investment_usd: Number(r.investment_usd),
        current_price: currentPrice,
        live_pnl_usd: pnlUsd,
        live_pnl_pct: pnlPct,
        strategy: r.strategy,
        status: r.status,
        notes: r.notes,
      };
    });

    const totalInvested = trades.filter(t => t.status === 'OPEN').reduce((s, t) => s + t.investment_usd, 0);
    const totalPnl = trades.filter(t => t.status === 'OPEN' && t.live_pnl_usd).reduce((s, t) => s + t.live_pnl_usd!, 0);

    return NextResponse.json({ trades, totalInvested, totalPnl });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST - sell a paper trade (close position)
export async function POST(req: Request) {
  try {
    const pool = await getPool();
    const { id, sell_price } = await req.json();

    if (!id || !sell_price) {
      return NextResponse.json({ error: "id and sell_price required" }, { status: 400 });
    }

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT * FROM paper_trades WHERE id = ? AND status = 'OPEN'", [id]
    );
    if (!rows.length) {
      return NextResponse.json({ error: "Trade not found or already closed" }, { status: 404 });
    }

    const trade = rows[0];
    const buyPrice = Number(trade.buy_price);
    const pnlPct = ((sell_price - buyPrice) / buyPrice) * 100;
    const pnlUsd = (pnlPct / 100) * Number(trade.investment_usd);

    await pool.execute(
      "UPDATE paper_trades SET status = 'CLOSED', sell_price = ?, sell_date = CURRENT_DATE, pnl_usd = ?, pnl_pct = ? WHERE id = ?",
      [sell_price, pnlUsd, pnlPct, id]
    );

    return NextResponse.json({ success: true, pnl_usd: pnlUsd, pnl_pct: pnlPct });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
