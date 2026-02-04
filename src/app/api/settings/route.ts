import { NextResponse } from "next/server";
import { z } from "zod";

import { getDefaultSettings, updateDefaultSettings } from "@/lib/data";

const DefaultsSchema = z.object({
  commission_per_side_usd: z.number().min(0).max(50),
  slippage_bps: z.number().min(0).max(50),
  margin_interest_apr: z.number().min(0).max(1),
  leverage: z.number().min(1).max(10),
  base_capital_usd: z.number().min(50).max(100000),
});

export async function GET() {
  const defaults = await getDefaultSettings();
  return NextResponse.json({
    defaults,
  });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = DefaultsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid settings." }, { status: 400 });
  }
  await updateDefaultSettings(parsed.data);
  return NextResponse.json({ ok: true });
}
