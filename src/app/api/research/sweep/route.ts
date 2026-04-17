import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/migrations";
import {
  runScenario,
  type ScenarioFilters,
  type TradeParams,
  type CostParams,
  type ScenarioSummary,
} from "@/lib/scenario-simulator";

/**
 * Parameter sweep: runs the base scenario N times, varying one parameter
 * across a range. Returns summary-per-step (NOT full trade lists — those
 * would blow up response size). Use GET /api/research/run for detail.
 *
 * Supported sweep dims:
 *  - exit.holdDays  (1..10)
 *  - leverage       (1..20 or custom step)
 *  - investmentUsd  (e.g. $50..$500)
 *  - filters.minDayChangePct / maxDayChangePct (for magnitude tuning)
 *  - exit.hardStopPct (e.g. -10..-2)
 *  - exit.takeProfitPct (e.g. 2..20)
 */
type SweepDim =
  | "exit.holdDays"
  | "trade.leverage"
  | "trade.investmentUsd"
  | "filters.minDayChangePct"
  | "filters.maxDayChangePct"
  | "exit.hardStopPct"
  | "exit.takeProfitPct"
  | "exit.trailingStopPct";

type SweepRequest = {
  filters: ScenarioFilters;
  trade: TradeParams;
  costs: CostParams;
  sweep: {
    dim: SweepDim;
    from: number;
    to: number;
    step: number;
  };
};

type SweepResult = {
  dim: SweepDim;
  steps: Array<{
    value: number;
    summary: ScenarioSummary;
  }>;
};

function applyDim(
  dim: SweepDim,
  value: number,
  filters: ScenarioFilters,
  trade: TradeParams
): { filters: ScenarioFilters; trade: TradeParams } {
  const f: ScenarioFilters = { ...filters };
  const t: TradeParams = { ...trade, exit: { ...trade.exit } };
  switch (dim) {
    case "exit.holdDays":      t.exit.holdDays = Math.max(1, Math.min(10, Math.round(value))); break;
    case "trade.leverage":     t.leverage = Math.max(1, Math.min(100, value)); break;
    case "trade.investmentUsd":t.investmentUsd = Math.max(1, value); break;
    case "filters.minDayChangePct": f.minDayChangePct = value; break;
    case "filters.maxDayChangePct": f.maxDayChangePct = value; break;
    case "exit.hardStopPct":   t.exit.hardStopPct = value; break;
    case "exit.takeProfitPct": t.exit.takeProfitPct = value; break;
    case "exit.trailingStopPct": t.exit.trailingStopPct = value; break;
  }
  return { filters: f, trade: t };
}

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = (await req.json()) as SweepRequest;
    const { filters, trade, costs, sweep } = body;

    if (!sweep || typeof sweep.from !== "number" || typeof sweep.to !== "number" || typeof sweep.step !== "number") {
      return NextResponse.json({ error: "sweep.from, sweep.to, sweep.step required" }, { status: 400 });
    }
    if (sweep.step <= 0) return NextResponse.json({ error: "sweep.step must be > 0" }, { status: 400 });
    const span = Math.abs(sweep.to - sweep.from);
    const count = Math.floor(span / sweep.step) + 1;
    if (count < 2 || count > 40) {
      return NextResponse.json({ error: "sweep produces " + count + " steps — must be 2..40" }, { status: 400 });
    }

    const dir = sweep.to >= sweep.from ? 1 : -1;
    const steps: SweepResult["steps"] = [];

    // Sequential execution — keeps DB connection pool predictable, OK for <=40 steps.
    for (let i = 0; i < count; i++) {
      const value = sweep.from + dir * sweep.step * i;
      const applied = applyDim(sweep.dim, value, filters, trade);
      const r = await runScenario(applied.filters, applied.trade, costs);
      steps.push({ value, summary: r.summary });
    }

    return NextResponse.json({ dim: sweep.dim, steps } as SweepResult);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
