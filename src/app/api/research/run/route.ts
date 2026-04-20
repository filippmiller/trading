import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/migrations";
import { BAR_TIMES, runScenario, type ScenarioFilters, type TradeParams, type CostParams } from "@/lib/scenario-simulator";

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
    if (trade.exit.exitBar != null && !BAR_TIMES.includes(trade.exit.exitBar)) {
      return NextResponse.json({ error: "exit.exitBar must be morning, midday, or close" }, { status: 400 });
    }
    if (trade.exit.kind !== "TIME" && trade.exit.kind !== "STOP") {
      return NextResponse.json({ error: "exit.kind must be TIME or STOP" }, { status: 400 });
    }
    if (trade.tradeDirection !== "LONG" && trade.tradeDirection !== "SHORT") {
      return NextResponse.json({ error: "tradeDirection must be LONG or SHORT" }, { status: 400 });
    }
    if (trade.entryBar != null && !BAR_TIMES.includes(trade.entryBar)) {
      return NextResponse.json({ error: "entryBar must be morning, midday, or close" }, { status: 400 });
    }
    if (trade.entryDelayDays != null && (!Number.isInteger(trade.entryDelayDays) || trade.entryDelayDays < 0 || trade.entryDelayDays >= trade.exit.holdDays)) {
      return NextResponse.json({ error: "entryDelayDays must be an integer >= 0 and < exit.holdDays" }, { status: 400 });
    }
    if (trade.exit.hardStopPct != null && trade.exit.hardStopPct > 0) {
      return NextResponse.json({ error: "exit.hardStopPct must be <= 0" }, { status: 400 });
    }

    const result = await runScenario(filters, trade, costs);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: describeError(err) }, { status: 500 });
  }
}
