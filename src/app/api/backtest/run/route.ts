import { NextResponse } from "next/server";

import { ensureDefaultSettings, ensureSchema } from "@/lib/migrations";
import { getPool, sql } from "@/lib/db";
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
    const runInsert = await pool
      .request()
      .input("symbol", sql.VarChar(16), spec.symbol)
      .input("lookback_days", sql.Int, spec.lookback_days)
      .input("spec_json", sql.NVarChar(sql.MAX), JSON.stringify(spec))
      .input("voice_text", sql.NVarChar(sql.MAX), voiceText)
      .input("llm_provider", sql.VarChar(32), llmProvider)
      .input("status", sql.VarChar(16), "running")
      .input("preset_name", sql.VarChar(64), presetName)
      .query(
        "INSERT INTO strategy_runs (symbol, lookback_days, spec_json, voice_text, llm_provider, status, preset_name) OUTPUT inserted.id VALUES (@symbol, @lookback_days, @spec_json, @voice_text, @llm_provider, @status, @preset_name)"
      );

    runId = runInsert.recordset[0].id as string;

    const { trades, metrics } = runBacktest(prices, spec);

    for (const trade of trades) {
      await pool
        .request()
        .input("run_id", sql.UniqueIdentifier, runId)
        .input("entry_date", sql.Date, trade.entry_date)
        .input("side", sql.VarChar(8), trade.side)
        .input("entry_price", sql.Decimal(18, 6), trade.entry_price)
        .input("exit_date", sql.Date, trade.exit_date)
        .input("exit_price", sql.Decimal(18, 6), trade.exit_price)
        .input("exit_reason", sql.VarChar(32), trade.exit_reason)
        .input("pnl_usd", sql.Decimal(18, 6), trade.pnl_usd)
        .input("pnl_pct", sql.Decimal(18, 6), trade.pnl_pct)
        .input("fees_usd", sql.Decimal(18, 6), trade.fees_usd)
        .input("interest_usd", sql.Decimal(18, 6), trade.interest_usd)
        .input("meta_json", sql.NVarChar(sql.MAX), trade.meta_json ?? null)
        .query(
          "INSERT INTO trades (run_id, entry_date, side, entry_price, exit_date, exit_price, exit_reason, pnl_usd, pnl_pct, fees_usd, interest_usd, meta_json) VALUES (@run_id, @entry_date, @side, @entry_price, @exit_date, @exit_price, @exit_reason, @pnl_usd, @pnl_pct, @fees_usd, @interest_usd, @meta_json)"
        );
    }

    await pool
      .request()
      .input("run_id", sql.UniqueIdentifier, runId)
      .input("total_pnl_usd", sql.Decimal(18, 6), metrics.total_pnl_usd)
      .input("total_return_pct", sql.Decimal(18, 6), metrics.total_return_pct)
      .input("win_rate", sql.Decimal(18, 6), metrics.win_rate)
      .input("trades_count", sql.Int, metrics.trades_count)
      .input("max_drawdown_pct", sql.Decimal(18, 6), metrics.max_drawdown_pct)
      .input("worst_losing_streak", sql.Int, metrics.worst_losing_streak)
      .input("max_martingale_step_reached", sql.Int, metrics.max_martingale_step_reached)
      .input("martingale_step_escalations", sql.Int, metrics.martingale_step_escalations)
      .input("avg_trade_pct", sql.Decimal(18, 6), metrics.avg_trade_pct)
      .input("median_trade_pct", sql.Decimal(18, 6), metrics.median_trade_pct)
      .query(
        "INSERT INTO run_metrics (run_id, total_pnl_usd, total_return_pct, win_rate, trades_count, max_drawdown_pct, worst_losing_streak, max_martingale_step_reached, martingale_step_escalations, avg_trade_pct, median_trade_pct) VALUES (@run_id, @total_pnl_usd, @total_return_pct, @win_rate, @trades_count, @max_drawdown_pct, @worst_losing_streak, @max_martingale_step_reached, @martingale_step_escalations, @avg_trade_pct, @median_trade_pct)"
      );

    await pool
      .request()
      .input("id", sql.UniqueIdentifier, runId)
      .input("status", sql.VarChar(16), "done")
      .query("UPDATE strategy_runs SET status = @status WHERE id = @id");

    return NextResponse.json({ id: runId });
  } catch (error: unknown) {
    console.error("backtest run error", error);
    if (runId) {
      try {
        const pool = await getPool();
        await pool
          .request()
          .input("id", sql.UniqueIdentifier, runId)
          .input("status", sql.VarChar(16), "error")
          .input(
            "error_message",
            sql.NVarChar(sql.MAX),
            error instanceof Error ? error.message : "Backtest error"
          )
          .query(
            "UPDATE strategy_runs SET status = @status, error_message = @error_message WHERE id = @id"
          );
      } catch (updateError) {
        console.error("failed to update run status", updateError);
      }
    }
    return NextResponse.json({ error: "Backtest failed." }, { status: 500 });
  }
}
