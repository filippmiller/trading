import { NextResponse } from "next/server";

import { clampSpec, StrategySpecSchema } from "@/lib/strategy";

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY." }, { status: 500 });
  }

  const body = await req.json();
  const text = String(body.text || "").trim();
  if (!text) {
    return NextResponse.json({ error: "Text is required." }, { status: 400 });
  }

  const system = `You are a trading strategy parser. Return ONLY valid JSON that matches StrategySpec.

StrategySpec shape:
- template: streak_fade | streak_follow | sar_fade_flip | gap_fade
- symbol: "SPY"
- lookback_days: int 20..260
- capital_base_usd: number
- leverage: number
- costs: { commission_per_side_usd, slippage_bps, margin_interest_apr }
- optional regime_filter: { type: "ma", length: 200, allow_fade_only_if: "price_near_ma" }
- optional martingale_lite: { base_capital_usd, leverage, max_steps, step_multiplier, max_exposure_usd, max_daily_loss_usd }

Template details:
- streak_fade or streak_follow: { enter_on: "close", direction: "fade"|"follow", streak_length, stop_loss_pct, take_profit_pct?, trailing_stop_pct?, hold_max_days }
- sar_fade_flip: same as streak_fade plus flip_on_stop=true, flip_max_times
- gap_fade: { enter_on: "open", direction: "fade", gap_threshold_pct, stop_loss_pct, take_profit_pct?, trailing_stop_pct?, hold_max_days }

Percent fields must be decimals (e.g. 0.005 for 0.5%).
If any values missing, use defaults: lookback_days=60, capital_base_usd=500, leverage=5, commission_per_side_usd=1, slippage_bps=2, margin_interest_apr=0.12, hold_max_days=1.
Return JSON only.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error("parse error", payload);
    return NextResponse.json({ error: "Parse failed." }, { status: 500 });
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return NextResponse.json({ error: "Invalid JSON from model." }, { status: 500 });
  }

  const normalizePct = (value: unknown) => {
    if (typeof value !== "number") return value;
    let v = value;
    if (v > 1) v = v / 100;
    if (v > 0.2) v = v / 100;
    if (v > 0.2) v = 0.2;
    return v;
  };

  const normalized = { ...(parsed as Record<string, unknown>) };
  const pctFields = ["stop_loss_pct", "take_profit_pct", "trailing_stop_pct", "gap_threshold_pct"];
  for (const field of pctFields) {
    if (field in normalized) {
      normalized[field] = normalizePct(normalized[field]);
    }
  }

  const spec = clampSpec(StrategySpecSchema.parse(normalized));
  return NextResponse.json({ spec, provider: "openai" });
}
