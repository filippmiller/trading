"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, RefreshCw, Search, Star, TrendingDown, TrendingUp, X } from "lucide-react";

type Quote = {
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

type ChartPoint = {
  time: number;
  price: number;
  label: string;
};

type MarketRange = "1d" | "5d" | "1mo" | "6mo" | "1y";

const RANGE_OPTIONS: Array<{ key: MarketRange; label: string }> = [
  { key: "1d", label: "1D" },
  { key: "5d", label: "5D" },
  { key: "1mo", label: "1M" },
  { key: "6mo", label: "6M" },
  { key: "1y", label: "1Y" },
];

function PriceChart({
  data,
  range,
}: {
  data: ChartPoint[];
  range: MarketRange;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const chart = useMemo(() => {
    const width = 820;
    const height = 300;
    const padding = { top: 20, right: 24, bottom: 36, left: 20 };
    const usableWidth = width - padding.left - padding.right;
    const usableHeight = height - padding.top - padding.bottom;
    const prices = data.map((point) => point.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const rangeValue = Math.max(max - min, 0.01);
    const startPrice = data[0]?.price ?? 0;
    const endPrice = data[data.length - 1]?.price ?? 0;
    const trendUp = endPrice >= startPrice;

    const points = data.map((point, index) => {
      const x = padding.left + (index / Math.max(data.length - 1, 1)) * usableWidth;
      const y = padding.top + ((max - point.price) / rangeValue) * usableHeight;
      return { ...point, x, y };
    });

    const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");
    const area = `${padding.left},${height - padding.bottom} ${polyline} ${padding.left + usableWidth},${height - padding.bottom}`;

    return {
      width,
      height,
      padding,
      usableWidth,
      usableHeight,
      min,
      max,
      trendUp,
      points,
      polyline,
      area,
    };
  }, [data]);

  const hoveredPoint = hoverIndex != null ? chart.points[hoverIndex] : null;
  const color = chart.trendUp ? "#059669" : "#dc2626";

  if (data.length < 2) {
    return <div className="rounded-2xl bg-zinc-50 px-4 py-12 text-center text-sm text-zinc-400">No chart data for this range.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>{range.toUpperCase()} view</span>
        {hoveredPoint ? (
          <span className="font-semibold text-zinc-700">
            {hoveredPoint.label} · ${hoveredPoint.price.toFixed(2)}
          </span>
        ) : (
          <span>Hover for exact values</span>
        )}
      </div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          className="w-full min-w-[640px] rounded-2xl bg-zinc-50"
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id="marketAreaGradient" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {[0, 0.5, 1].map((position) => {
            const y = chart.padding.top + position * chart.usableHeight;
            const value = chart.max - (chart.max - chart.min) * position;
            return (
              <g key={position}>
                <line x1={chart.padding.left} x2={chart.width - chart.padding.right} y1={y} y2={y} stroke="#e4e4e7" strokeDasharray="4 4" />
                <text x={chart.width - chart.padding.right + 4} y={y + 4} fontSize="10" fill="#71717a">
                  {value.toFixed(2)}
                </text>
              </g>
            );
          })}

          <polygon points={chart.area} fill="url(#marketAreaGradient)" />
          <polyline fill="none" stroke={color} strokeWidth="3" points={chart.polyline} strokeLinejoin="round" strokeLinecap="round" />

          {chart.points.map((point, index) => (
            <g key={point.time}>
              <rect
                x={index === 0 ? chart.padding.left : (chart.points[index - 1].x + point.x) / 2}
                y={0}
                width={index === chart.points.length - 1 ? chart.width - point.x - chart.padding.right : Math.max(((chart.points[index + 1].x + point.x) / 2) - (index === 0 ? chart.padding.left : (chart.points[index - 1].x + point.x) / 2), 10)}
                height={chart.height}
                fill="transparent"
                onMouseEnter={() => setHoverIndex(index)}
              />
              {hoverIndex === index && (
                <>
                  <line x1={point.x} x2={point.x} y1={chart.padding.top} y2={chart.height - chart.padding.bottom} stroke={color} strokeDasharray="4 4" />
                  <circle cx={point.x} cy={point.y} r="4" fill={color} />
                </>
              )}
            </g>
          ))}

          {chart.points.filter((_, index) => {
            const step = Math.max(Math.floor(chart.points.length / 6), 1);
            return index % step === 0 || index === chart.points.length - 1;
          }).map((point) => (
            <text key={`label-${point.time}`} x={point.x} y={chart.height - 12} textAnchor="middle" fontSize="10" fill="#71717a">
              {point.label}
            </text>
          ))}
        </svg>
      </div>
      <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-xs text-zinc-500">
        The chart uses live Yahoo Finance data. `1D` shows 5-minute bars, `5D` shows 15-minute bars, and longer ranges aggregate into daily or weekly points.
      </div>
    </div>
  );
}

export default function MarketsPage() {
  const [indices, setIndices] = useState<Quote[]>([]);
  const [gainers, setGainers] = useState<Quote[]>([]);
  const [losers, setLosers] = useState<Quote[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResult, setSearchResult] = useState<Quote | null>(null);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [searching, setSearching] = useState(false);
  const [watchlist, setWatchlist] = useState<Quote[]>([]);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [selectedRange, setSelectedRange] = useState<MarketRange>("1d");
  const [activeSymbol, setActiveSymbol] = useState<string | null>(null);
  const [watchSymbols, setWatchSymbols] = useState<string[]>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("watchlist");
      return saved ? JSON.parse(saved) : ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA"];
    }
    return ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA"];
  });
  const [lastUpdate, setLastUpdate] = useState("");
  const [error, setError] = useState("");

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    setError("");
    try {
      const res = await fetch("/api/markets");
      const data = await res.json();
      setIndices(data.indices || []);
      setGainers(data.gainers || []);
      setLosers(data.losers || []);
      setLastUpdate(new Date().toLocaleTimeString());
    } catch {
      setError("Failed to load live market overview.");
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const runSearch = useCallback(async (symbolOrTerm: string, range: MarketRange = selectedRange) => {
    const term = symbolOrTerm.trim().toUpperCase();
    if (!term) return;
    setSearching(true);
    setError("");
    setSearchTerm(term);
    setActiveSymbol(term);
    setSearchResult(null);
    setChartData([]);
    try {
      const res = await fetch(`/api/markets?search=${encodeURIComponent(term)}&range=${range}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Symbol not found.");
      } else {
        setSearchResult(data.quote);
        setChartData(data.chart || []);
        setSelectedRange(data.range || range);
        setLastUpdate(new Date().toLocaleTimeString());
      }
    } catch {
      setError("Search failed.");
    } finally {
      setSearching(false);
    }
  }, [selectedRange]);

  // Auto-refresh cadence is market-aware so we don't burn Yahoo quota on
  // unchanging weekend data. Regular session → 30s, pre/after-hours → 90s,
  // market closed → manual refresh only. Previously a flat 60s interval fired
  // around the clock, producing 1440 req/day even when price data was frozen.
  useEffect(() => {
    void loadOverview();
    const computeDelay = () => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date());
      const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
      const mins = Number(parts.find(p => p.type === 'hour')?.value ?? 0) * 60
                 + Number(parts.find(p => p.type === 'minute')?.value ?? 0);
      if (['Sat', 'Sun'].includes(weekday)) return null;
      if (mins >= 570 && mins < 960) return 30_000;       // 09:30–16:00 regular
      if (mins >= 240 && mins < 570) return 90_000;       // 04:00–09:30 pre
      if (mins >= 960 && mins < 1200) return 90_000;      // 16:00–20:00 after
      return null;                                        // overnight closed
    };
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      const delay = computeDelay();
      if (delay == null) return;
      timeoutId = setTimeout(async () => {
        await loadOverview();
        schedule();
      }, delay);
    };
    schedule();
    return () => { if (timeoutId) clearTimeout(timeoutId); };
  }, [loadOverview]);

  useEffect(() => {
    if (watchSymbols.length === 0) {
      setWatchlist([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/markets?symbols=${watchSymbols.join(",")}`);
        const data = await res.json();
        if (!cancelled) setWatchlist(data.quotes || []);
      } catch {
        if (!cancelled) setWatchlist([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [watchSymbols]);

  const addToWatchlist = (symbol: string) => {
    if (watchSymbols.includes(symbol)) return;
    const updated = [...watchSymbols, symbol];
    setWatchSymbols(updated);
    localStorage.setItem("watchlist", JSON.stringify(updated));
  };

  const removeFromWatchlist = (symbol: string) => {
    const updated = watchSymbols.filter((s) => s !== symbol);
    setWatchSymbols(updated);
    localStorage.setItem("watchlist", JSON.stringify(updated));
    setWatchlist((prev) => prev.filter((quote) => quote.symbol !== symbol));
  };

  const pnlColor = (value: number) => value >= 0 ? "text-emerald-600" : "text-rose-600";
  const pnlBg = (value: number) => value >= 0 ? "bg-emerald-500" : "bg-rose-500";
  const fmtVol = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(1)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(0)}K` : String(value);
  const fmtCap = (value: number) => value >= 1e12 ? `$${(value / 1e12).toFixed(2)}T` : value >= 1e9 ? `$${(value / 1e9).toFixed(1)}B` : value >= 1e6 ? `$${(value / 1e6).toFixed(0)}M` : "";

  const indexNames: Record<string, string> = { "^GSPC": "S&P 500", "^IXIC": "NASDAQ", "^DJI": "DOW 30", "^VIX": "VIX" };
  const quickSearchSymbols = ["SPY", "QQQ", "NVDA", "AAPL", "TSLA", "META"];

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-20">
      <div className="border-b pb-4 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 flex items-center gap-3">
            <BarChart3 className="text-blue-500 h-8 w-8" />
            Markets
          </h1>
          <p className="text-zinc-500 mt-1">Live stock lookup, multi-range price charts, watchlists, and movers without the Yahoo Finance ad clutter.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span>Updated: {lastUpdate || "..."}</span>
          <button
            onClick={() => void loadOverview()}
            className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1 text-zinc-500 hover:bg-zinc-200"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        </div>
      </div>

      {!overviewLoading && indices.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {indices.map((idx) => (
            <div key={idx.symbol} className="bg-white rounded-xl p-4 ring-1 ring-zinc-200/50 shadow-sm">
              <p className="text-xs text-zinc-400 font-bold uppercase">{indexNames[idx.symbol] || idx.symbol}</p>
              <p className="text-2xl font-bold mt-1">{idx.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
              <p className={`text-sm font-bold ${pnlColor(idx.change)}`}>
                {idx.change >= 0 ? "+" : ""}{idx.change.toFixed(2)} ({idx.changePct >= 0 ? "+" : ""}{idx.changePct.toFixed(2)}%)
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="bg-white rounded-xl p-5 ring-1 ring-zinc-200/50 shadow-sm">
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && void runSearch(searchTerm)}
              placeholder="Search ticker... AAPL, TSLA, MSFT"
              className="w-full pl-10 pr-4 py-2 border rounded-lg text-sm font-mono"
            />
          </div>
          <button onClick={() => void runSearch(searchTerm)} disabled={searching} className="px-5 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg font-bold text-sm disabled:opacity-50">
            {searching ? "..." : "Search"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {quickSearchSymbols.map((symbol) => (
            <button
              key={symbol}
              onClick={() => void runSearch(symbol)}
              className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-600 hover:bg-zinc-200"
            >
              {symbol}
            </button>
          ))}
        </div>
        {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

        {searchResult && (
          <div className="mt-4 border-t pt-4 space-y-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="text-2xl font-bold">{searchResult.symbol}</h2>
                  <span className="text-zinc-500">{searchResult.name}</span>
                  <button onClick={() => addToWatchlist(searchResult.symbol)} className="text-xs text-blue-500 hover:underline flex items-center gap-1">
                    <Star className="h-3 w-3" /> Add to watchlist
                  </button>
                </div>
                <div className="flex items-baseline gap-3 mt-1">
                  <span className="text-3xl font-bold">${searchResult.price.toFixed(2)}</span>
                  <span className={`text-lg font-bold ${pnlColor(searchResult.change)}`}>
                    {searchResult.change >= 0 ? "+" : ""}{searchResult.change.toFixed(2)} ({searchResult.changePct >= 0 ? "+" : ""}{searchResult.changePct.toFixed(2)}%)
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-zinc-500">
                <div>Open: <b className="text-zinc-700">${searchResult.open.toFixed(2)}</b></div>
                <div>High: <b className="text-zinc-700">${searchResult.high.toFixed(2)}</b></div>
                <div>Low: <b className="text-zinc-700">${searchResult.low.toFixed(2)}</b></div>
                <div>Vol: <b className="text-zinc-700">{fmtVol(searchResult.volume)}</b></div>
                <div>Prev Close: <b className="text-zinc-700">${searchResult.prevClose.toFixed(2)}</b></div>
                {searchResult.marketCap > 0 && <div>Cap: <b className="text-zinc-700">{fmtCap(searchResult.marketCap)}</b></div>}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {RANGE_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  onClick={() => {
                    setSelectedRange(option.key);
                    if (activeSymbol) void runSearch(activeSymbol, option.key);
                  }}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                    selectedRange === option.key
                      ? "bg-zinc-900 text-white"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <PriceChart data={chartData} range={selectedRange} />
          </div>
        )}
      </div>

      {watchlist.length > 0 ? (
        <div className="bg-white rounded-xl ring-1 ring-zinc-200/50 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b bg-zinc-50 flex items-center justify-between">
            <h3 className="font-bold text-zinc-800 flex items-center gap-2"><Star className="h-4 w-4 text-amber-500" /> Watchlist</h3>
            <button onClick={() => void loadOverview()} className="text-xs text-zinc-400 hover:text-zinc-600 flex items-center gap-1">
              <RefreshCw className="h-3 w-3" /> Refresh
            </button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-zinc-400 uppercase border-b">
                <th className="px-4 py-2 text-left">Symbol</th>
                <th className="px-4 py-2 text-left">Name</th>
                <th className="px-4 py-2 text-right">Price</th>
                <th className="px-4 py-2 text-right">Change</th>
                <th className="px-4 py-2 text-right">%</th>
                <th className="px-4 py-2 text-right">Volume</th>
                <th className="px-4 py-2 text-right">Cap</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {watchlist.map((quote) => (
                <tr key={quote.symbol} className="border-b border-zinc-50 hover:bg-zinc-50/50">
                  <td className="px-4 py-2.5 font-bold cursor-pointer text-blue-600 hover:underline" onClick={() => void runSearch(quote.symbol)}>
                    {quote.symbol}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500 max-w-[200px] truncate">{quote.name}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold">${quote.price.toFixed(2)}</td>
                  <td className={`px-4 py-2.5 text-right font-mono ${pnlColor(quote.change)}`}>
                    {quote.change >= 0 ? "+" : ""}{quote.change.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold text-white ${pnlBg(quote.changePct)}`}>
                      {quote.changePct >= 0 ? "+" : ""}{quote.changePct.toFixed(2)}%
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-500">{fmtVol(quote.volume)}</td>
                  <td className="px-4 py-2.5 text-right text-zinc-500">{fmtCap(quote.marketCap)}</td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => removeFromWatchlist(quote.symbol)} className="text-zinc-300 hover:text-rose-500">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white/70 p-5 text-sm text-zinc-500">
          Your watchlist is empty. Search for any ticker and add it to keep a quick live monitor here.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl ring-1 ring-zinc-200/50 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b bg-emerald-50 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-emerald-600" />
            <h3 className="font-bold text-emerald-800">Top Gainers</h3>
          </div>
          <div className="divide-y divide-zinc-50">
            {gainers.map((quote) => (
              <div key={quote.symbol} className="px-4 py-2.5 flex items-center justify-between hover:bg-zinc-50/50 cursor-pointer" onClick={() => void runSearch(quote.symbol)}>
                <div className="flex items-center gap-3">
                  <span className="font-bold text-sm w-16">{quote.symbol}</span>
                  <span className="text-xs text-zinc-400 max-w-[120px] truncate">{quote.name}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm">${quote.price.toFixed(2)}</span>
                  <span className="px-2 py-0.5 rounded text-xs font-bold text-white bg-emerald-500 min-w-[60px] text-center">
                    +{quote.changePct.toFixed(1)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl ring-1 ring-zinc-200/50 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b bg-rose-50 flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-rose-600" />
            <h3 className="font-bold text-rose-800">Top Losers</h3>
          </div>
          <div className="divide-y divide-zinc-50">
            {losers.map((quote) => (
              <div key={quote.symbol} className="px-4 py-2.5 flex items-center justify-between hover:bg-zinc-50/50 cursor-pointer" onClick={() => void runSearch(quote.symbol)}>
                <div className="flex items-center gap-3">
                  <span className="font-bold text-sm w-16">{quote.symbol}</span>
                  <span className="text-xs text-zinc-400 max-w-[120px] truncate">{quote.name}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm">${quote.price.toFixed(2)}</span>
                  <span className="px-2 py-0.5 rounded text-xs font-bold text-white bg-rose-500 min-w-[60px] text-center">
                    {quote.changePct.toFixed(1)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
