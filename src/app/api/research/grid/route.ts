import { NextResponse } from "next/server";

import { ensureSchema } from "@/lib/migrations";
import {
  BAR_TIMES,
  buildGridSweepCombos,
  runGridSweep,
  GridSweepRequest,
} from "@/lib/scenario-simulator";

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "object" && err !== null) {
    const maybe = err as {
      code?: unknown;
      errno?: unknown;
      sqlMessage?: unknown;
      cause?: unknown;
    };
    const parts = [
      typeof maybe.code === "string" ? maybe.code : null,
      typeof maybe.errno === "number" ? `errno ${maybe.errno}` : null,
      typeof maybe.sqlMessage === "string" && maybe.sqlMessage.length > 0 ? maybe.sqlMessage : null,
      maybe.cause instanceof Error && maybe.cause.message ? maybe.cause.message : null,
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(" | ");
  }
  return String(err);
}

/**
 * POST /api/research/grid
 *
 * Multi-dimensional grid sweep. Expands every combination of the provided axes
 * and returns the top-N configs by the chosen metric. Unlike /api/research/sweep
 * (1-D walk), this is combinatorial: 5 holds × 3 bars × 4 SLs × 4 TPs = 240 sims.
 *
 * Body shape — see GridSweepRequest in scenario-simulator.ts.
 * Hard cap 10,000 combinations to protect the server.
 */
export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = (await req.json()) as GridSweepRequest;
    if (!body?.trade || !body?.filters || !body?.costs) {
      return NextResponse.json(
        { error: "Missing required fields: filters, trade, costs." },
        { status: 400 }
      );
    }
    if (!body.trade.holdDays?.values?.length) {
      return NextResponse.json({ error: "trade.holdDays.values required." }, { status: 400 });
    }
    if (!body.trade.exitBar?.values?.length) {
      return NextResponse.json({ error: "trade.exitBar.values required." }, { status: 400 });
    }
    if (typeof body.trade.investmentUsd !== "number" || body.trade.investmentUsd <= 0 || body.trade.investmentUsd > 1_000_000) {
      return NextResponse.json({ error: "trade.investmentUsd must be > 0 and <= 1,000,000." }, { status: 400 });
    }
    if (typeof body.trade.leverage !== "number" || body.trade.leverage < 1 || body.trade.leverage > 100) {
      return NextResponse.json({ error: "trade.leverage must be 1..100." }, { status: 400 });
    }
    if (body.trade.tradeDirection !== "LONG" && body.trade.tradeDirection !== "SHORT") {
      return NextResponse.json({ error: "trade.tradeDirection must be LONG or SHORT." }, { status: 400 });
    }
    if (typeof body.costs.commissionRoundTrip !== "number" || body.costs.commissionRoundTrip < 0) {
      return NextResponse.json({ error: "costs.commissionRoundTrip must be >= 0." }, { status: 400 });
    }
    if (typeof body.costs.marginApyPct !== "number" || body.costs.marginApyPct < 0) {
      return NextResponse.json({ error: "costs.marginApyPct must be >= 0." }, { status: 400 });
    }
    if (body.topN != null && (!Number.isInteger(body.topN) || body.topN < 1 || body.topN > 100)) {
      return NextResponse.json({ error: "topN must be an integer 1..100." }, { status: 400 });
    }
    if (body.sortBy != null && !["totalPnl", "winRate", "sharpe", "profitFactor"].includes(body.sortBy)) {
      return NextResponse.json({ error: "sortBy must be totalPnl, winRate, sharpe, or profitFactor." }, { status: 400 });
    }

    const everyFinite = (values: unknown[], predicate: (value: number) => boolean) =>
      values.every((value) => typeof value === "number" && Number.isFinite(value) && predicate(value));
    const everyNullableFinite = (values: unknown[], predicate: (value: number) => boolean) =>
      values.every((value) => value == null || (typeof value === "number" && Number.isFinite(value) && predicate(value)));

    if (!everyFinite(body.trade.holdDays.values, (value) => Number.isInteger(value) && value >= 1 && value <= 10)) {
      return NextResponse.json({ error: "trade.holdDays.values must be integers 1..10." }, { status: 400 });
    }
    if (!body.trade.exitBar.values.every((value) => BAR_TIMES.includes(value))) {
      return NextResponse.json({ error: "trade.exitBar.values must contain only morning, midday, or close." }, { status: 400 });
    }
    if (body.trade.entryDelayDays && !everyFinite(body.trade.entryDelayDays.values, (value) => Number.isInteger(value) && value >= 0 && value <= 9)) {
      return NextResponse.json({ error: "trade.entryDelayDays.values must be integers 0..9." }, { status: 400 });
    }
    if (body.trade.entryBar && !body.trade.entryBar.values.every((value) => BAR_TIMES.includes(value))) {
      return NextResponse.json({ error: "trade.entryBar.values must contain only morning, midday, or close." }, { status: 400 });
    }
    if (body.trade.hardStopPct && !everyNullableFinite(body.trade.hardStopPct.values, (value) => value <= 0)) {
      return NextResponse.json({ error: "trade.hardStopPct.values must be null or <= 0." }, { status: 400 });
    }
    if (body.trade.takeProfitPct && !everyNullableFinite(body.trade.takeProfitPct.values, (value) => value >= 0)) {
      return NextResponse.json({ error: "trade.takeProfitPct.values must be null or >= 0." }, { status: 400 });
    }
    if (body.trade.trailingStopPct && !everyNullableFinite(body.trade.trailingStopPct.values, (value) => value >= 0)) {
      return NextResponse.json({ error: "trade.trailingStopPct.values must be null or >= 0." }, { status: 400 });
    }
    if (body.trade.breakevenAtPct && !everyNullableFinite(body.trade.breakevenAtPct.values, (value) => value >= 0)) {
      return NextResponse.json({ error: "trade.breakevenAtPct.values must be null or >= 0." }, { status: 400 });
    }

    const combos = buildGridSweepCombos(body.trade).length;
    if (combos === 0) {
      return NextResponse.json(
        { error: "No valid combinations remain. Check holdDays vs entryDelayDays." },
        { status: 400 }
      );
    }
    if (combos > 10000) {
      return NextResponse.json(
        { error: `Too many combinations (${combos}). Hard cap is 10,000 — narrow the ranges.` },
        { status: 400 }
      );
    }

    const result = await runGridSweep(body);
    return NextResponse.json(result);
  } catch (err) {
    console.error("grid sweep error", err);
    return NextResponse.json(
      { error: describeError(err) },
      { status: 500 }
    );
  }
}
