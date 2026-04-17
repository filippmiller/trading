import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/migrations";
import { runScenario, type ScenarioFilters, type TradeParams, type CostParams } from "@/lib/scenario-simulator";

type RequestBody = {
  filters?: ScenarioFilters;
  trade?: TradeParams;
  costs?: CostParams;
};

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = (await req.json()) as RequestBody;

    const filters: ScenarioFilters = body.filters ?? {};
    const trade: TradeParams = body.trade ?? {
      investmentUsd: 100,
      leverage: 1,
      tradeDirection: "LONG",
      exit: { kind: "TIME", holdDays: 3 },
    };
    const costs: CostParams = body.costs ?? {
      commissionRoundTrip: 2,
      marginApyPct: 7,
    };

    // Basic validation — explicit and bounded to prevent accidental huge queries.
    if (typeof trade.investmentUsd !== "number" || trade.investmentUsd <= 0 || trade.investmentUsd > 1_000_000) {
      return NextResponse.json({ error: "investmentUsd must be > 0 and <= 1,000,000" }, { status: 400 });
    }
    if (typeof trade.leverage !== "number" || trade.leverage < 1 || trade.leverage > 100) {
      return NextResponse.json({ error: "leverage must be 1..100" }, { status: 400 });
    }
    if (!trade.exit || typeof trade.exit.holdDays !== "number" || trade.exit.holdDays < 1 || trade.exit.holdDays > 10) {
      return NextResponse.json({ error: "exit.holdDays must be 1..10 (d1..d10)" }, { status: 400 });
    }
    if (trade.exit.kind !== "TIME" && trade.exit.kind !== "STOP") {
      return NextResponse.json({ error: "exit.kind must be TIME or STOP" }, { status: 400 });
    }
    if (trade.tradeDirection !== "LONG" && trade.tradeDirection !== "SHORT") {
      return NextResponse.json({ error: "tradeDirection must be LONG or SHORT" }, { status: 400 });
    }

    const result = await runScenario(filters, trade, costs);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
