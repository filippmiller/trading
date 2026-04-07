"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Activity, TrendingUp, TrendingDown, DollarSign, Clock, XCircle } from "lucide-react";

type Trade = {
  id: number;
  symbol: string;
  buy_price: number;
  buy_date: string;
  sell_date: string | null;
  sell_price: number | null;
  investment_usd: number;
  current_price: number | null;
  live_pnl_usd: number | null;
  live_pnl_pct: number | null;
  strategy: string;
  status: string;
  notes: string;
};

export default function PaperTradingPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [totalInvested, setTotalInvested] = useState(0);
  const [totalPnl, setTotalPnl] = useState(0);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [selling, setSelling] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/paper");
      const data = await res.json();
      setTrades(data.trades || []);
      setTotalInvested(data.totalInvested || 0);
      setTotalPnl(data.totalPnl || 0);
      setLastUpdate(new Date().toLocaleTimeString());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000); // refresh every 30 seconds
    return () => clearInterval(interval);
  }, [loadData]);

  const handleSell = async (trade: Trade) => {
    if (!trade.current_price) return;
    setSelling(trade.id);
    try {
      const res = await fetch("/api/paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: trade.id, sell_price: trade.current_price }),
      });
      const data = await res.json();
      if (data.success) {
        await loadData();
      }
    } catch { /* ignore */ }
    setSelling(null);
  };

  const openTrades = trades.filter(t => t.status === "OPEN");
  const closedTrades = trades.filter(t => t.status === "CLOSED");
  const closedPnl = closedTrades.reduce((s, t) => s + (t.live_pnl_usd || 0), 0);

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-20">
      {/* Header */}
      <div className="border-b pb-4">
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900 flex items-center gap-3">
          <DollarSign className="text-amber-500 h-8 w-8" />
          Paper Trading
        </h1>
        <p className="text-zinc-500 mt-1">
          Виртуальные сделки — стратегия &quot;Купить лузера &gt;7%, держать 3 дня&quot;
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl p-4 ring-1 ring-zinc-200/50 shadow-sm">
          <p className="text-[10px] text-zinc-400 uppercase font-bold">Вложено</p>
          <p className="text-2xl font-bold">${totalInvested.toFixed(0)}</p>
        </div>
        <div className="bg-white rounded-xl p-4 ring-1 ring-zinc-200/50 shadow-sm">
          <p className="text-[10px] text-zinc-400 uppercase font-bold">Live P&L</p>
          <p className={`text-2xl font-bold ${totalPnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
            {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
          </p>
        </div>
        <div className="bg-white rounded-xl p-4 ring-1 ring-zinc-200/50 shadow-sm">
          <p className="text-[10px] text-zinc-400 uppercase font-bold">Закрытые сделки P&L</p>
          <p className={`text-2xl font-bold ${closedPnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
            {closedPnl >= 0 ? "+" : ""}${closedPnl.toFixed(2)}
          </p>
        </div>
        <div className="bg-white rounded-xl p-4 ring-1 ring-zinc-200/50 shadow-sm">
          <p className="text-[10px] text-zinc-400 uppercase font-bold">Обновлено</p>
          <p className="text-lg font-mono">{lastUpdate || "..."}</p>
          <button onClick={loadData} className="text-xs text-blue-500 hover:underline mt-1">обновить</button>
        </div>
      </div>

      {/* Open Trades */}
      <div>
        <h2 className="text-lg font-bold text-zinc-800 mb-3 flex items-center gap-2">
          <Activity className="h-5 w-5 text-emerald-500" /> Открытые позиции
        </h2>
        {openTrades.length === 0 ? (
          <p className="text-zinc-400 text-sm">Нет открытых позиций</p>
        ) : (
          <div className="space-y-3">
            {openTrades.map(trade => (
              <div key={trade.id} className="bg-white rounded-xl p-4 ring-1 ring-zinc-200/50 shadow-sm">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <span className="text-xl font-bold">{trade.symbol}</span>
                      {trade.live_pnl_pct !== null && (
                        <span className={`text-lg font-bold ${trade.live_pnl_pct >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {trade.live_pnl_pct >= 0 ? "+" : ""}{trade.live_pnl_pct.toFixed(2)}%
                        </span>
                      )}
                      {trade.live_pnl_usd !== null && (
                        <span className={`text-sm ${trade.live_pnl_usd >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          ({trade.live_pnl_usd >= 0 ? "+" : ""}${trade.live_pnl_usd.toFixed(2)})
                        </span>
                      )}
                    </div>
                    <div className="flex gap-4 mt-1 text-sm text-zinc-500">
                      <span>Купил: <b className="text-zinc-700">${trade.buy_price.toFixed(2)}</b></span>
                      <span>Сейчас: <b className="text-zinc-700">{trade.current_price ? `$${trade.current_price.toFixed(2)}` : "..."}</b></span>
                      <span>Вложено: ${trade.investment_usd}</span>
                      <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> Продать до {trade.sell_date}</span>
                    </div>
                    <p className="text-xs text-zinc-400 mt-1">{trade.notes}</p>
                  </div>
                  <button
                    onClick={() => handleSell(trade)}
                    disabled={selling === trade.id || !trade.current_price}
                    className={`ml-4 px-5 py-2 rounded-lg font-bold text-sm transition-all ${
                      trade.live_pnl_pct && trade.live_pnl_pct > 0
                        ? "bg-emerald-500 hover:bg-emerald-600 text-white"
                        : "bg-rose-100 hover:bg-rose-200 text-rose-700"
                    } disabled:opacity-50`}
                  >
                    {selling === trade.id ? "..." : "ПРОДАТЬ"}
                  </button>
                </div>

                {/* P&L bar */}
                {trade.live_pnl_pct !== null && (
                  <div className="mt-3 h-2 bg-zinc-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${trade.live_pnl_pct >= 0 ? "bg-emerald-400" : "bg-rose-400"}`}
                      style={{ width: `${Math.min(Math.abs(trade.live_pnl_pct) * 5, 100)}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Closed Trades */}
      {closedTrades.length > 0 && (
        <div>
          <h2 className="text-lg font-bold text-zinc-800 mb-3 flex items-center gap-2">
            <XCircle className="h-5 w-5 text-zinc-400" /> Закрытые сделки
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-400 text-xs uppercase border-b">
                <th className="pb-2">Тикер</th>
                <th className="pb-2">Купил</th>
                <th className="pb-2">Продал</th>
                <th className="pb-2">P&L</th>
                <th className="pb-2">%</th>
              </tr>
            </thead>
            <tbody>
              {closedTrades.map(t => (
                <tr key={t.id} className="border-b border-zinc-50">
                  <td className="py-2 font-bold">{t.symbol}</td>
                  <td className="py-2 font-mono">${t.buy_price.toFixed(2)}</td>
                  <td className="py-2 font-mono">${t.sell_price?.toFixed(2)}</td>
                  <td className={`py-2 font-bold ${(t.live_pnl_usd || 0) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {(t.live_pnl_usd || 0) >= 0 ? "+" : ""}${(t.live_pnl_usd || 0).toFixed(2)}
                  </td>
                  <td className={`py-2 ${(t.live_pnl_pct || 0) >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {(t.live_pnl_pct || 0) >= 0 ? "+" : ""}{(t.live_pnl_pct || 0).toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
