"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { Activity, DollarSign, Clock, XCircle, Plus, RefreshCw, Wallet, Download } from "lucide-react";

type Trade = {
  id: number;
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: number;
  closed_quantity: number;
  remaining_quantity: number;
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
  stop_loss_price: number | null;
  take_profit_price: number | null;
  trailing_stop_pct: number | null;
  trailing_stop_price: number | null;
  trailing_active: boolean;
  time_exit_date: string | null;
  exit_reason: string | null;
};

type PendingOrder = {
  id: number;
  symbol: string;
  side: "BUY" | "SELL";
  position_side: "LONG" | "SHORT";
  order_type: "MARKET" | "LIMIT" | "STOP";
  investment_usd: number | null;
  limit_price: number | null;
  stop_price: number | null;
  reserved_amount: number;
  reserved_short_margin: number;
  close_quantity: number | null;
  created_at: string;
  notes: string | null;
};

type AccountState = {
  id: number;
  name: string;
  initial_cash: number;
  cash: number;
  reserved_cash: number;
  reserved_short_margin: number;
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
  const [positionSide, setPositionSide] = useState<"LONG" | "SHORT">("LONG");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [buyError, setBuyError] = useState("");

  // W3: optional exit-bracket fields for opening orders.
  const [bracketStopLossPct, setBracketStopLossPct] = useState("");
  const [bracketTakeProfitPct, setBracketTakeProfitPct] = useState("");
  const [bracketTrailingPct, setBracketTrailingPct] = useState("");
  const [bracketTrailingActivatesPct, setBracketTrailingActivatesPct] = useState("");
  const [bracketTimeExitDays, setBracketTimeExitDays] = useState("");
  const [showBrackets, setShowBrackets] = useState(false);

  // W3: modify-order inline form.
  const [editingOrderId, setEditingOrderId] = useState<number | null>(null);
  const [editLimitPrice, setEditLimitPrice] = useState("");
  const [editStopPrice, setEditStopPrice] = useState("");
  const [editInvestment, setEditInvestment] = useState("");
  const [editError, setEditError] = useState("");

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

    // W3 open semantics:
    //   LONG  → side=BUY,  position_side=LONG
    //   SHORT → side=SELL, position_side=SHORT
    const apiSide: "BUY" | "SELL" = positionSide === "LONG" ? "BUY" : "SELL";

    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        symbol,
        side: apiSide,
        position_side: positionSide,
        order_type: orderType,
        investment_usd: investment,
        limit_price: orderType === "LIMIT" ? parseFloat(limitPrice) : undefined,
        stop_price: orderType === "STOP" ? parseFloat(stopPrice) : undefined,
      };
      // Only attach bracket fields if the user entered something.
      if (bracketStopLossPct && parseFloat(bracketStopLossPct) > 0) body.stop_loss_pct = parseFloat(bracketStopLossPct);
      if (bracketTakeProfitPct && parseFloat(bracketTakeProfitPct) > 0) body.take_profit_pct = parseFloat(bracketTakeProfitPct);
      if (bracketTrailingPct && parseFloat(bracketTrailingPct) > 0) body.trailing_stop_pct = parseFloat(bracketTrailingPct);
      if (bracketTrailingActivatesPct) body.trailing_activates_at_profit_pct = parseFloat(bracketTrailingActivatesPct);
      if (bracketTimeExitDays && parseInt(bracketTimeExitDays, 10) >= 0) body.time_exit_days = parseInt(bracketTimeExitDays, 10);

      const res = await fetch("/api/paper/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setBuyError(data.error || "Order placement failed.");
      } else if (data.success === false) {
        setBuyError(`Order rejected: ${data.rejection_reason || data.error || "unknown reason"}`);
        await loadData();
      } else {
        setBuySymbol("");
        setLimitPrice("");
        setStopPrice("");
        setBracketStopLossPct("");
        setBracketTakeProfitPct("");
        setBracketTrailingPct("");
        setBracketTrailingActivatesPct("");
        setBracketTimeExitDays("");
        await loadData();
      }
    } catch (e) {
      setBuyError(String(e));
    }
    setBusy(false);
  };

  /**
   * W3: partial-close a position. `fraction` ∈ (0, 1]. Fraction of 1 means
   * close the entire remaining quantity. Sends close_quantity when fraction
   * < 1; omits it (server defaults to full close) when fraction === 1.
   *
   * For LONG: close with side=SELL. For SHORT: cover with side=BUY.
   */
  const handleClose = async (trade: Trade, fraction: number) => {
    setSelling(trade.id);
    const remaining = trade.remaining_quantity;
    const closeQty = fraction >= 1 ? undefined : Math.max(1e-6, remaining * fraction);
    const apiSide: "BUY" | "SELL" = trade.side === "SHORT" ? "BUY" : "SELL";
    try {
      await fetch("/api/paper/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: trade.symbol,
          side: apiSide,
          position_side: trade.side,
          order_type: "MARKET",
          trade_id: trade.id,
          close_quantity: closeQty,
        }),
      });
      await loadData();
    } catch { /* ignore */ }
    setSelling(null);
  };

  const handleStartEdit = (o: PendingOrder) => {
    setEditingOrderId(o.id);
    setEditLimitPrice(o.limit_price != null ? String(o.limit_price) : "");
    setEditStopPrice(o.stop_price != null ? String(o.stop_price) : "");
    setEditInvestment(o.investment_usd != null ? String(o.investment_usd) : "");
    setEditError("");
  };

  const handleCancelEdit = () => {
    setEditingOrderId(null);
    setEditError("");
  };

  const handleSaveEdit = async (id: number) => {
    setEditError("");
    const body: Record<string, number> = {};
    if (editLimitPrice && parseFloat(editLimitPrice) > 0) body.limit_price = parseFloat(editLimitPrice);
    if (editStopPrice && parseFloat(editStopPrice) > 0) body.stop_price = parseFloat(editStopPrice);
    if (editInvestment && parseFloat(editInvestment) > 0) body.investment_usd = parseFloat(editInvestment);
    if (Object.keys(body).length === 0) {
      setEditError("Nothing to update.");
      return;
    }
    try {
      const res = await fetch(`/api/paper/order?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        setEditError(data.error || "Modification failed.");
        return;
      }
      setEditingOrderId(null);
      await loadData();
    } catch (e) {
      setEditError(String(e));
    }
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
      t.side,
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
            {(account.reserved_cash > 0 || account.reserved_short_margin > 0) ? (
              <p className="text-xs text-amber-600 mt-1">
                {account.reserved_cash > 0 && <>${account.reserved_cash.toFixed(2)} reserved</>}
                {account.reserved_cash > 0 && account.reserved_short_margin > 0 && <> · </>}
                {account.reserved_short_margin > 0 && <>${account.reserved_short_margin.toFixed(2)} short-margin</>}
                <span className="text-zinc-400"> · of ${account.initial_cash.toFixed(0)}</span>
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

      {/* Buy / Sell-short form */}
      <div className="bg-white rounded-xl p-5 ring-1 ring-zinc-200/50 shadow-sm">
        <h2 className="text-lg font-bold text-zinc-800 mb-3 flex items-center gap-2">
          <Plus className="h-5 w-5 text-emerald-500" /> Open Position
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
          <div>
            <label className="text-xs text-zinc-400 font-bold uppercase">Direction</label>
            <select
              value={positionSide}
              onChange={e => setPositionSide(e.target.value as "LONG" | "SHORT")}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            >
              <option value="LONG">Long</option>
              <option value="SHORT">Short</option>
            </select>
          </div>
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
            className={`px-4 py-2 rounded-lg font-bold text-sm disabled:opacity-50 text-white ${positionSide === "SHORT" ? "bg-rose-500 hover:bg-rose-600" : "bg-emerald-500 hover:bg-emerald-600"}`}
          >
            {busy ? "..." : (positionSide === "SHORT" ? "SELL SHORT" : "BUY")}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {[250, 500, 1000, 2500].map((amount) => (
            <button
              key={amount}
              onClick={() => setBuyAmount(String(amount))}
              className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-600 hover:bg-zinc-200"
            >
              ${amount}
            </button>
          ))}
          <button
            onClick={() => setShowBrackets(s => !s)}
            className="rounded-full bg-indigo-50 text-indigo-700 px-3 py-1 text-xs font-semibold hover:bg-indigo-100 ml-auto"
          >
            {showBrackets ? "− Hide brackets" : "+ Exit brackets"}
          </button>
        </div>
        {showBrackets && (
          <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 rounded-lg bg-indigo-50/40 p-3">
            <div>
              <label className="block text-[10px] text-indigo-600 uppercase font-bold">Stop-loss %</label>
              <input type="number" step="0.1" value={bracketStopLossPct} onChange={e => setBracketStopLossPct(e.target.value)} placeholder="5" className="w-full px-2 py-1 border rounded text-xs font-mono" />
            </div>
            <div>
              <label className="block text-[10px] text-indigo-600 uppercase font-bold">Take-profit %</label>
              <input type="number" step="0.1" value={bracketTakeProfitPct} onChange={e => setBracketTakeProfitPct(e.target.value)} placeholder="10" className="w-full px-2 py-1 border rounded text-xs font-mono" />
            </div>
            <div>
              <label className="block text-[10px] text-indigo-600 uppercase font-bold">Trailing %</label>
              <input type="number" step="0.1" value={bracketTrailingPct} onChange={e => setBracketTrailingPct(e.target.value)} placeholder="3" className="w-full px-2 py-1 border rounded text-xs font-mono" />
            </div>
            <div>
              <label className="block text-[10px] text-indigo-600 uppercase font-bold">Trail-activates %</label>
              <input type="number" step="0.1" value={bracketTrailingActivatesPct} onChange={e => setBracketTrailingActivatesPct(e.target.value)} placeholder="5" className="w-full px-2 py-1 border rounded text-xs font-mono" />
            </div>
            <div>
              <label className="block text-[10px] text-indigo-600 uppercase font-bold">Time-exit days</label>
              <input type="number" step="1" value={bracketTimeExitDays} onChange={e => setBracketTimeExitDays(e.target.value)} placeholder="5" className="w-full px-2 py-1 border rounded text-xs font-mono" />
            </div>
          </div>
        )}
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
              <div key={o.id} className="bg-amber-50 rounded-lg p-3 text-sm">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-bold">{o.symbol}</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${o.position_side === "SHORT" ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
                      {o.position_side === "SHORT" ? "SHORT" : "LONG"} · {o.side} {o.order_type}
                    </span>
                    {o.investment_usd != null && <span className="text-zinc-600">${o.investment_usd}</span>}
                    {o.limit_price != null && <span className="text-zinc-600">limit ${o.limit_price.toFixed(2)}</span>}
                    {o.stop_price != null && <span className="text-zinc-600">stop ${o.stop_price.toFixed(2)}</span>}
                    {o.close_quantity != null && <span className="text-zinc-600">close qty {o.close_quantity.toFixed(4)}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {editingOrderId !== o.id && (
                      <button
                        onClick={() => handleStartEdit(o)}
                        className="text-xs text-indigo-600 hover:underline"
                      >
                        Edit
                      </button>
                    )}
                    <button
                      onClick={() => handleCancelOrder(o.id)}
                      className="text-xs text-rose-600 hover:underline"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
                {editingOrderId === o.id && (
                  <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
                    <div>
                      <label className="block text-[10px] text-indigo-600 uppercase font-bold">Limit price</label>
                      <input type="number" step="0.01" value={editLimitPrice} onChange={e => setEditLimitPrice(e.target.value)} className="w-full px-2 py-1 border rounded text-xs font-mono" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-indigo-600 uppercase font-bold">Stop price</label>
                      <input type="number" step="0.01" value={editStopPrice} onChange={e => setEditStopPrice(e.target.value)} className="w-full px-2 py-1 border rounded text-xs font-mono" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-indigo-600 uppercase font-bold">Investment $</label>
                      <input type="number" step="1" value={editInvestment} onChange={e => setEditInvestment(e.target.value)} className="w-full px-2 py-1 border rounded text-xs font-mono" />
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleSaveEdit(o.id)}
                        className="flex-1 px-3 py-1 bg-indigo-500 hover:bg-indigo-600 text-white rounded text-xs font-bold"
                      >
                        Save
                      </button>
                      <button
                        onClick={handleCancelEdit}
                        className="flex-1 px-3 py-1 bg-zinc-200 hover:bg-zinc-300 text-zinc-700 rounded text-xs"
                      >
                        Cancel
                      </button>
                    </div>
                    {editError && <p className="text-rose-500 text-xs col-span-full">{editError}</p>}
                  </div>
                )}
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
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-xl font-bold">{trade.symbol}</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${trade.side === "SHORT" ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
                        {trade.side}
                      </span>
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
                      <span>Qty: <b className="text-zinc-700">{trade.remaining_quantity.toFixed(4)}</b>{trade.closed_quantity > 0 && <span className="text-xs text-zinc-400"> / {trade.quantity.toFixed(4)}</span>}</span>
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
                    {/* W3 bracket chips — show only when set. */}
                    {(trade.stop_loss_price != null || trade.take_profit_price != null || trade.trailing_stop_pct != null || trade.time_exit_date != null) && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {trade.stop_loss_price != null && (
                          <span className="px-2 py-0.5 text-[10px] rounded bg-rose-50 text-rose-700 font-semibold">SL ${trade.stop_loss_price.toFixed(2)}</span>
                        )}
                        {trade.take_profit_price != null && (
                          <span className="px-2 py-0.5 text-[10px] rounded bg-emerald-50 text-emerald-700 font-semibold">TP ${trade.take_profit_price.toFixed(2)}</span>
                        )}
                        {trade.trailing_stop_pct != null && (
                          <span className="px-2 py-0.5 text-[10px] rounded bg-indigo-50 text-indigo-700 font-semibold">
                            Trail {trade.trailing_stop_pct}%{trade.trailing_active ? ` @ $${(trade.trailing_stop_price ?? 0).toFixed(2)}` : " (idle)"}
                          </span>
                        )}
                        {trade.time_exit_date != null && (
                          <span className="px-2 py-0.5 text-[10px] rounded bg-amber-50 text-amber-700 font-semibold">Exit by {String(trade.time_exit_date).slice(0, 10)}</span>
                        )}
                      </div>
                    )}
                    {trade.notes && <p className="text-xs text-zinc-400 mt-1">{trade.notes}</p>}
                  </div>
                  <div className="ml-4 flex flex-col gap-1">
                    {/* W3 partial-close controls — replace single SELL with a small
                        button group. For SHORT positions the action is BUY-TO-COVER. */}
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleClose(trade, 0.25)}
                        disabled={selling === trade.id}
                        className="px-2 py-1 text-[10px] rounded bg-zinc-100 hover:bg-zinc-200 font-bold disabled:opacity-50"
                      >25%</button>
                      <button
                        onClick={() => handleClose(trade, 0.5)}
                        disabled={selling === trade.id}
                        className="px-2 py-1 text-[10px] rounded bg-zinc-100 hover:bg-zinc-200 font-bold disabled:opacity-50"
                      >50%</button>
                      <button
                        onClick={() => handleClose(trade, 1)}
                        disabled={selling === trade.id}
                        className={`px-3 py-1 text-xs rounded font-bold disabled:opacity-50 ${
                          trade.live_pnl_pct && trade.live_pnl_pct > 0
                            ? "bg-emerald-500 hover:bg-emerald-600 text-white"
                            : "bg-rose-100 hover:bg-rose-200 text-rose-700"
                        }`}
                      >
                        {selling === trade.id ? "..." : (trade.side === "SHORT" ? "COVER" : "CLOSE")}
                      </button>
                    </div>
                  </div>
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
