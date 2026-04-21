"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { Activity, DollarSign, Clock, XCircle, Plus, RefreshCw, Wallet, Download } from "lucide-react";

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
  as_of: string | null;
  is_live: boolean;
  strategy: string;
  strategy_id: number | null;
  strategy_name: string | null;
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
  reserved_amount: number;
  created_at: string;
  notes: string | null;
};

type AccountState = {
  id: number;
  name: string;
  initial_cash: number;
  cash: number;
  reserved_cash: number;
  positions_value: number;
  equity: number;
  open_positions: number;
  stale_positions: number;
  total_return_pct: number;
  realized_pnl_usd: number;
  /** Original (backward-compat) denominator = closed_trades. */
  win_rate_pct: number;
  /** W2 / codex F3 — scratched-excluded denominator. Prefer in UI. */
  win_rate_excl_scratched_pct: number;
  closed_trades: number;
  wins_count: number;
  losses_count: number;
  scratched_count: number;
  // W2: JSON null sentinel for +∞ (all wins, no losses). Numeric otherwise.
  profit_factor: number | null;
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
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "STOP">("MARKET");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [buyError, setBuyError] = useState("");

  // Trade history filters (local state — no API param, filtering is client-side)
  const [filterSymbol, setFilterSymbol] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterOutcome, setFilterOutcome] = useState<"all" | "win" | "loss" | "scratched">("all");
  const [filterStrategy, setFilterStrategy] = useState<string>("all");

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
    if (orderType === "STOP" && !(parseFloat(stopPrice) > 0)) { setBuyError("Provide a valid stop price."); return; }

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
          stop_price: orderType === "STOP" ? parseFloat(stopPrice) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBuyError(data.error || "Order placement failed.");
      } else if (data.success === false) {
        // MARKET order inserted but fill rejected (e.g. race).
        setBuyError(`Order rejected: ${data.rejection_reason || data.error || "unknown reason"}`);
        await loadData();
      } else {
        setBuySymbol("");
        setLimitPrice("");
        setStopPrice("");
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

  // Unique strategy values for the filter dropdown. Uses strategy_name when
  // present (cron-attributed via FK), falls back to the free-form strategy
  // VARCHAR otherwise (legacy rows + manual trades labeled "MANUAL BUY" etc).
  const strategyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of closedTrades) {
      const label = t.strategy_name || t.strategy || "";
      if (label) set.add(label);
    }
    return Array.from(set).sort();
  }, [closedTrades]);

  const filteredClosed = useMemo(() => {
    const sym = filterSymbol.trim().toUpperCase();
    const from = filterDateFrom ? new Date(filterDateFrom) : null;
    const to = filterDateTo ? new Date(filterDateTo) : null;
    if (to) to.setHours(23, 59, 59, 999); // inclusive end-of-day
    return closedTrades.filter((t) => {
      if (sym && !t.symbol.toUpperCase().includes(sym)) return false;
      const sellDate = t.sell_date ? new Date(t.sell_date) : null;
      if (from && sellDate && sellDate < from) return false;
      if (to && sellDate && sellDate > to) return false;
      const pnl = t.live_pnl_usd ?? 0;
      if (filterOutcome === "win" && !(pnl > 0)) return false;
      if (filterOutcome === "loss" && !(pnl < 0)) return false;
      if (filterOutcome === "scratched" && pnl !== 0) return false;
      if (filterStrategy !== "all") {
        const label = t.strategy_name || t.strategy || "";
        if (label !== filterStrategy) return false;
      }
      return true;
    });
  }, [closedTrades, filterSymbol, filterDateFrom, filterDateTo, filterOutcome, filterStrategy]);

  const heldDays = (t: Trade): number | null => {
    if (!t.sell_date) return null;
    const buy = new Date(t.buy_date);
    const sell = new Date(t.sell_date);
    if (isNaN(buy.getTime()) || isNaN(sell.getTime())) return null;
    return Math.max(0, Math.round((sell.getTime() - buy.getTime()) / 86_400_000));
  };

  const exportCsv = () => {
    const header = [
      "id", "symbol", "strategy", "side", "buy_date", "buy_price",
      "quantity", "investment_usd", "sell_date", "sell_price",
      "pnl_usd", "pnl_pct", "held_days", "status",
    ];
    const rows = filteredClosed.map((t) => [
      t.id,
      t.symbol,
      // CSV-safe: quote strategy label because it can contain commas.
      JSON.stringify(t.strategy_name || t.strategy || "(manual)"),
      "LONG", // W3 will add SHORT — until then every trade is LONG
      t.buy_date,
      t.buy_price.toFixed(4),
      t.quantity.toFixed(6),
      t.investment_usd.toFixed(2),
      t.sell_date ?? "",
      t.sell_price != null ? t.sell_price.toFixed(4) : "",
      t.live_pnl_usd != null ? t.live_pnl_usd.toFixed(4) : "",
      t.live_pnl_pct != null ? t.live_pnl_pct.toFixed(4) : "",
      heldDays(t) ?? "",
      t.status,
    ].join(","));
    const csv = [header.join(","), ...rows].join("\n");
    // Client-side download — no server round-trip, no extra endpoint.
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `paper-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

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
            {account.reserved_cash > 0 ? (
              <p className="text-xs text-amber-600 mt-1">
                ${account.reserved_cash.toFixed(2)} reserved · of ${account.initial_cash.toFixed(0)}
              </p>
            ) : (
              <p className="text-xs text-zinc-400 mt-1">of ${account.initial_cash.toFixed(0)}</p>
            )}
          </div>
          <div className="bg-white rounded-xl p-4 ring-1 ring-zinc-200/50 shadow-sm">
            <p className="text-[10px] text-zinc-400 uppercase font-bold">Positions</p>
            <p className="text-2xl font-bold text-zinc-700">${account.positions_value.toFixed(2)}</p>
            <p className="text-xs text-zinc-400 mt-1">
              {account.open_positions} open
              {account.stale_positions > 0 && (
                <span className="ml-1 text-amber-600">· {account.stale_positions} stale</span>
              )}
            </p>
          </div>
          <div className="bg-white rounded-xl p-4 ring-1 ring-zinc-200/50 shadow-sm">
            <p className="text-[10px] text-zinc-400 uppercase font-bold">Realized P&L</p>
            <p className={`text-2xl font-bold ${account.realized_pnl_usd >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
              {account.realized_pnl_usd >= 0 ? "+" : ""}${account.realized_pnl_usd.toFixed(2)}
            </p>
            {/* W2 / codex F3: surface wins / losses / scratched separately.
                UI uses `win_rate_excl_scratched_pct` (SCRATCHED-excluded) as
                the honest KPI; the legacy `win_rate_pct` field stays on the
                API response for backward-compat with any external consumer.
                profit_factor === null is the JSON-safe sentinel for "infinity"
                — all winners and no losers — rendered as "∞". */}
            <p className="text-xs text-zinc-400 mt-1">
              {account.wins_count}W · {account.losses_count}L
              {account.scratched_count > 0 ? ` · ${account.scratched_count} scratched` : ""}
              {(account.wins_count + account.losses_count) > 0 ? ` · ${account.win_rate_excl_scratched_pct.toFixed(0)}% win` : ""}
            </p>
            <p className="text-[10px] text-zinc-400 mt-0.5">
              PF{" "}
              <span className={account.profit_factor === null || (account.profit_factor !== null && account.profit_factor >= 1) ? "text-emerald-600" : "text-rose-600"}>
                {account.profit_factor === null
                  ? "∞"
                  : account.profit_factor.toFixed(2)}
              </span>
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
              onChange={e => setOrderType(e.target.value as "MARKET" | "LIMIT" | "STOP")}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            >
              <option value="MARKET">Market</option>
              <option value="LIMIT">Limit</option>
              <option value="STOP">Stop</option>
            </select>
          </div>
          {/* One conditional price input — LIMIT uses it for limit price,
              STOP reuses the same slot for stop price. MARKET disables it. */}
          <div>
            <label className="text-xs text-zinc-400 font-bold uppercase">
              {orderType === "STOP" ? "Stop price" : "Limit price"}
            </label>
            <input
              type="number"
              value={orderType === "STOP" ? stopPrice : limitPrice}
              onChange={e => {
                if (orderType === "STOP") setStopPrice(e.target.value);
                else setLimitPrice(e.target.value);
              }}
              placeholder={orderType === "MARKET" ? "—" : "100.00"}
              disabled={orderType === "MARKET"}
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
                      <span>
                        Live: <b className="text-zinc-700">{trade.current_price ? `$${trade.current_price.toFixed(2)}` : "..."}</b>
                        {trade.current_price != null && !trade.is_live && (
                          <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-700 font-semibold align-middle" title={trade.as_of ? `As of ${new Date(trade.as_of).toLocaleString()}` : "Market closed / stale"}>
                            stale
                          </span>
                        )}
                      </span>
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

      {/* Closed Trades — W2: filters + CSV export + held_days column */}
      {closedTrades.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-zinc-800 flex items-center gap-2">
              <XCircle className="h-5 w-5 text-zinc-400" /> Trade History
              <span className="text-xs font-normal text-zinc-400">
                ({filteredClosed.length} of {closedTrades.length})
              </span>
            </h2>
            <button
              onClick={exportCsv}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-zinc-100 hover:bg-zinc-200 rounded-lg"
            >
              <Download className="h-3.5 w-3.5" /> Export CSV
            </button>
          </div>

          {/* Filters. All local-state — no API round-trip. Changing any
              filter immediately narrows the table + CSV export. */}
          <div className="bg-zinc-50 rounded-lg p-3 mb-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
            <div>
              <label className="block text-[10px] text-zinc-500 uppercase font-bold mb-0.5">Symbol</label>
              <input
                type="text"
                value={filterSymbol}
                onChange={e => setFilterSymbol(e.target.value)}
                placeholder="e.g. AAPL"
                className="w-full px-2 py-1 border rounded text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-[10px] text-zinc-500 uppercase font-bold mb-0.5">From (sell)</label>
              <input
                type="date"
                value={filterDateFrom}
                onChange={e => setFilterDateFrom(e.target.value)}
                className="w-full px-2 py-1 border rounded text-xs"
              />
            </div>
            <div>
              <label className="block text-[10px] text-zinc-500 uppercase font-bold mb-0.5">To (sell)</label>
              <input
                type="date"
                value={filterDateTo}
                onChange={e => setFilterDateTo(e.target.value)}
                className="w-full px-2 py-1 border rounded text-xs"
              />
            </div>
            <div>
              <label className="block text-[10px] text-zinc-500 uppercase font-bold mb-0.5">Outcome</label>
              <select
                value={filterOutcome}
                onChange={e => setFilterOutcome(e.target.value as "all" | "win" | "loss" | "scratched")}
                className="w-full px-2 py-1 border rounded text-xs"
              >
                <option value="all">All</option>
                <option value="win">Wins</option>
                <option value="loss">Losses</option>
                <option value="scratched">Scratched</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] text-zinc-500 uppercase font-bold mb-0.5">Strategy</label>
              <select
                value={filterStrategy}
                onChange={e => setFilterStrategy(e.target.value)}
                className="w-full px-2 py-1 border rounded text-xs"
              >
                <option value="all">All</option>
                {strategyOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-400 text-xs uppercase border-b">
                <th className="pb-2">Ticker</th>
                <th className="pb-2">Buy</th>
                <th className="pb-2">Sell</th>
                <th className="pb-2">P&L</th>
                <th className="pb-2">%</th>
                <th className="pb-2">Held</th>
                <th className="pb-2">Strategy</th>
              </tr>
            </thead>
            <tbody>
              {filteredClosed.map(t => {
                const h = heldDays(t);
                const label = t.strategy_name || t.strategy;
                // Cron-attributed trades show their strategy.name via FK;
                // manual trades (strategy_id IS NULL AND label = "MANUAL *")
                // fall through to the italic "(manual)" display.
                const isManual = t.strategy_id == null && (!label || /^manual\b/i.test(label));
                return (
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
                    <td className="py-2 text-xs text-zinc-500">{h != null ? `${h}d` : "—"}</td>
                    <td className="py-2 text-xs text-zinc-500">
                      {isManual
                        ? <span className="italic text-zinc-400">(manual)</span>
                        : label}
                    </td>
                  </tr>
                );
              })}
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
