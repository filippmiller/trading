import { NextResponse } from "next/server";

import { refreshSymbolData } from "@/lib/data";

export async function POST(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    let symbol = searchParams.get("symbol") || "SPY";
    try {
      if (req.headers.get("content-type")?.includes("application/json")) {
        const body = await req.json();
        if (body?.symbol) symbol = String(body.symbol);
      }
    } catch {
      // ignore malformed body
    }
    const result = await refreshSymbolData(symbol);
    return NextResponse.json(result);
  } catch (error) {
    console.error("refresh data error", error);
    return NextResponse.json({ error: "Failed to refresh data." }, { status: 500 });
  }
}
