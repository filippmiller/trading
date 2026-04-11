"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Activity, DollarSign, Clock, XCircle, Plus, RefreshCw, Wallet } from "lucide-react";

type Trade = {
  id: number;
  symbol: string;
  quantity: number;
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

type PendingOrder = {
  id: number;
  symbol: string;
  side: "BUY" | "SELL";
  order_type: "MARKET" | "LIMIT" | "STOP";
  investment_usd: number | null;
  limit_price: number | null;
  stop_price: number | null;
  created_at: string;
  notes: string | null;
};

type AccountState = {
  id: number;
  name: string;
  initial_cash: number;
  cash: number;
  positions_value: number;
  equity: number;
  open_positions: number;
  total_return_pct: number;
  realized_pnl_usd: number;
  win_rate_pct: number;
  closed_trades: number;
};

export default function PaperTradingPage() {
  const [account, setAccount] = useState<AccountState | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [lastUpdate, setLastUpdate] = useState("");
  const [selling, setSelling] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // Buy form
  const [buySymbol, setBuySymbol] = useState("");
  const [buyAmount, setBuyAmount] = useState("1000");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [limitPrice, setLimitPrice] = useState("");
  const [buyError, setBuyError] = useState("");

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/paper");
      const data = await res.json();
      setAccount(data.account || null);
      setTrades(data.trades || []);
      setOrders(data.pendingOrders || []);
      setLastUpdate(new Date().toLocaleTimeString());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadData();
      if (cancelled) return;
    })();
    const interval = setInterval(loadData, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [loadData]);

  const handleBuy = async () => {
    setBuyError("");
    const symbol = buySymbol.trim().toUpperCase();
    const investment = parseFloat(buyAmount);
    if (!symbol) { setBuyError("Enter a ticker."); return; }
    if (!(investment > 0)) { setBuyError("Amount must be greater than zero."); return; }
    if (orderType === "LIMIT" && !(parseFloat(limitPrice) > 0)) { setBuyError("Provide a valid limit price."); return; }

    setBusy(true);
    try {
      const res = await fetch("/api/paper/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          side: "BUY",
          order_type: orderType,
          investment_usd: investment,
          limit_price: orderType === "LIMIT" ? parseFloat(limitPrice) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBuyError(data.error || "Order placement failed.");
      } else {
        setBuySymbol("");
        setLimitPrice("");
        await loadData();
      }
    } catch (e) {
      setBuyError(String(e));
    }
    setBusy(false);
  };

  const handleSell = async (trade: Trade) => {
    setSelling(trade.id);
    try {
      await fetch("/api/paper/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: trade.symbol,
          side: "SELL",
          order_type: "MARKET",
          trade_id: trade.id,
        }),
      });
      await loadData();
    } catch { /* ignore */ }
    setSelling(null);
  };

  const handleCancelOrder = async (id: number) => {
    await fetch(`/api/paper/order?id=${id}`, { method: "DELETE" });
    await loadData();
  };

  const handleReset = async () => {
    if (!confirm("Reset all paper trades and restore the starting balance?")) return;
    setBusy(true);
    await fetch("/api/paper/account", { method: "POST", body: JSON.stringify({}), headers: { "Content-Type": "application/json" } });
    await loadData();
    setBusy(false);
  };

  const openTrades = trades.filter(t => t.status === "OPEN");
  const closedTrades = trades.filter(t => t.status === "CLOSED");

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-20">
      {/* Header */}
      <div className="border-b pb-4 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 flex items-center gap-3">
            <DollarSign className="text-amber-500 h-8 w-8" />
            Paper Trading Simulator
          </h1>
          <p className="text-zinc-500 mt-1">Virtual positions with live Yahoo Finance pricing and pending-order support.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={loadData} className="flex items-center gap-1 px-3 py-2 text-sm bg-zinc-100 hover:bg-zinc-200 rounded-lg">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button onClick={handleReset} disabled={busy} className="px-3 py-2 text-sm bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg disabled:opacity-50">
            Reset
          </button>
        </div>
      </div>

      {/* Account KPIs */}
      {account && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl p-4 ring-1 ring-zinc-200/50 shadow-sm">
            <p className="text-[10px] text-zinc-400 uppercase font-bold flex items-center gap-1">
              <Wallet className="h-3 w-3" /> Equity
            </p>
            <p className="text-2xl font-bold">${account.equity.toFixed(2)}</p>
            <p className={`text-xs mt-1 ${account.total_return_pct >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
              {account.total_return_pct >= 0 ? "+" : ""}{account.total_return_pct.toFixed(2)}%
            </p>
          </div>
          <div className="bg-white rounded-xl p-4 ring-1 ring-zinc-200/50 shadow-sm">
            <p className="text-[10px] text-zinc-400 uppercase font-bold">Cash</p>
            <p className="text-2xl font-bold text-zinc-700">${account.cash.toFixed(2)}</p>
            <p className="text-xs text-zinc-400 mt-1">of ${account.initial_cash.toFixed(0)}</p>
          </div>
          <div className="bg-white rounded-xl p-4 ring-1 ring-zinc-200/50 shadow-sm">
            <p className="text-[10px] text-zinc-400 uppercase font-bold">Positions</p>
            <p className="text-2xl font-bold text-zinc-700">${account.positions_value.toFixed(2)}</p>
            <p className="text-xs text-zinc-400 mt-1">{account.open_positions} open</p>
          </div>
          <div className="bg-white rounded-xl p-4 ring-1 ring-zinc-200/50 shadow-sm">
            <p className="text-[10px] text-zinc-400 uppercase font-bold">Realized P&L</p>
            <p className={`text-2xl font-bold ${account.realized_pnl_usd >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
              {account.realized_pnl_usd >= 0 ? "+" : ""}${account.realized_pnl_usd.toFixed(2)}
            </p>
            <p className="text-xs text-zinc-400 mt-1">
              {account.closed_trades} closed trades · {account.win_rate_pct.toFixed(0)}% win
            </p>
          </div>
        </div>
      )}

      {/* Buy form */}
      <div className="bg-white rounded-xl p-5 ring-1 ring-zinc-200/50 shadow-sm">
        <h2 className="text-lg font-bold text-zinc-800 mb-3 flex items-center gap-2">
          <Plus className="h-5 w-5 text-emerald-500" /> Buy
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
          <div>
            <label className="text-xs text-zinc-400 font-bold uppercase">Ticker</label>
            <input
              type="text"
              value={buySymbol}
              onChange={e => setBuySymbol(e.target.value.toUpperCase())}
              placeholder="AAPL"
              className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-zinc-400 font-bold uppercase">Amount $</label>
            <input
              type="number"
              value={buyAmount}
              onChange={e => setBuyAmount(e.target.value)}
              placeholder="1000"
              className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-zinc-400 font-bold uppercase">Type</label>
            <select
              value={orderType}
              onChange={e => setOrderType(e.target.value as "MARKET" | "LIMIT")}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            >
              <option value="MARKET">Market</option>
              <option value="LIMIT">Limit</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-zinc-400 font-bold uppercase">Limit price</label>
            <input
              type="number"
              value={limitPrice}
              onChange={e => setLimitPrice(e.target.value)}
              placeholder={orderType === "LIMIT" ? "100.00" : "—"}
              disabled={orderType !== "LIMIT"}
              className="w-full px-3 py-2 border rounded-lg text-sm font-mono disabled:bg-zinc-50 disabled:text-zinc-300"
            />
          </div>
          <button
            onClick={handleBuy}
            disabled={busy}
            className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg font-bold text-sm disabled:opacity-50"
          >
            {busy ? "..." : "BUY"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {[250, 500, 1000, 2500].map((amount) => (
            <button
              key={amount}
              onClick={() => setBuyAmount(String(amount))}
              className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-600 hover:bg-zinc-200"
            >
              ${amount}
            </button>
          ))}
        </div>
        {buyError && <p className="text-rose-500 text-xs mt-2">{buyError}</p>}
      </div>

      {/* Pending orders */}
      {orders.length > 0 && (
        <div>
          <h2 className="text-lg font-bold text-zinc-800 mb-3 flex items-center gap-2">
            <Clock className="h-5 w-5 text-amber-500" /> Pending Orders
          </h2>
          <div className="space-y-2">
            {orders.map(o => (
              <div key={o.id} className="bg-amber-50 rounded-lg p-3 flex items-center justify-between text-sm">
                <div className="flex items-center gap-3">
                  <span className="font-bold">{o.symbol}</span>
                  <span className={`px-2 py-0.5 rounded text-xs font-bold ${o.side === "BUY" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                    {o.side} {o.order_type}
                  </span>
                  {o.investment_usd != null && <span className="text-zinc-600">${o.investment_usd}</span>}
                  {o.limit_price != null && <span className="text-zinc-600">limit ${o.limit_price.toFixed(2)}</span>}
                  {o.stop_price != null && <span className="text-zinc-600">stop ${o.stop_price.toFixed(2)}</span>}
                </div>
                <button
                  onClick={() => handleCancelOrder(o.id)}
                  className="text-xs text-rose-600 hover:underline"
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Open Trades */}
      <div>
        <h2 className="text-lg font-bold text-zinc-800 mb-3 flex items-center gap-2">
          <Activity className="h-5 w-5 text-emerald-500" /> Open Positions
        </h2>
        {openTrades.length === 0 ? (
          <p className="text-zinc-400 text-sm">No open positions.</p>
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
                    <div className="flex flex-wrap gap-4 mt-1 text-sm text-zinc-500">
                      <span>Qty: <b className="text-zinc-700">{trade.quantity.toFixed(4)}</b></span>
                      <span>Entry: <b className="text-zinc-700">${trade.buy_price.toFixed(2)}</b></span>
                      <span>Live: <b className="text-zinc-700">{trade.current_price ? `$${trade.current_price.toFixed(2)}` : "..."}</b></span>
                      <span>Allocated: ${trade.investment_usd.toFixed(2)}</span>
                      <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {trade.buy_date}</span>
                    </div>
                    {trade.notes && <p className="text-xs text-zinc-400 mt-1">{trade.notes}</p>}
                  </div>
                  <button
                    onClick={() => handleSell(trade)}
                    disabled={selling === trade.id}
                    className={`ml-4 px-5 py-2 rounded-lg font-bold text-sm transition-all ${
                      trade.live_pnl_pct && trade.live_pnl_pct > 0
                        ? "bg-emerald-500 hover:bg-emerald-600 text-white"
                        : "bg-rose-100 hover:bg-rose-200 text-rose-700"
                    } disabled:opacity-50`}
                  >
                    {selling === trade.id ? "..." : "SELL"}
                  </button>
                </div>

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
            <XCircle className="h-5 w-5 text-zinc-400" /> Trade History
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-400 text-xs uppercase border-b">
                <th className="pb-2">Ticker</th>
                <th className="pb-2">Buy</th>
                <th className="pb-2">Sell</th>
                <th className="pb-2">P&L</th>
                <th className="pb-2">%</th>
                <th className="pb-2">Strategy</th>
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
                  <td className="py-2 text-xs text-zinc-500">{t.strategy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer */}
      <div className="text-xs text-zinc-400 text-right">
        Updated: {lastUpdate || "..."} · refreshes every 30s
      </div>
    </div>
  );
}
