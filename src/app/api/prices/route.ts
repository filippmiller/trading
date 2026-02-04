import { NextResponse } from "next/server";

import { loadPrices } from "@/lib/data";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limitRaw = Number(searchParams.get("limit") || 60);
  const limit = Math.min(260, Math.max(1, Math.floor(limitRaw)));
  const symbol = searchParams.get("symbol") || "SPY";

  const rows = await loadPrices(limit, symbol);
  const items = rows.map((row) => ({
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
  }));

  return NextResponse.json({ items });
}
