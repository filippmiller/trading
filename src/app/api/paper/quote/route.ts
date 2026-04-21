import { NextResponse } from "next/server";
import { fetchLivePrice, SYMBOL_RE } from "@/lib/paper";

/**
 * GET /api/paper/quote?symbol=AAPL
 *
 * Lightweight quote endpoint used by the /paper buy-form sizing calculator
 * (W4) to back-solve "how many shares will this investment buy" and warn
 * when an investment is smaller than 1 whole share (fractional mode off).
 *
 * Returns the latest Yahoo quote's `{ price, asOf, isLive }` shape; null
 * price when the symbol is invalid or the fetch failed.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  if (!symbol || !SYMBOL_RE.test(symbol)) {
    return NextResponse.json({ error: "invalid symbol" }, { status: 400 });
  }
  const quote = await fetchLivePrice(symbol);
  if (!quote) {
    return NextResponse.json({ price: null, asOf: null, isLive: false }, { status: 200 });
  }
  return NextResponse.json({
    price: quote.price,
    asOf: quote.asOf.toISOString(),
    isLive: quote.isLive,
  });
}
