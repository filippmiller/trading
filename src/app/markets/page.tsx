"use client";

import React, { useEffect, useState } from "react";
import { Search, TrendingUp, TrendingDown, BarChart3, RefreshCw, Star, X } from "lucide-react";

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

type ChartPoint = { time: number; price: number };

export default function MarketsPage() {
  const [indices, setIndices] = useState<Quote[]>([]);
  const [gainers, setGainers] = useState<Quote[]>([]);
  const [losers, setLosers] = useState<Quote[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResult, setSearchResult] = useState<Quote | null>(null);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [searching, setSearching] = useState(false);
  const [watchlist, setWatchlist] = useState<Quote[]>([]);
  const [watchSymbols, setWatchSymbols] = useState<string[]>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("watchlist");
      return saved ? JSON.parse(saved) : ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA"];
    }
    return ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA"];
  });
  const [lastUpdate, setLastUpdate] = useState("");

  // Load market overview
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/markets");
        const data = await res.json();
        if (!cancelled) {
          setIndices(data.indices || []);
          setGainers(data.gainers || []);
          setLosers(data.losers || []);
          setLastUpdate(new Date().toLocaleTimeString());
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load watchlist prices
  useEffect(() => {
    if (watchSymbols.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/markets?symbols=${watchSymbols.join(",")}`);
        const data = await res.json();
        if (!cancelled) setWatchlist(data.quotes || []);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [watchSymbols]);

  const handleSearch = async () => {
    if (!searchTerm.trim()) return;
    setSearching(true);
    setSearchResult(null);
    setChartData([]);
    try {
      const res = await fetch(`/api/markets?search=${encodeURIComponent(searchTerm.trim())}`);
      if (res.ok) {
        const data = await res.json();
        setSearchResult(data.quote);
        setChartData(data.chart || []);
      }
    } catch { /* ignore */ }
    setSearching(false);
  };

  const addToWatchlist = (symbol: string) => {
    if (watchSymbols.includes(symbol)) return;
    const updated = [...watchSymbols, symbol];
    setWatchSymbols(updated);
    localStorage.setItem("watchlist", JSON.stringify(updated));
  };

  const removeFromWatchlist = (symbol: string) => {
    const updated = watchSymbols.filter(s => s !== symbol);
    setWatchSymbols(updated);
    localStorage.setItem("watchlist", JSON.stringify(updated));
    setWatchlist(prev => prev.filter(q => q.symbol !== symbol));
  };

  const pnlColor = (v: number) => v >= 0 ? "text-emerald-600" : "text-rose-600";
  const pnlBg = (v: number) => v >= 0 ? "bg-emerald-500" : "bg-rose-500";
  const fmtVol = (v: number) => v >= 1e9 ? `${(v/1e9).toFixed(1)}B` : v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : v >= 1e3 ? `${(v/1e3).toFixed(0)}K` : String(v);
  const fmtCap = (v: number) => v >= 1e12 ? `$${(v/1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v/1e6).toFixed(0)}M` : "";

  // Mini sparkline SVG
  const Sparkline = ({ data, width = 120, height = 32 }: { data: ChartPoint[]; width?: number; height?: number }) => {
    if (data.length < 2) return null;
    const prices = data.map(d => d.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    const points = prices.map((p, i) => `${(i / (prices.length - 1)) * width},${height - ((p - min) / range) * height}`).join(" ");
    const color = prices[prices.length - 1] >= prices[0] ? "#10b981" : "#ef4444";
    return (
      <svg width={width} height={height} className="inline-block">
        <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
      </svg>
    );
  };

  const indexNames: Record<string, string> = { "^GSPC": "S&P 500", "^IXIC": "NASDAQ", "^DJI": "DOW 30", "^VIX": "VIX" };

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-20">
      {/* Header */}
      <div className="border-b pb-4 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 flex items-center gap-3">
            <BarChart3 className="text-blue-500 h-8 w-8" />
            Markets
          </h1>
          <p className="text-zinc-500 mt-1">Live stock data from Yahoo Finance — no ads, no noise</p>
        </div>
        <div className="text-xs text-zinc-400">Updated: {lastUpdate || "..."}</div>
      </div>

      {/* Market Indices */}
      {indices.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {indices.map(idx => (
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

      {/* Search */}
      <div className="bg-white rounded-xl p-5 ring-1 ring-zinc-200/50 shadow-sm">
        <div className="flex gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === "Enter" && handleSearch()}
              placeholder="Search ticker... AAPL, TSLA, MSFT"
              className="w-full pl-10 pr-4 py-2 border rounded-lg text-sm font-mono"
            />
          </div>
          <button onClick={handleSearch} disabled={searching} className="px-5 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg font-bold text-sm disabled:opacity-50">
            {searching ? "..." : "Search"}
          </button>
        </div>

        {/* Search Result */}
        {searchResult && (
          <div className="mt-4 border-t pt-4">
            <div className="flex items-start justify-between">
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
              <div className="text-right text-sm text-zinc-500 space-y-1">
                <div>Open: <b className="text-zinc-700">${searchResult.open.toFixed(2)}</b></div>
                <div>High: <b className="text-zinc-700">${searchResult.high.toFixed(2)}</b></div>
                <div>Low: <b className="text-zinc-700">${searchResult.low.toFixed(2)}</b></div>
                <div>Vol: <b className="text-zinc-700">{fmtVol(searchResult.volume)}</b></div>
                {searchResult.marketCap > 0 && <div>Cap: <b className="text-zinc-700">{fmtCap(searchResult.marketCap)}</b></div>}
              </div>
            </div>
            {/* Intraday Chart */}
            {chartData.length > 2 && (
              <div className="mt-4 bg-zinc-50 rounded-lg p-4">
                <Sparkline data={chartData} width={700} height={120} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Watchlist */}
      {watchlist.length > 0 && (
        <div className="bg-white rounded-xl ring-1 ring-zinc-200/50 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b bg-zinc-50 flex items-center justify-between">
            <h3 className="font-bold text-zinc-800 flex items-center gap-2"><Star className="h-4 w-4 text-amber-500" /> Watchlist</h3>
            <button onClick={() => { setWatchlist([]); setTimeout(() => { const s = watchSymbols; setWatchSymbols([]); setTimeout(() => setWatchSymbols(s), 50); }, 50); }} className="text-xs text-zinc-400 hover:text-zinc-600 flex items-center gap-1">
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
              {watchlist.map(q => (
                <tr key={q.symbol} className="border-b border-zinc-50 hover:bg-zinc-50/50">
                  <td className="px-4 py-2.5 font-bold cursor-pointer text-blue-600 hover:underline" onClick={() => { setSearchTerm(q.symbol); setSearchResult(q); }}>
                    {q.symbol}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500 max-w-[200px] truncate">{q.name}</td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold">${q.price.toFixed(2)}</td>
                  <td className={`px-4 py-2.5 text-right font-mono ${pnlColor(q.change)}`}>
                    {q.change >= 0 ? "+" : ""}{q.change.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold text-white ${pnlBg(q.changePct)}`}>
                      {q.changePct >= 0 ? "+" : ""}{q.changePct.toFixed(2)}%
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-zinc-500">{fmtVol(q.volume)}</td>
                  <td className="px-4 py-2.5 text-right text-zinc-500">{fmtCap(q.marketCap)}</td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => removeFromWatchlist(q.symbol)} className="text-zinc-300 hover:text-rose-500">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Top Movers */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Gainers */}
        <div className="bg-white rounded-xl ring-1 ring-zinc-200/50 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b bg-emerald-50 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-emerald-600" />
            <h3 className="font-bold text-emerald-800">Top Gainers</h3>
          </div>
          <div className="divide-y divide-zinc-50">
            {gainers.map(q => (
              <div key={q.symbol} className="px-4 py-2.5 flex items-center justify-between hover:bg-zinc-50/50 cursor-pointer" onClick={() => { setSearchTerm(q.symbol); setSearchResult(q); }}>
                <div className="flex items-center gap-3">
                  <span className="font-bold text-sm w-16">{q.symbol}</span>
                  <span className="text-xs text-zinc-400 max-w-[120px] truncate">{q.name}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm">${q.price.toFixed(2)}</span>
                  <span className="px-2 py-0.5 rounded text-xs font-bold text-white bg-emerald-500 min-w-[60px] text-center">
                    +{q.changePct.toFixed(1)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Losers */}
        <div className="bg-white rounded-xl ring-1 ring-zinc-200/50 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b bg-rose-50 flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-rose-600" />
            <h3 className="font-bold text-rose-800">Top Losers</h3>
          </div>
          <div className="divide-y divide-zinc-50">
            {losers.map(q => (
              <div key={q.symbol} className="px-4 py-2.5 flex items-center justify-between hover:bg-zinc-50/50 cursor-pointer" onClick={() => { setSearchTerm(q.symbol); setSearchResult(q); }}>
                <div className="flex items-center gap-3">
                  <span className="font-bold text-sm w-16">{q.symbol}</span>
                  <span className="text-xs text-zinc-400 max-w-[120px] truncate">{q.name}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm">${q.price.toFixed(2)}</span>
                  <span className="px-2 py-0.5 rounded text-xs font-bold text-white bg-rose-500 min-w-[60px] text-center">
                    {q.changePct.toFixed(1)}%
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
