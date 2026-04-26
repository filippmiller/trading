"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Activity, BarChart3, DollarSign, Radar, RefreshCw, Shield, TrendingDown, TrendingUp, Zap } from "lucide-react";

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
  created_at?: string;
  account_id: number | null;
  account_name: string | null;
  config_summary: {
    entry_direction: string | null;
    trade_direction: string | null;
    enrollment_source: string | null;
    min_drop_pct: number | null;
    max_drop_pct: number | null;
    min_rise_pct: number | null;
    max_rise_pct: number | null;
    min_consecutive_days: number | null;
    max_consecutive_days: number | null;
    amount_usd: number | null;
    time_exit_days: number | null;
    hard_stop_pct: number | null;
    take_profit_pct: number | null;
    trailing_stop_pct: number | null;
  } | null;
  research: {
    source: string;
    promotion_key: string | null;
    promoted_at: string | null;
    warnings: string[];
    grid_stats: {
      n: number | null;
      win_rate: number | null;
      total_pnl_usd: number | null;
      sharpe_ratio: number | null;
      profit_factor: number | null;
    } | null;
  } | null;
  account: {
    initial_cash: number;
    cash: number;
    open_market_value: number;
    open_invested: number;
    equity: number;
    return_pct: number;
  };
  stats: StrategyStats;
};

export default function StrategiesPage() {
  const [strategies, setStrategies] = useState<StrategyData[]>([]);
  const [grouped, setGrouped] = useState<Record<string, StrategyData[]>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<"ranking" | "grouped">("ranking");
  const [sortBy, setSortBy] = useState<"equity" | "realized" | "win_rate">("equity");
  const [scope, setScope] = useState<"all" | "trading" | "confirmation" | "analysis">("all");
  const [lastUpdate, setLastUpdate] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  // Single effect handles initial load, 60s polling, and explicit refresh.
  // Failures now surface a visible error state — the previous silent `catch {}`
  // presented "0 strategies / $0 equity" indistinguishably from "DB tunnel dropped",
  // misleading users into thinking the system was actually empty.
  useEffect(() => {
    let cancelled = false;
    const loadData = async () => {
      try {
        const res = await fetch("/api/strategies");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setStrategies(data.strategies || []);
        setGrouped(data.grouped || {});
        setLastUpdate(new Date().toLocaleTimeString());
        setLoadError(null);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    };
    void loadData();
    const interval = setInterval(loadData, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refreshKey]);

  const refresh = () => setRefreshKey((k) => k + 1);

  const visibleStrategies = useMemo(() => {
    return strategies.filter((strategy) => {
      if (scope === "all") return true;
      return strategy.strategy_type === scope.toUpperCase();
    });
  }, [scope, strategies]);

  const ranked = useMemo(() => {
    return [...visibleStrategies].sort((a, b) => {
      if (sortBy === "realized") return b.stats.total_pnl_usd - a.stats.total_pnl_usd;
      if (sortBy === "win_rate") return b.stats.win_rate - a.stats.win_rate;
      return b.account.return_pct - a.account.return_pct;
    });
  }, [sortBy, visibleStrategies]);

  const groupedVisible = useMemo(() => {
    const visibleIds = new Set(visibleStrategies.map((strategy) => strategy.id));
    return Object.entries(grouped)
      .map(([baseName, variants]) => [baseName, variants.filter((strategy) => visibleIds.has(strategy.id))] as const)
      .filter(([, variants]) => variants.length > 0);
  }, [grouped, visibleStrategies]);

  const summary = useMemo(() => {
    return visibleStrategies.reduce((acc, strategy) => {
      acc.equity += strategy.account.equity;
      acc.openMarketValue += strategy.account.open_market_value;
      acc.realizedPnl += strategy.stats.total_pnl_usd;
      acc.openPositions += strategy.stats.open_positions;
      return acc;
    }, {
      equity: 0,
      openMarketValue: 0,
      realizedPnl: 0,
      openPositions: 0,
    });
  }, [visibleStrategies]);

  const pnlColor = (value: number) => value >= 0 ? "text-emerald-600" : "text-rose-600";
  const pnlSign = (value: number) => value >= 0 ? "+" : "";
  const fmtUsd = (value: number) => `${pnlSign(value)}$${Math.abs(value).toFixed(0)}`;
  const fmtPct = (value: number) => `${pnlSign(value)}${value.toFixed(2)}%`;
  const promotedCount = visibleStrategies.filter((strategy) => strategy.research?.source === "grid_sweep").length;
  const disabledCount = visibleStrategies.filter((strategy) => !strategy.enabled).length;

  if (loading) {
    return <div className="flex items-center justify-center h-96 text-zinc-400">Loading strategies...</div>;
  }

  if (loadError) {
    return (
      <div className="max-w-xl mx-auto mt-20 rounded-xl ring-1 ring-rose-200 bg-rose-50 p-6">
        <h2 className="text-lg font-bold text-rose-700 mb-2">Failed to load strategies</h2>
        <p className="font-mono text-xs text-rose-600 mb-4">{loadError}</p>
        <button onClick={refresh} className="px-4 py-2 bg-rose-600 text-white rounded-lg text-sm font-medium hover:bg-rose-700">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-20">
      <div className="border-b pb-4 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 flex items-center gap-3">
            <BarChart3 className="text-indigo-500 h-8 w-8" />
            Strategy Dashboard
          </h1>
          <p className="text-zinc-500 mt-1">
            Compare live paper accounts across trading, confirmation, and analysis strategies.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-500">
            Updated {lastUpdate || "..."}
          </span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as "all" | "trading" | "confirmation" | "analysis")}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
          >
            <option value="all">All strategies</option>
            <option value="trading">Trading only</option>
            <option value="confirmation">Confirmation only</option>
            <option value="analysis">Analysis only</option>
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as "equity" | "realized" | "win_rate")}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
          >
            <option value="equity">Rank by return</option>
            <option value="realized">Rank by realized P&L</option>
            <option value="win_rate">Rank by win rate</option>
          </select>
          <button
            onClick={() => setView(view === "ranking" ? "grouped" : "ranking")}
            className="px-3 py-2 text-sm bg-zinc-100 hover:bg-zinc-200 rounded-lg"
          >
            {view === "ranking" ? "By Strategy" : "Ranking"}
          </button>
          <button onClick={refresh} className="flex items-center gap-1 px-3 py-2 text-sm bg-zinc-100 hover:bg-zinc-200 rounded-lg">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <SummaryCard icon={<Radar className="h-4 w-4 text-indigo-600" />} label="Visible Strategies" value={String(visibleStrategies.length)} detail={`${promotedCount} promoted · ${disabledCount} disabled`} />
        <SummaryCard icon={<DollarSign className="h-4 w-4 text-emerald-600" />} label="Aggregate Equity" value={`$${summary.equity.toFixed(0)}`} detail="Cash + marked open positions" />
        <SummaryCard icon={<TrendingUp className="h-4 w-4 text-amber-600" />} label="Realized P&L" value={fmtUsd(summary.realizedPnl)} detail="Closed paper signals only" />
        <SummaryCard icon={<Activity className="h-4 w-4 text-blue-600" />} label="Open Exposure" value={`$${summary.openMarketValue.toFixed(0)}`} detail={`${summary.openPositions} open positions`} />
      </div>

      {ranked.length >= 3 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {ranked.slice(0, 3).map((strategy, i) => (
            <div key={strategy.id} className={`rounded-xl p-5 ring-1 shadow-sm ${
              i === 0 ? "bg-gradient-to-br from-amber-50 to-amber-100/50 ring-amber-200"
                : i === 1 ? "bg-gradient-to-br from-zinc-50 to-zinc-100/50 ring-zinc-200"
                  : "bg-gradient-to-br from-orange-50 to-orange-100/50 ring-orange-200"
            }`}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-2xl font-bold">{i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉"}</span>
                <div>
                  <p className="font-bold text-zinc-900">{strategy.name}</p>
                  <p className="text-xs text-zinc-500">{strategy.leverage}x leverage</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div>
                  <p className="text-[10px] text-zinc-400 uppercase">Realized P&L</p>
                  <p className={`text-xl font-bold ${pnlColor(strategy.stats.total_pnl_usd)}`}>{fmtUsd(strategy.stats.total_pnl_usd)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-400 uppercase">Account Return</p>
                  <p className={`text-xl font-bold ${pnlColor(strategy.account.return_pct)}`}>{fmtPct(strategy.account.return_pct)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-400 uppercase">Trades</p>
                  <p className="text-lg font-mono">{strategy.stats.closed_trades}</p>
                </div>
                <div>
                  <p className="text-[10px] text-zinc-400 uppercase">Open Value</p>
                  <p className="text-lg font-mono text-zinc-800">${strategy.account.open_market_value.toFixed(0)}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {view === "ranking" ? (
        <div className="bg-white rounded-xl ring-1 ring-zinc-200/50 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-400 text-xs uppercase bg-zinc-50 border-b">
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Strategy</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Setup</th>
                <th className="px-4 py-3">Lev</th>
                <th className="px-4 py-3 text-right">Trades</th>
                <th className="px-4 py-3 text-right">Win%</th>
                <th className="px-4 py-3 text-right">Return</th>
                <th className="px-4 py-3 text-right">Equity</th>
                <th className="px-4 py-3 text-right">Total P&L</th>
                <th className="px-4 py-3 text-right">Avg %</th>
                <th className="px-4 py-3 text-right">Best</th>
                <th className="px-4 py-3 text-right">Worst</th>
                <th className="px-4 py-3 text-right">Open</th>
                <th className="px-4 py-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((strategy, i) => (
                <tr key={strategy.id} className={`border-b border-zinc-50 hover:bg-zinc-50/50 ${strategy.enabled ? "" : "bg-amber-50/30"} ${strategy.stats.total_pnl_usd > 0 || !strategy.enabled ? "" : "opacity-75"}`}>
                  <td className="px-4 py-3 font-mono text-zinc-400">{i + 1}</td>
                  <td className="px-4 py-3">
                    <div className="font-bold text-zinc-900">{strategy.name}</div>
                    {strategy.account_name && <div className="mt-0.5 text-[10px] text-zinc-400">{strategy.account_name}</div>}
                  </td>
                  <td className="px-4 py-3">
                    {strategy.research?.source === "grid_sweep" ? (
                      <div className="space-y-1">
                        <span className="inline-flex rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-bold uppercase text-violet-700 ring-1 ring-violet-100">
                          Grid Sweep
                        </span>
                        {strategy.research.grid_stats && (
                          <div className="text-[10px] text-zinc-500">
                            n={strategy.research.grid_stats.n ?? "?"} · WR {fmtNullablePct(strategy.research.grid_stats.win_rate)}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-zinc-400">Seeded</span>
                    )}
                  </td>
                  <td className="px-4 py-3 min-w-48">
                    <div className="text-xs text-zinc-700">{formatSetup(strategy.config_summary)}</div>
                    {strategy.research?.warnings?.length ? (
                      <details className="mt-1 text-[10px] text-amber-700">
                        <summary className="cursor-pointer font-semibold">{strategy.research.warnings.length} promotion warning{strategy.research.warnings.length === 1 ? "" : "s"}</summary>
                        <ul className="mt-1 list-disc space-y-1 pl-4">
                          {strategy.research.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                        </ul>
                      </details>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                      strategy.leverage === 10 ? "bg-rose-100 text-rose-700"
                        : strategy.leverage === 5 ? "bg-amber-100 text-amber-700"
                          : "bg-zinc-100 text-zinc-600"
                    }`}>
                      {strategy.leverage}x
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{strategy.stats.closed_trades}</td>
                  <td className="px-4 py-3 text-right font-mono">{strategy.stats.win_rate.toFixed(1)}%</td>
                  <td className={`px-4 py-3 text-right font-mono ${pnlColor(strategy.account.return_pct)}`}>{fmtPct(strategy.account.return_pct)}</td>
                  <td className="px-4 py-3 text-right font-mono">${strategy.account.equity.toFixed(0)}</td>
                  <td className={`px-4 py-3 text-right font-bold ${pnlColor(strategy.stats.total_pnl_usd)}`}>{fmtUsd(strategy.stats.total_pnl_usd)}</td>
                  <td className={`px-4 py-3 text-right font-mono ${pnlColor(strategy.stats.avg_pnl_pct)}`}>{fmtPct(strategy.stats.avg_pnl_pct)}</td>
                  <td className="px-4 py-3 text-right font-mono text-emerald-600">
                    {strategy.stats.best_trade_pct > 0 ? `+${strategy.stats.best_trade_pct.toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-rose-600">
                    {strategy.stats.worst_trade_pct < 0 ? `${strategy.stats.worst_trade_pct.toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {strategy.stats.open_positions > 0 ? (
                      <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-xs font-bold">
                        {strategy.stats.open_positions}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {!strategy.enabled ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-700">Disabled</span>
                    ) : strategy.account.return_pct > 0 ? (
                      <TrendingUp className="h-4 w-4 text-emerald-500 inline" />
                    ) : strategy.account.return_pct < 0 ? (
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
        <div className="space-y-6">
          {groupedVisible.map(([baseName, variants]) => (
            <div key={baseName} className="bg-white rounded-xl ring-1 ring-zinc-200/50 shadow-sm p-5">
              <h3 className="text-lg font-bold text-zinc-900 mb-3 flex items-center gap-2">
                <Zap className="h-5 w-5 text-indigo-500" />
                {baseName}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {variants.sort((a, b) => a.leverage - b.leverage).map((strategy) => (
                  <div key={strategy.id} className={`rounded-lg p-4 ring-1 ${
                    strategy.account.return_pct > 0 ? "ring-emerald-200 bg-emerald-50/30" : "ring-zinc-200 bg-zinc-50/30"
                  }`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                        strategy.leverage === 10 ? "bg-rose-100 text-rose-700"
                          : strategy.leverage === 5 ? "bg-amber-100 text-amber-700"
                            : "bg-zinc-100 text-zinc-600"
                      }`}>
                        {strategy.leverage}x
                      </span>
                      <span className={`text-lg font-bold ${pnlColor(strategy.stats.total_pnl_usd)}`}>
                        {fmtUsd(strategy.stats.total_pnl_usd)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs text-zinc-600">
                      <div>Trades: <b>{strategy.stats.closed_trades}</b></div>
                      <div>Win: <b>{strategy.stats.win_rate.toFixed(0)}%</b></div>
                      <div>Avg: <b className={pnlColor(strategy.stats.avg_pnl_pct)}>{fmtPct(strategy.stats.avg_pnl_pct)}</b></div>
                      <div>Open: <b>{strategy.stats.open_positions}</b></div>
                      <div>Return: <b className={pnlColor(strategy.account.return_pct)}>{fmtPct(strategy.account.return_pct)}</b></div>
                      <div>Equity: <b>${strategy.account.equity.toFixed(0)}</b></div>
                      {strategy.research?.source === "grid_sweep" && <div>Source: <b>Grid Sweep</b></div>}
                      {!strategy.enabled && <div>Status: <b className="text-amber-700">Disabled</b></div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-zinc-400 text-center space-y-1">
        <p>Results include backtest records plus live paper signals. Account equity uses cash plus the latest marked value of open positions.</p>
        <p>Leverage amplifies both gains and losses. 10x means $1000 invested controls $10,000 of exposure.</p>
      </div>
    </div>
  );
}

function formatSetup(config: StrategyData["config_summary"]): string {
  if (!config) return "Config unavailable";
  const cohort = config.entry_direction ?? "ANY";
  const trade = config.trade_direction ?? cohort;
  const move = config.min_drop_pct != null || config.max_drop_pct != null
    ? `${config.min_drop_pct ?? "-∞"}% to ${config.max_drop_pct ?? "∞"}% drop`
    : config.min_rise_pct != null || config.max_rise_pct != null
      ? `${config.min_rise_pct ?? 0}% to ${config.max_rise_pct ?? "∞"}% rise`
      : "any move";
  const streak = [
    config.min_consecutive_days != null ? `${config.min_consecutive_days}+ streak` : null,
    config.max_consecutive_days != null ? `max ${config.max_consecutive_days}` : null,
  ].filter(Boolean).join(", ");
  const exits = [
    config.time_exit_days != null ? `${config.time_exit_days}d` : null,
    config.hard_stop_pct != null ? `SL ${config.hard_stop_pct}%` : null,
    config.take_profit_pct != null ? `TP ${config.take_profit_pct}%` : null,
    config.trailing_stop_pct != null ? `trail ${config.trailing_stop_pct}%` : null,
  ].filter(Boolean).join(" · ");
  return `${cohort} cohort -> ${trade} · ${move}${streak ? ` · ${streak}` : ""}${exits ? ` · ${exits}` : ""}`;
}

function fmtNullablePct(value: number | null): string {
  return value == null ? "?" : `${value.toFixed(0)}%`;
}

function SummaryCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-zinc-200/60 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="rounded-xl bg-zinc-50 p-2">{icon}</div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-400">{label}</div>
      </div>
      <div className="mt-4 text-2xl font-bold text-zinc-900">{value}</div>
      <div className="mt-1 text-xs text-zinc-500">{detail}</div>
    </div>
  );
}
