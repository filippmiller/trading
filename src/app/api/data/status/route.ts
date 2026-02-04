import { NextResponse } from "next/server";

import { getDataStatus } from "@/lib/data";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get("symbol") || "SPY";
    const status = await getDataStatus(symbol);
    return NextResponse.json(status);
  } catch (error) {
    console.error("data status error", error);
    return NextResponse.json({ error: "Failed to load status." }, { status: 500 });
  }
}
