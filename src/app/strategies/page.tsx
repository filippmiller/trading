"use client";

import React, { useEffect, useState, useCallback } from "react";
import { BarChart3, TrendingUp, TrendingDown, Zap, RefreshCw, Shield } from "lucide-react";

type StrategyStats = {
  total_signals: number;
  wins: number;
  losses: number;
  open_positions: number;
  closed_trades: number;
  win_rate: number;
  total_pnl_usd: number;
  avg_pnl_pct: number;
  best_trade_pct: number;
  worst_trade_pct: number;
};

type StrategyData = {
  id: number;
  name: string;
  strategy_type: string;
  leverage: number;
  enabled: boolean;
  account: {
    initial_cash: number;
    cash: number;
    equity: number;
    return_pct: number;
  };
  stats: StrategyStats;
};

export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<StrategyData[]>([]);
  const [grouped, setGrouped] = useState<Record<string, StrategyData[]>>({});
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"ranking" | "grouped">("ranking");

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/strategies");
      const data = await res.json();
      setStrategies(data.strategies || []);
      setGrouped(data.grouped || {});
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Sort by total P&L descending
  const ranked = [...strategies].sort((a, b) => b.stats.total_pnl_usd - a.stats.total_pnl_usd);

  const pnlColor = (v: number) => v >= 0 ? "text-emerald-600" : "text-rose-600";
  const pnlSign = (v: number) => v >= 0 ? "+" : "";
  const fmtUsd = (v: number) => `${pnlSign(v)}$${Math.abs(v).toFixed(0)}`;
  const fmtPct = (v: number) => `${pnlSign(v)}${v.toFixed(2)}%`;

  if (loading) {
    return <div className="flex items-center justify-center h-96 text-zinc-400">Loading strategies...</div>;
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-20">
      {/* Header */}
      <div className="border-b pb-4 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 flex items-center gap-3">
            <BarChart3 className="text-indigo-500 h-8 w-8" />
            Strategy Scenarios
          </h1>
          <p className="text-zinc-500 mt-1">
            8 strategies × 3 leverage tiers = 24 parallel scenarios
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setView(view === "ranking" ? "grouped" : "ranking")}
            className="px-3 py-2 text-sm bg-zinc-100 hover:bg-zinc-200 rounded-lg"
          >
            {view === "ranking" ? "By Strategy" : "Ranking"}
          </button>
          <button onClick={loadData} className="flex items-center gap-1 px-3 py-2 text-sm bg-zinc-100 hover:bg-zinc-200 rounded-lg">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Top 3 KPI Cards */}
      {ranked.length >= 3 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {ranked.slice(0, 3).map((s, i) => (
            <div key={s.id} className={`rounded-xl p-5 ring-1 shadow-sm ${
              i === 0 ? "bg-gradient-to-br from-amber-50 to-amber-100/50 ring-amber-200"
              : i === 1 ? "bg-gradient-to-br from-zinc-50 to-zinc-100/50 ring-zinc-200"
              : "bg-gradient-to-br from-orange-50 to-orange-100/50 ring-orange-200"
            }`}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-2xl font-bold">{i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉"}</span>
                <div>
                  <p className="font-bold text-zinc-900">{s.name}</p>
                  <p className="text-xs text-zinc-500">{s.leverage}x leverage</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div>
                  <p className="text-[10px] text-zinc-400 uppercase">Total P&L</p>
                  <p className={`text-xl font-bold ${pnlColor(s.stats.total_pnl_usd)}`}>{fmtUsd(s.stats.total_pnl_usd)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-400 uppercase">Win Rate</p>
                  <p className="text-xl font-bold">{s.stats.win_rate.toFixed(0)}%</p>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-400 uppercase">Trades</p>
                  <p className="text-lg font-mono">{s.stats.closed_trades}</p>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-400 uppercase">Avg Return</p>
                  <p className={`text-lg font-mono ${pnlColor(s.stats.avg_pnl_pct)}`}>{fmtPct(s.stats.avg_pnl_pct)}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Main Content */}
      {view === "ranking" ? (
        /* Ranking Table */
        <div className="bg-white rounded-xl ring-1 ring-zinc-200/50 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-400 text-xs uppercase bg-zinc-50 border-b">
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Strategy</th>
                <th className="px-4 py-3">Lev</th>
                <th className="px-4 py-3 text-right">Trades</th>
                <th className="px-4 py-3 text-right">Win%</th>
                <th className="px-4 py-3 text-right">Total P&L</th>
                <th className="px-4 py-3 text-right">Avg %</th>
                <th className="px-4 py-3 text-right">Best</th>
                <th className="px-4 py-3 text-right">Worst</th>
                <th className="px-4 py-3 text-right">Open</th>
                <th className="px-4 py-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((s, i) => (
                <tr key={s.id} className={`border-b border-zinc-50 hover:bg-zinc-50/50 ${
                  s.stats.total_pnl_usd > 0 ? "" : "opacity-75"
                }`}>
                  <td className="px-4 py-3 font-mono text-zinc-400">{i + 1}</td>
                  <td className="px-4 py-3 font-bold text-zinc-900">{s.name}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                      s.leverage === 10 ? "bg-rose-100 text-rose-700"
                      : s.leverage === 5 ? "bg-amber-100 text-amber-700"
                      : "bg-zinc-100 text-zinc-600"
                    }`}>
                      {s.leverage}x
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{s.stats.closed_trades}</td>
                  <td className="px-4 py-3 text-right font-mono">{s.stats.win_rate.toFixed(1)}%</td>
                  <td className={`px-4 py-3 text-right font-bold ${pnlColor(s.stats.total_pnl_usd)}`}>
                    {fmtUsd(s.stats.total_pnl_usd)}
                  </td>
                  <td className={`px-4 py-3 text-right font-mono ${pnlColor(s.stats.avg_pnl_pct)}`}>
                    {fmtPct(s.stats.avg_pnl_pct)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-600">
                    {s.stats.best_trade_pct > 0 ? `+${s.stats.best_trade_pct.toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-rose-600">
                    {s.stats.worst_trade_pct < 0 ? `${s.stats.worst_trade_pct.toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {s.stats.open_positions > 0 ? (
                      <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs font-bold">
                        {s.stats.open_positions}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {s.stats.total_pnl_usd > 0 ? (
                      <TrendingUp className="h-4 w-4 text-emerald-500 inline" />
                    ) : s.stats.total_pnl_usd < 0 ? (
                      <TrendingDown className="h-4 w-4 text-rose-500 inline" />
                    ) : (
                      <Shield className="h-4 w-4 text-zinc-300 inline" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        /* Grouped by Strategy */
        <div className="space-y-6">
          {Object.entries(grouped).map(([baseName, variants]) => (
            <div key={baseName} className="bg-white rounded-xl ring-1 ring-zinc-200/50 shadow-sm p-5">
              <h3 className="text-lg font-bold text-zinc-900 mb-3 flex items-center gap-2">
                <Zap className="h-5 w-5 text-indigo-500" />
                {baseName}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {variants.sort((a, b) => a.leverage - b.leverage).map(s => (
                  <div key={s.id} className={`rounded-lg p-4 ring-1 ${
                    s.stats.total_pnl_usd > 0 ? "ring-emerald-200 bg-emerald-50/30" : "ring-zinc-200 bg-zinc-50/30"
                  }`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                        s.leverage === 10 ? "bg-rose-100 text-rose-700"
                        : s.leverage === 5 ? "bg-amber-100 text-amber-700"
                        : "bg-zinc-100 text-zinc-600"
                      }`}>
                        {s.leverage}x
                      </span>
                      <span className={`text-lg font-bold ${pnlColor(s.stats.total_pnl_usd)}`}>
                        {fmtUsd(s.stats.total_pnl_usd)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs text-zinc-600">
                      <div>Trades: <b>{s.stats.closed_trades}</b></div>
                      <div>Win: <b>{s.stats.win_rate.toFixed(0)}%</b></div>
                      <div>Avg: <b className={pnlColor(s.stats.avg_pnl_pct)}>{fmtPct(s.stats.avg_pnl_pct)}</b></div>
                      <div>Open: <b>{s.stats.open_positions}</b></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Legend */}
      <div className="text-xs text-zinc-400 text-center space-y-1">
        <p>Results include backtest (historical) + live signals. Backtest uses d1-d5 close prices from reversal matrix.</p>
        <p>Leverage amplifies both gains and losses. 10x means $1000 invested controls $10,000 of exposure.</p>
      </div>
    </div>
  );
}
