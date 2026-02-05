import { NextResponse } from "next/server";

import { getPool, mysql } from "@/lib/db";

type RunRow = {
  id: string;
  symbol: string;
  spec_json: string;
  preset_name: string | null;
};

type MetricsRow = {
  total_pnl_usd: number;
  total_return_pct: number;
  win_rate: number;
  trades_count: number;
  max_drawdown_pct: number;
  worst_losing_streak: number;
  avg_trade_pct: number;
  median_trade_pct: number;
};

type TradeRow = {
  entry_date: string;
  exit_date: string;
  side: string;
  pnl_usd: number;
  exit_reason: string;
};

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY." }, { status: 500 });
  }

  const { id: runId } = await params;

  try {
    const pool = await getPool();

    // Fetch run data
    const [runRows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT id, symbol, spec_json, preset_name FROM strategy_runs WHERE id = ?",
      [runId]
    );
    if (!runRows.length) {
      return NextResponse.json({ error: "Run not found." }, { status: 404 });
    }
    const run = runRows[0] as unknown as RunRow;

    // Fetch metrics
    const [metricsRows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT total_pnl_usd, total_return_pct, win_rate, trades_count,
              max_drawdown_pct, worst_losing_streak, avg_trade_pct, median_trade_pct
       FROM run_metrics WHERE run_id = ?`,
      [runId]
    );
    const metrics = metricsRows.length ? (metricsRows[0] as unknown as MetricsRow) : null;

    // Fetch sample trades (limit to 50 for context window)
    const [tradeRows] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT entry_date, exit_date, side, pnl_usd, exit_reason
       FROM trades WHERE run_id = ? ORDER BY entry_date LIMIT 50`,
      [runId]
    );
    const trades = tradeRows as unknown as TradeRow[];

    if (!metrics) {
      return NextResponse.json({ error: "No metrics found for this run." }, { status: 404 });
    }

    // Build analysis prompt
    const spec = JSON.parse(run.spec_json);
    const tradesSummary = trades
      .map((t) => `${t.entry_date}: ${t.side} -> ${t.exit_reason} ($${Number(t.pnl_usd).toFixed(2)})`)
      .join("\n");

    const winCount = trades.filter((t) => t.pnl_usd >= 0).length;
    const lossCount = trades.length - winCount;
    const exitReasons = trades.reduce((acc, t) => {
      acc[t.exit_reason] = (acc[t.exit_reason] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const systemPrompt = `You are a professional trading strategy analyst. Analyze this backtest and provide actionable insights.

Strategy Configuration:
- Template: ${spec.template}
- Symbol: ${run.symbol}
- Streak Length: ${spec.streak_length || "N/A"}
- Stop Loss: ${spec.stop_loss_pct ? (spec.stop_loss_pct * 100).toFixed(2) + "%" : "N/A"}
- Take Profit: ${spec.take_profit_pct ? (spec.take_profit_pct * 100).toFixed(2) + "%" : "N/A"}
- Trailing Stop: ${spec.trailing_stop_pct ? (spec.trailing_stop_pct * 100).toFixed(2) + "%" : "N/A"}
- Leverage: ${spec.leverage}x
- Capital: $${spec.capital_base_usd}

Performance Metrics:
- Total P&L: $${Number(metrics.total_pnl_usd).toFixed(2)}
- Total Return: ${(Number(metrics.total_return_pct) * 100).toFixed(2)}%
- Win Rate: ${(Number(metrics.win_rate) * 100).toFixed(1)}%
- Trade Count: ${metrics.trades_count}
- Max Drawdown: ${(Number(metrics.max_drawdown_pct) * 100).toFixed(2)}%
- Worst Losing Streak: ${metrics.worst_losing_streak}
- Average Trade: ${(Number(metrics.avg_trade_pct) * 100).toFixed(3)}%
- Median Trade: ${(Number(metrics.median_trade_pct) * 100).toFixed(3)}%

Exit Reason Distribution:
${Object.entries(exitReasons).map(([reason, count]) => `- ${reason}: ${count}`).join("\n")}

Sample Trades (${trades.length} shown):
${tradesSummary}

Provide a concise analysis covering:
1. Overall Assessment: Is this strategy profitable? Is the risk/reward favorable?
2. Win Rate vs Payoff: Analyze the win rate in relation to average win/loss size
3. Drawdown Analysis: Is the max drawdown acceptable given the return?
4. Exit Patterns: Which exit types dominate? What does this suggest?
5. Recommendations: 2-3 specific, actionable suggestions to improve the strategy

Keep your response focused and practical. Avoid generic advice.`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Analyze this backtest and provide your critique." },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const payload = await response.text();
      console.error("critique error", payload);
      return NextResponse.json({ error: "Critique generation failed." }, { status: 500 });
    }

    const payload = await response.json();
    const critique = payload.choices?.[0]?.message?.content ?? "Unable to generate critique.";

    return NextResponse.json({ critique, provider: "openai" });
  } catch (error) {
    console.error("critique error", error);
    return NextResponse.json({ error: "Critique generation failed." }, { status: 500 });
  }
}
