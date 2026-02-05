import { NextResponse } from "next/server";

import { clampSpec, StrategySpecSchema } from "@/lib/strategy";

type Message = {
  role: "user" | "assistant";
  content: string;
};

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY." }, { status: 500 });
  }

  const body = await req.json();
  const currentSpec = body.spec;
  const userMessage = String(body.message || "").trim();
  const history = Array.isArray(body.history) ? body.history as Message[] : [];

  if (!currentSpec || typeof currentSpec !== "object") {
    return NextResponse.json({ error: "Current spec required." }, { status: 400 });
  }
  if (!userMessage) {
    return NextResponse.json({ error: "Message required." }, { status: 400 });
  }

  const systemPrompt = `You are a trading strategy refinement assistant. You help users modify their StrategySpec based on their requests.

Current StrategySpec:
${JSON.stringify(currentSpec, null, 2)}

StrategySpec shape:
- template: streak_fade | streak_follow | sar_fade_flip | gap_fade
- symbol: ticker string (uppercase, max 16 chars)
- lookback_days: int 20..260
- capital_base_usd: number
- leverage: number (1-10)
- costs: { commission_per_side_usd, slippage_bps, margin_interest_apr }
- optional regime_filter: { type: "ma", length: 200, allow_fade_only_if: "price_near_ma" }
- optional martingale_lite: { base_capital_usd, leverage, max_steps, step_multiplier, max_exposure_usd, max_daily_loss_usd }

Template details:
- streak_fade or streak_follow: { enter_on: "close", direction: "fade"|"follow", streak_length, stop_loss_pct, take_profit_pct?, trailing_stop_pct?, hold_max_days }
- sar_fade_flip: same as streak_fade plus flip_on_stop=true, flip_max_times
- gap_fade: { enter_on: "open", direction: "fade", gap_threshold_pct, stop_loss_pct, take_profit_pct?, trailing_stop_pct?, hold_max_days }

Percent fields must be decimals (e.g. 0.01 for 1%).

Return a JSON object with:
{
  "spec": <the modified StrategySpec>,
  "explanation": "<brief explanation of what you changed>"
}

Only modify the fields the user asks about. Keep everything else unchanged.`;

  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    { role: "user" as const, content: userMessage },
  ];

  try {
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
        messages,
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const payload = await response.text();
      console.error("refine error", payload);
      return NextResponse.json({ error: "Refinement failed." }, { status: 500 });
    }

    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content ?? "{}";

    let parsed: { spec?: unknown; explanation?: string };
    try {
      parsed = JSON.parse(content);
    } catch {
      return NextResponse.json({ error: "Invalid JSON from model." }, { status: 500 });
    }

    if (!parsed.spec || typeof parsed.spec !== "object") {
      return NextResponse.json({ error: "Model returned invalid spec." }, { status: 500 });
    }

    // Normalize percentage fields
    const normalizePct = (value: unknown) => {
      if (typeof value !== "number") return value;
      let v = value;
      if (v > 1) v = v / 100;
      if (v > 0.2) v = v / 100;
      if (v > 0.2) v = 0.2;
      return v;
    };

    const normalized = { ...(parsed.spec as Record<string, unknown>) };
    const pctFields = ["stop_loss_pct", "take_profit_pct", "trailing_stop_pct", "gap_threshold_pct"];
    for (const field of pctFields) {
      if (field in normalized) {
        normalized[field] = normalizePct(normalized[field]);
      }
    }

    const spec = clampSpec(StrategySpecSchema.parse(normalized));
    const explanation = parsed.explanation || "Strategy updated.";

    return NextResponse.json({ spec, explanation });
  } catch (error) {
    console.error("refine error", error);
    return NextResponse.json({ error: "Refinement failed." }, { status: 500 });
  }
}
