import { NextResponse } from "next/server";

type Mover = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
};

// Fetch top gainers and losers from Yahoo Finance
export async function GET() {
  try {
    const gainers = await fetchMovers("gainers");
    const losers = await fetchMovers("losers");

    return NextResponse.json({
      gainers: gainers.slice(0, 10),
      losers: losers.slice(0, 10),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("movers fetch error", error);
    return NextResponse.json(
      { error: "Failed to fetch market movers." },
      { status: 500 }
    );
  }
}

async function fetchMovers(type: "gainers" | "losers"): Promise<Mover[]> {
  // Yahoo Finance screener API
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_${type}&count=25`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Yahoo API error: ${response.status}`);
  }

  const data = await response.json();
  const quotes = data?.finance?.result?.[0]?.quotes ?? [];

  return quotes.map((q: Record<string, unknown>) => ({
    symbol: q.symbol as string,
    name: (q.shortName || q.longName || q.symbol) as string,
    price: Number(q.regularMarketPrice ?? 0),
    change: Number(q.regularMarketChange ?? 0),
    changePct: Number(q.regularMarketChangePercent ?? 0),
  }));
}
