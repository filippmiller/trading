import { NextResponse } from "next/server";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

type QuoteData = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  marketCap: number;
};

async function fetchQuote(symbol: string): Promise<QuoteData | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;
    return {
      symbol: meta.symbol || symbol,
      name: meta.shortName || meta.longName || symbol,
      price,
      change: price - prevClose,
      changePct: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
      open: meta.regularMarketOpen || 0,
      high: meta.regularMarketDayHigh || meta.dayHigh || 0,
      low: meta.regularMarketDayLow || meta.dayLow || 0,
      prevClose,
      volume: meta.regularMarketVolume || 0,
      marketCap: meta.marketCap || 0,
    };
  } catch {
    return null;
  }
}

async function fetchMovers(type: "gainers" | "losers"): Promise<QuoteData[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_${type}&count=15`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const data = await res.json();
    const quotes = data?.finance?.result?.[0]?.quotes ?? [];
    return quotes.slice(0, 15).map((q: Record<string, unknown>) => ({
      symbol: q.symbol as string,
      name: (q.shortName || q.longName || q.symbol) as string,
      price: Number(q.regularMarketPrice ?? 0),
      change: Number(q.regularMarketChange ?? 0),
      changePct: Number(q.regularMarketChangePercent ?? 0),
      open: Number(q.regularMarketOpen ?? 0),
      high: Number(q.regularMarketDayHigh ?? 0),
      low: Number(q.regularMarketDayLow ?? 0),
      prevClose: Number(q.regularMarketPreviousClose ?? 0),
      volume: Number(q.regularMarketVolume ?? 0),
      marketCap: Number(q.marketCap ?? 0),
    }));
  } catch {
    return [];
  }
}

/**
 * GET /api/markets?symbols=AAPL,MSFT,GOOGL
 * GET /api/markets?view=movers
 * GET /api/markets?search=TSLA
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const view = url.searchParams.get("view");
    const symbols = url.searchParams.get("symbols");
    const search = url.searchParams.get("search");

    if (view === "movers") {
      const [gainers, losers] = await Promise.all([
        fetchMovers("gainers"),
        fetchMovers("losers"),
      ]);
      return NextResponse.json({ gainers, losers });
    }

    if (search) {
      const quote = await fetchQuote(search.toUpperCase());
      if (!quote) return NextResponse.json({ error: "Symbol not found" }, { status: 404 });

      // Also fetch chart data
      const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(search.toUpperCase())}?range=1d&interval=5m`;
      const chartRes = await fetch(chartUrl, { headers: { "User-Agent": UA } });
      let chart: Array<{ time: number; price: number }> = [];
      if (chartRes.ok) {
        const chartData = await chartRes.json();
        const result = chartData?.chart?.result?.[0];
        const ts = result?.timestamp || [];
        const closes = result?.indicators?.quote?.[0]?.close || [];
        chart = ts.map((t: number, i: number) => ({ time: t, price: closes[i] })).filter((p: { price: number | null }) => p.price != null);
      }

      return NextResponse.json({ quote, chart });
    }

    if (symbols) {
      const list = symbols.split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);
      const quotes: QuoteData[] = [];
      for (let i = 0; i < list.length; i += 5) {
        const batch = list.slice(i, i + 5);
        const results = await Promise.all(batch.map(fetchQuote));
        for (const r of results) if (r) quotes.push(r);
      }
      return NextResponse.json({ quotes });
    }

    // Default: market indices + top movers
    const indices = ["^GSPC", "^IXIC", "^DJI", "^VIX"];
    const indexQuotes = await Promise.all(indices.map(fetchQuote));
    const [gainers, losers] = await Promise.all([
      fetchMovers("gainers"),
      fetchMovers("losers"),
    ]);

    return NextResponse.json({
      indices: indexQuotes.filter(Boolean),
      gainers: gainers.slice(0, 10),
      losers: losers.slice(0, 10),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
