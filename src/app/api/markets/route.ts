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

type MarketRange = "1d" | "5d" | "1mo" | "6mo" | "1y";

type ChartPoint = {
  time: number;
  price: number;
  label: string;
};

const RANGE_CONFIG: Record<MarketRange, { range: string; interval: string; labelMode: "time" | "date"; includePrePost?: boolean }> = {
  "1d": { range: "1d", interval: "5m", labelMode: "time", includePrePost: false },
  "5d": { range: "5d", interval: "15m", labelMode: "date", includePrePost: false },
  "1mo": { range: "1mo", interval: "1d", labelMode: "date" },
  "6mo": { range: "6mo", interval: "1d", labelMode: "date" },
  "1y": { range: "1y", interval: "1wk", labelMode: "date" },
};

function isMarketRange(value: string | null): value is MarketRange {
  return value === "1d" || value === "5d" || value === "1mo" || value === "6mo" || value === "1y";
}

function formatChartLabel(timestampSec: number, mode: "time" | "date"): string {
  const date = new Date(timestampSec * 1000);
  if (mode === "time") {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

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

async function fetchChart(symbol: string, marketRange: MarketRange): Promise<ChartPoint[]> {
  const config = RANGE_CONFIG[marketRange];
  const params = new URLSearchParams({
    range: config.range,
    interval: config.interval,
  });
  if (config.includePrePost) params.set("includePrePost", "false");

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params.toString()}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];

  const chartData = await res.json();
  const result = chartData?.chart?.result?.[0];
  const timestamps: number[] = result?.timestamp || [];
  const closes: Array<number | null> = result?.indicators?.quote?.[0]?.close || [];

  return timestamps
    .map((timestamp, index) => {
      const price = closes[index];
      if (price == null || !Number.isFinite(price)) return null;
      return {
        time: timestamp,
        price,
        label: formatChartLabel(timestamp, config.labelMode),
      };
    })
    .filter((point): point is ChartPoint => point !== null);
}

/**
 * GET /api/markets?symbols=AAPL,MSFT,GOOGL
 * GET /api/markets?view=movers
 * GET /api/markets?search=TSLA&range=6mo
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const view = url.searchParams.get("view");
    const symbols = url.searchParams.get("symbols");
    const search = url.searchParams.get("search");
    const rangeParam = url.searchParams.get("range");
    const marketRange: MarketRange = isMarketRange(rangeParam) ? rangeParam : "1d";

    if (view === "movers") {
      const [gainers, losers] = await Promise.all([
        fetchMovers("gainers"),
        fetchMovers("losers"),
      ]);
      return NextResponse.json({ gainers, losers });
    }

    if (search) {
      const upper = search.toUpperCase();
      const [quote, chart] = await Promise.all([
        fetchQuote(upper),
        fetchChart(upper, marketRange),
      ]);
      if (!quote) return NextResponse.json({ error: "Symbol not found" }, { status: 404 });
      return NextResponse.json({ quote, chart, range: marketRange });
    }

    if (symbols) {
      const list = symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);
      const quotes: QuoteData[] = [];
      for (let i = 0; i < list.length; i += 5) {
        const batch = list.slice(i, i + 5);
        const results = await Promise.all(batch.map(fetchQuote));
        for (const result of results) {
          if (result) quotes.push(result);
        }
      }
      return NextResponse.json({ quotes });
    }

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
