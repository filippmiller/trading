import { NextResponse } from "next/server";
import crypto from "crypto";

import { ensureDefaultSettings, ensureSchema } from "@/lib/migrations";
import { getPool, mysql } from "@/lib/db";
import { loadPrices } from "@/lib/data";
import { clampSpec, StrategySpecSchema } from "@/lib/strategy";
import { runBacktest } from "@/lib/backtest";

export async function POST(req: Request) {
  let runId: string | null = null;
  try {
    await ensureSchema();
    await ensureDefaultSettings();

    const body = await req.json();
    if (!body?.spec) {
      return NextResponse.json({ error: "Strategy spec required." }, { status: 400 });
    }

    const spec = clampSpec(StrategySpecSchema.parse(body.spec));
    const presetName = body.preset_name ? String(body.preset_name) : null;
    const voiceText = body.voice_text ? String(body.voice_text) : null;
    const llmProvider = body.llm_provider ? String(body.llm_provider) : null;

    const prices = await loadPrices(spec.lookback_days);
    if (prices.length < 20) {
      return NextResponse.json({ error: "Not enough price data." }, { status: 400 });
    }

    const pool = await getPool();
    runId = crypto.randomUUID();
    await pool.execute(
      "INSERT INTO strategy_runs (id, symbol, lookback_days, spec_json, voice_text, llm_provider, status, preset_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        runId,
        spec.symbol,
        spec.lookback_days,
        JSON.stringify(spec),
        voiceText,
        llmProvider,
        "running",
        presetName,
      ]
    );

    const { trades, metrics } = runBacktest(prices, spec);

    for (const trade of trades) {
      await pool.execute<mysql.ResultSetHeader>(
        "INSERT INTO trades (run_id, entry_date, side, entry_price, exit_date, exit_price, exit_reason, pnl_usd, pnl_pct, fees_usd, interest_usd, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          runId,
          trade.entry_date,
          trade.side,
          trade.entry_price,
          trade.exit_date,
          trade.exit_price,
          trade.exit_reason,
          trade.pnl_usd,
          trade.pnl_pct,
          trade.fees_usd,
          trade.interest_usd,
          trade.meta_json ?? null,
        ]
      );
    }

    await pool.execute(
      "INSERT INTO run_metrics (run_id, total_pnl_usd, total_return_pct, win_rate, trades_count, max_drawdown_pct, worst_losing_streak, max_martingale_step_reached, martingale_step_escalations, avg_trade_pct, median_trade_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        runId,
        metrics.total_pnl_usd,
        metrics.total_return_pct,
        metrics.win_rate,
        metrics.trades_count,
        metrics.max_drawdown_pct,
        metrics.worst_losing_streak,
        metrics.max_martingale_step_reached,
        metrics.martingale_step_escalations,
        metrics.avg_trade_pct,
        metrics.median_trade_pct,
      ]
    );

    await pool.execute("UPDATE strategy_runs SET status = ? WHERE id = ?", ["done", runId]);

    return NextResponse.json({ id: runId });
  } catch (error: unknown) {
    console.error("backtest run error", error);
    if (runId) {
      try {
        const pool = await getPool();
        await pool.execute(
          "UPDATE strategy_runs SET status = ?, error_message = ? WHERE id = ?",
          ["error", error instanceof Error ? error.message : "Backtest error", runId]
        );
      } catch (updateError) {
        console.error("failed to update run status", updateError);
      }
    }
    return NextResponse.json({ error: "Backtest failed." }, { status: 500 });
  }
}
