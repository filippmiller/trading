import { NextResponse } from "next/server";

import { runGridSweep, GridSweepRequest } from "@/lib/scenario-simulator";

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

    const count = (arr?: { values: unknown[] }) => arr?.values?.length ?? 1;
    const combos =
      count(body.trade.holdDays) *
      count(body.trade.exitBar) *
      count(body.trade.entryDelayDays) *
      count(body.trade.entryBar) *
      count(body.trade.hardStopPct) *
      count(body.trade.takeProfitPct) *
      count(body.trade.trailingStopPct) *
      count(body.trade.breakevenAtPct);
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
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
