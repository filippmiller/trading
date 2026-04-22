"use client";

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Activity, DollarSign, Clock, XCircle, Plus, RefreshCw, Wallet, Download } from "lucide-react";
import { ToastProvider, useToast } from "@/components/Toast";
import { ResetConfirmModal } from "@/components/ResetConfirmModal";
import { AccountSwitcher, type PaperAccountSummary } from "@/components/AccountSwitcher";
import { MarketClock } from "@/components/MarketClock";

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
  win_rate_pct: number;
  win_rate_excl_scratched_pct: number;
  closed_trades: number;
  wins_count: number;
  losses_count: number;
  scratched_count: number;
  profit_factor: number | null;
};

const LS_KEY = "selectedPaperAccountId";

/**
 * W5 — UUID v4 generator, falling back when `crypto.randomUUID` is
 * unavailable (older Safari, test shims). 122 bits of entropy is plenty for
 * single-user paper-trading idempotency over a 24h window.
 */
function generateClientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: RFC4122-ish v4 from Math.random (acceptable since
  // server-side UNIQUE index is the real safety net).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * W5 — extract the most useful rejection signal from a fetch response body
 * (JSON). Tries rejection_reason (SOFT_REJECT code from fillOrder) first,
 * then message, then error, then raw text. Never throws.
 */
function extractRejectionMessage(data: unknown): string {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const reason = typeof d.rejection_reason === "string" ? d.rejection_reason : "";
    const error = typeof d.error === "string" ? d.error : "";
    const message = typeof d.message === "string" ? d.message : "";
    if (reason && error && reason !== error) return `${reason}: ${error}`;
    if (reason) return reason;
    if (error) return error;
    if (message) return message;
  }
  return "Unknown error";
}

function PaperTradingPageInner() {
  const { toast } = useToast();

  // W5 — multi-account. Selected id sourced from localStorage on mount,
  // overridden by the Default account id once the account list loads if the
  // stored id points at a since-deleted account.
  const [accounts, setAccounts] = useState<PaperAccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);

  const [account, setAccount] = useState<AccountState | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [lastUpdate, setLastUpdate] = useState("");
  const [selling, setSelling] = useState<number | null>(null);
  const [buyBusy, setBuyBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  // Buy form
  const [buySymbol, setBuySymbol] = useState("");
  const [buyAmount, setBuyAmount] = useState("1000");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT" | "STOP">("MARKET");
  const [positionSide, setPositionSide] = useState<"LONG" | "SHORT">("LONG");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [buyError, setBuyError] = useState("");

  // W4 — position sizing mode. "$ Fixed" keeps the legacy behaviour where
  // buyAmount = investment_usd directly. "% of equity" computes investment
  // from the account's current equity; "% risk on stop" computes it from the
  // user's stop-loss distance (requires bracketStopLossPct). In all cases the
  // resulting `investment_usd` is what goes to the API — the server does not
  // know about sizing mode, keeping the existing validation path untouched.
  const [sizingMode, setSizingMode] = useState<"USD" | "PCT_EQUITY" | "PCT_RISK">("USD");
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [fractionalEnabled, setFractionalEnabled] = useState<boolean>(true);

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

  // ── Account list loader ─────────────────────────────────────────────────
  const loadAccounts = useCallback(async (): Promise<PaperAccountSummary[]> => {
    try {
      const res = await fetch("/api/paper/accounts");
      const data = await res.json();
      const list: PaperAccountSummary[] = Array.isArray(data.accounts) ? data.accounts : [];
      setAccounts(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  // W5 — initial account selection from localStorage. Runs once on mount.
  // The effect below resolves `selectedAccountId` before any data fetch, so
  // every subsequent loadData call is scoped to the right account.
  const bootstrapDone = useRef(false);
  useEffect(() => {
    if (bootstrapDone.current) return;
    bootstrapDone.current = true;
    void (async () => {
      const list = await loadAccounts();
      if (list.length === 0) { setSelectedAccountId(null); return; }
      let stored: number | null = null;
      try {
        const raw = typeof window !== "undefined" ? window.localStorage.getItem(LS_KEY) : null;
        if (raw && /^\d+$/.test(raw)) stored = Number(raw);
      } catch { /* localStorage may be disabled */ }
      // Validate the stored id against the fresh account list; fall back to
      // the Default account (name='Default') or the first account otherwise.
      const storedExists = stored != null && list.some((a) => a.id === stored);
      if (storedExists) {
        setSelectedAccountId(stored);
      } else {
        const def = list.find((a) => a.name === "Default") ?? list[0];
        setSelectedAccountId(def.id);
      }
    })();
  }, [loadAccounts]);

  // Persist selection.
  useEffect(() => {
    if (selectedAccountId != null) {
      try { window.localStorage.setItem(LS_KEY, String(selectedAccountId)); } catch { /* ignore */ }
    }
  }, [selectedAccountId]);

  // ── /api/paper loader (scoped by account) ───────────────────────────────
  const loadData = useCallback(async () => {
    if (selectedAccountId == null) return;
    try {
      const res = await fetch(`/api/paper?account_id=${selectedAccountId}`);
      const data = await res.json();
      setAccount(data.account || null);
      setTrades(data.trades || []);
      setOrders(data.pendingOrders || []);
      setLastUpdate(new Date().toLocaleTimeString());
    } catch { /* ignore — next refresh will retry */ }
  }, [selectedAccountId]);

  // W4 — load the risk config's fractional toggle so the buy form can warn
  // the user when their investment is too small to buy even 1 whole share.
  // The /api/settings endpoint already reads app_settings; we reuse it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/paper/settings");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        if (typeof data.allow_fractional_shares === "boolean") {
          setFractionalEnabled(data.allow_fractional_shares);
        }
      } catch { /* optional — defaults to fractional allowed */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // W4 — probe a live quote when the user blurs / tabs out of the ticker
  // field, so the sizing calculator can derive share count for fractional
  // warnings and the % risk calculation.
  const fetchQuote = useCallback(async (sym: string) => {
    if (!sym) { setLivePrice(null); return; }
    try {
      const res = await fetch(`/api/paper/quote?symbol=${encodeURIComponent(sym)}`);
      if (!res.ok) { setLivePrice(null); return; }
      const data = await res.json();
      if (typeof data.price === "number" && isFinite(data.price) && data.price > 0) {
        setLivePrice(data.price);
      } else {
        setLivePrice(null);
      }
    } catch {
      setLivePrice(null);
    }
  }, []);

  useEffect(() => {
    if (selectedAccountId == null) return;
    let cancelled = false;
    void (async () => { await loadData(); if (cancelled) return; })();
    const interval = setInterval(loadData, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [loadData, selectedAccountId]);

  // W4 — compute investment_usd from the user's sizing mode. The server
  // still sees a single investment_usd number; the three modes just feed
  // different formulas into it on the client. Returns null + sets error
  // when the mode's required inputs are missing or invalid.
  const computeInvestmentUsd = (amountField: number): number | null => {
    if (sizingMode === "USD") return amountField;
    if (!account) { setBuyError("Account data not loaded yet."); return null; }
    if (sizingMode === "PCT_EQUITY") {
      if (!(amountField > 0 && amountField <= 100)) {
        setBuyError("% of equity must be between 0 and 100.");
        return null;
      }
      return account.equity * (amountField / 100);
    }
    // PCT_RISK — requires stop-loss distance.
    const stopPct = parseFloat(bracketStopLossPct);
    if (!(stopPct > 0)) {
      setBuyError("% risk sizing needs a stop-loss % (enter under Exit brackets).");
      return null;
    }
    if (!(amountField > 0 && amountField <= 100)) {
      setBuyError("Risk % must be between 0 and 100.");
      return null;
    }
    // investment = (equity * risk_pct / 100) / (stop_distance_pct / 100)
    //            = (equity * risk_pct) / stop_pct
    return (account.equity * amountField) / stopPct;
  };

  // ── Account create (W5) ────────────────────────────────────────────────
  const handleCreateAccount = useCallback(async (input: { name: string; initial_cash: number }) => {
    try {
      const res = await fetch("/api/paper/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        const msg = extractRejectionMessage(data);
        toast({ variant: "error", title: "Create failed", message: msg });
        return { ok: false, error: msg };
      }
      // Reload the list + auto-select the new account.
      const list = await loadAccounts();
      const created = list.find((a) => a.id === data.account?.id);
      if (created) setSelectedAccountId(created.id);
      toast({ variant: "success", title: "Account created", message: `${input.name} ready with $${input.initial_cash.toLocaleString()}` });
      return { ok: true };
    } catch (e) {
      const msg = String(e);
      toast({ variant: "error", title: "Create failed", message: msg });
      return { ok: false, error: msg };
    }
  }, [loadAccounts, toast]);

  // ── BUY / SHORT OPEN ───────────────────────────────────────────────────
  const handleBuy = async () => {
    if (buyBusy) return; // belt-and-suspenders — button disables but guard anyway
    setBuyError("");
    const symbol = buySymbol.trim().toUpperCase();
    const amountField = parseFloat(buyAmount);
    if (!symbol) { setBuyError("Enter a ticker."); return; }
    if (!(amountField > 0)) { setBuyError("Amount must be greater than zero."); return; }
    const investment = computeInvestmentUsd(amountField);
    if (investment == null) return;
    if (!(investment > 0)) { setBuyError("Computed investment is non-positive."); return; }
    if (orderType === "LIMIT" && !(parseFloat(limitPrice) > 0)) { setBuyError("Provide a valid limit price."); return; }
    if (orderType === "STOP" && !(parseFloat(stopPrice) > 0)) { setBuyError("Provide a valid stop price."); return; }
    // W4 — whole-share warning. If fractional is off and the live price is
    // known and the investment can't buy 1 share, warn upfront; the server
    // will reject with INSUFFICIENT_INVESTMENT either way.
    if (!fractionalEnabled && livePrice != null && investment < livePrice) {
      setBuyError(`At current price ($${livePrice.toFixed(2)}), $${investment.toFixed(2)} = 0 whole shares. Increase or enable fractional.`);
      return;
    }

    // W3 open semantics:
    //   LONG  → side=BUY,  position_side=LONG
    //   SHORT → side=SELL, position_side=SHORT
    const apiSide: "BUY" | "SELL" = positionSide === "LONG" ? "BUY" : "SELL";

    // W5 — lock the button BEFORE the fetch fires so rapid double-clicks
    // can't both reach the server. Unlocks only after the response.
    setBuyBusy(true);
    const clientRequestId = generateClientRequestId();
    try {
      const body: Record<string, unknown> = {
        symbol,
        side: apiSide,
        position_side: positionSide,
        order_type: orderType,
        // W4 — `investment` already reflects the sizing-mode math
        // (USD / % equity / % risk); server receives a plain USD number.
        investment_usd: Number(investment.toFixed(6)),
        limit_price: orderType === "LIMIT" ? parseFloat(limitPrice) : undefined,
        stop_price: orderType === "STOP" ? parseFloat(stopPrice) : undefined,
        client_request_id: clientRequestId,
      };
      if (bracketStopLossPct && parseFloat(bracketStopLossPct) > 0) body.stop_loss_pct = parseFloat(bracketStopLossPct);
      if (bracketTakeProfitPct && parseFloat(bracketTakeProfitPct) > 0) body.take_profit_pct = parseFloat(bracketTakeProfitPct);
      if (bracketTrailingPct && parseFloat(bracketTrailingPct) > 0) body.trailing_stop_pct = parseFloat(bracketTrailingPct);
      if (bracketTrailingActivatesPct) body.trailing_activates_at_profit_pct = parseFloat(bracketTrailingActivatesPct);
      if (bracketTimeExitDays && parseInt(bracketTimeExitDays, 10) >= 0) body.time_exit_days = parseInt(bracketTimeExitDays, 10);

      const accountQuery = selectedAccountId != null ? `?account_id=${selectedAccountId}` : "";
      const res = await fetch(`/api/paper/order${accountQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const reason = extractRejectionMessage(data);
        setBuyError(reason);
        toast({ variant: "error", title: `${orderType} ${apiSide} rejected`, message: reason });
      } else if (data.success === false) {
        const reason = data.rejection_reason || extractRejectionMessage(data);
        setBuyError(`Order rejected: ${reason}`);
        toast({ variant: "error", title: "Order rejected", message: reason });
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
        if (data.idempotent_replay) {
          toast({ variant: "info", title: "Duplicate submit ignored", message: `Order #${data.order_id} already placed` });
        }
        await loadData();
      }
    } catch (e) {
      const msg = String(e);
      setBuyError(msg);
      toast({ variant: "error", title: "Network error", message: msg });
    } finally {
      setBuyBusy(false);
    }
  };

  const handleClose = async (trade: Trade, fraction: number) => {
    setSelling(trade.id);
    const remaining = trade.remaining_quantity;
    const closeQty = fraction >= 1 ? undefined : Math.max(1e-6, remaining * fraction);
    const apiSide: "BUY" | "SELL" = trade.side === "SHORT" ? "BUY" : "SELL";
    const clientRequestId = generateClientRequestId();
    try {
      const accountQuery = selectedAccountId != null ? `?account_id=${selectedAccountId}` : "";
      const res = await fetch(`/api/paper/order${accountQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: trade.symbol,
          side: apiSide,
          position_side: trade.side,
          order_type: "MARKET",
          trade_id: trade.id,
          close_quantity: closeQty,
          client_request_id: clientRequestId,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        toast({ variant: "error", title: "Close rejected", message: extractRejectionMessage(data) });
      }
      await loadData();
    } catch (e) {
      toast({ variant: "error", title: "Close failed", message: String(e) });
    }
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
        const msg = extractRejectionMessage(data);
        setEditError(msg);
        toast({ variant: "error", title: "Modify failed", message: msg });
        return;
      }
      setEditingOrderId(null);
      await loadData();
    } catch (e) {
      setEditError(String(e));
      toast({ variant: "error", title: "Modify failed", message: String(e) });
    }
  };

  const handleCancelOrder = async (id: number) => {
    try {
      const res = await fetch(`/api/paper/order?id=${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast({ variant: "error", title: "Cancel failed", message: extractRejectionMessage(data) });
      }
      await loadData();
    } catch (e) {
      toast({ variant: "error", title: "Cancel failed", message: String(e) });
    }
  };

  // ── Reset — typed confirmation + CSV archive then DELETE ────────────────
  const triggerArchiveDownload = useCallback((acct: AccountState, snapshotTrades: Trade[]) => {
    // Build a single-file CSV archive with three sections: account state,
    // closed trades, open trades (snapshot). Equity snapshots would require
    // a separate fetch; including them here is best-effort — if a dedicated
    // endpoint exists they could be merged in, but the absolute minimum the
    // user wants back post-reset is their trade ledger + balances.
    const lines: string[] = [];
    const ts = new Date();
    const y = ts.getFullYear();
    const m = String(ts.getMonth() + 1).padStart(2, "0");
    const d = String(ts.getDate()).padStart(2, "0");
    const hh = String(ts.getHours()).padStart(2, "0");
    const mm = String(ts.getMinutes()).padStart(2, "0");
    const ss = String(ts.getSeconds()).padStart(2, "0");
    const stamp = `${y}${m}${d}-${hh}${mm}${ss}`;

    lines.push("# Reset archive");
    lines.push(`# Account: ${acct.name}`);
    lines.push(`# Exported at: ${ts.toISOString()}`);
    lines.push("");
    lines.push("## Account state");
    lines.push("field,value");
    lines.push(`name,${JSON.stringify(acct.name)}`);
    lines.push(`initial_cash,${acct.initial_cash}`);
    lines.push(`cash,${acct.cash}`);
    lines.push(`reserved_cash,${acct.reserved_cash}`);
    lines.push(`reserved_short_margin,${acct.reserved_short_margin}`);
    lines.push(`positions_value,${acct.positions_value}`);
    lines.push(`equity,${acct.equity}`);
    lines.push(`realized_pnl_usd,${acct.realized_pnl_usd}`);
    lines.push(`wins_count,${acct.wins_count}`);
    lines.push(`losses_count,${acct.losses_count}`);
    lines.push(`scratched_count,${acct.scratched_count}`);
    lines.push(`profit_factor,${acct.profit_factor == null ? "inf" : acct.profit_factor}`);
    lines.push(`total_return_pct,${acct.total_return_pct}`);
    lines.push("");
    lines.push("## Closed trades");
    lines.push("id,symbol,side,strategy,buy_date,buy_price,quantity,investment_usd,sell_date,sell_price,pnl_usd,pnl_pct,exit_reason,status");
    for (const t of snapshotTrades.filter((x) => x.status === "CLOSED")) {
      lines.push([
        t.id,
        t.symbol,
        t.side,
        JSON.stringify(t.strategy_name || t.strategy || "(manual)"),
        t.buy_date,
        t.buy_price,
        t.quantity,
        t.investment_usd,
        t.sell_date ?? "",
        t.sell_price ?? "",
        t.live_pnl_usd ?? "",
        t.live_pnl_pct ?? "",
        JSON.stringify(t.exit_reason ?? ""),
        t.status,
      ].join(","));
    }
    lines.push("");
    lines.push("## Open positions at reset");
    lines.push("id,symbol,side,buy_date,buy_price,quantity,closed_quantity,remaining_quantity,investment_usd,current_price,live_pnl_usd,stop_loss_price,take_profit_price,trailing_stop_pct,time_exit_date");
    for (const t of snapshotTrades.filter((x) => x.status === "OPEN")) {
      lines.push([
        t.id,
        t.symbol,
        t.side,
        t.buy_date,
        t.buy_price,
        t.quantity,
        t.closed_quantity,
        t.remaining_quantity,
        t.investment_usd,
        t.current_price ?? "",
        t.live_pnl_usd ?? "",
        t.stop_loss_price ?? "",
        t.take_profit_price ?? "",
        t.trailing_stop_pct ?? "",
        t.time_exit_date ?? "",
      ].join(","));
    }

    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Sanitize account name for a filesystem-safe filename (drop anything
    // that isn't alnum/dash/underscore; trim repeats).
    const safeName = acct.name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_");
    a.download = `reset-archive-${safeName}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke later — giving the browser a moment to start the download
    // before tearing down the blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const handleConfirmReset = useCallback(async () => {
    if (!account) return;
    setResetBusy(true);
    try {
      // 1. Trigger the archive CSV download FIRST — only after the download
      //    starts does the DELETE fire. If the browser blocks the download
      //    (rare; would need the user to click through a "blocked" popup),
      //    the DELETE still runs — the archive is best-effort.
      triggerArchiveDownload(account, trades);

      // 2. Small delay so the browser actually starts the download before
      //    we mutate the source data. 250ms is plenty and invisible to UX.
      await new Promise((r) => setTimeout(r, 250));

      // 3. Fire the DELETE/POST against the selected account.
      const res = await fetch(
        `/api/paper/account${selectedAccountId != null ? `?account_id=${selectedAccountId}` : ""}`,
        { method: "POST", body: JSON.stringify({}), headers: { "Content-Type": "application/json" } }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast({ variant: "error", title: "Reset failed", message: extractRejectionMessage(data) });
        return;
      }
      toast({ variant: "success", title: "Account reset", message: `${account.name} restored to initial cash` });
      await loadData();
      setResetOpen(false);
    } catch (e) {
      toast({ variant: "error", title: "Reset failed", message: String(e) });
    } finally {
      setResetBusy(false);
    }
  }, [account, trades, selectedAccountId, toast, loadData, triggerArchiveDownload]);

  const openTrades = trades.filter(t => t.status === "OPEN");
  const closedTrades = trades.filter(t => t.status === "CLOSED");

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
    if (to) to.setHours(23, 59, 59, 999);
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

  /**
   * W5 — compute % distance from live price for a pending order.
   * Returns null when we can't compute it (no open position / no current mark
   * for the symbol). Uses open-position `current_price` as the live proxy
   * because pending orders don't ship their own live price in the response;
   * this is a best-effort display aid, not an execution decision.
   */
  function computeOrderDistance(o: PendingOrder): { pct: number; live: number } | null {
    const openMatch = openTrades.find(t => t.symbol === o.symbol && t.current_price != null);
    const live = openMatch?.current_price;
    if (live == null || !Number.isFinite(live) || live <= 0) return null;
    const trigger = o.limit_price ?? o.stop_price;
    if (trigger == null) return null;
    const pct = ((trigger - live) / live) * 100;
    return { pct, live };
  }

  function distanceColor(pct: number): string {
    const abs = Math.abs(pct);
    if (abs <= 2) return "text-emerald-600";
    if (abs <= 10) return "text-zinc-500";
    return "text-rose-600";
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-20">
      {/* Header */}
      <div className="border-b pb-4 flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 flex items-center gap-3">
            <DollarSign className="text-amber-500 h-8 w-8" />
            Paper Trading Simulator
          </h1>
          <p className="text-zinc-500 mt-1">Virtual positions with live Yahoo Finance pricing and pending-order support.</p>
          <div className="mt-2">
            <MarketClock />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AccountSwitcher
            accounts={accounts}
            selectedId={selectedAccountId}
            onSelect={setSelectedAccountId}
            onCreate={handleCreateAccount}
          />
          <button onClick={loadData} className="flex items-center gap-1 px-3 py-2 text-sm bg-zinc-100 hover:bg-zinc-200 rounded-lg">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            onClick={() => setResetOpen(true)}
            disabled={!account || resetBusy}
            className="px-3 py-2 text-sm bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-lg disabled:opacity-50"
          >
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
              onBlur={e => fetchQuote(e.target.value.toUpperCase())}
              placeholder="AAPL"
              className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
            />
            {livePrice != null && (
              <p className="text-[10px] text-zinc-400 mt-0.5 font-mono">~${livePrice.toFixed(2)}</p>
            )}
          </div>
          <div>
            <label className="text-xs text-zinc-400 font-bold uppercase">
              {sizingMode === "USD" ? "Amount $" : sizingMode === "PCT_EQUITY" ? "% of equity" : "% risk on stop"}
            </label>
            <div className="flex gap-1">
              <input
                type="number"
                value={buyAmount}
                onChange={e => setBuyAmount(e.target.value)}
                placeholder={sizingMode === "USD" ? "1000" : sizingMode === "PCT_EQUITY" ? "5" : "1"}
                className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
              />
              <select
                value={sizingMode}
                onChange={e => setSizingMode(e.target.value as "USD" | "PCT_EQUITY" | "PCT_RISK")}
                className="px-1 py-2 border rounded-lg text-xs bg-zinc-50"
                title="Sizing mode: fixed USD, % of equity, or % risk on stop (requires stop-loss bracket)"
              >
                <option value="USD">$</option>
                <option value="PCT_EQUITY">%eq</option>
                <option value="PCT_RISK">%risk</option>
              </select>
            </div>
            {sizingMode !== "USD" && account && (() => {
              const amt = parseFloat(buyAmount);
              let projected = 0;
              if (amt > 0) {
                if (sizingMode === "PCT_EQUITY") projected = account.equity * (amt / 100);
                else if (sizingMode === "PCT_RISK") {
                  const stopPct = parseFloat(bracketStopLossPct);
                  if (stopPct > 0) projected = (account.equity * amt) / stopPct;
                }
              }
              return projected > 0 ? (
                <p className="text-[10px] text-indigo-500 mt-0.5 font-mono">≈ ${projected.toFixed(2)}</p>
              ) : null;
            })()}
            {!fractionalEnabled && livePrice != null && (() => {
              // Whole-share warning — show when the projected investment
              // can't buy a single share at current price.
              const amt = parseFloat(buyAmount);
              let investmentProbe = 0;
              if (sizingMode === "USD") investmentProbe = amt;
              else if (sizingMode === "PCT_EQUITY" && account) investmentProbe = account.equity * (amt / 100);
              else if (sizingMode === "PCT_RISK" && account) {
                const stopPct = parseFloat(bracketStopLossPct);
                if (stopPct > 0) investmentProbe = (account.equity * amt) / stopPct;
              }
              if (investmentProbe > 0 && investmentProbe < livePrice) {
                return (
                  <p className="text-[10px] text-rose-500 mt-0.5">
                    Buys 0 shares at ${livePrice.toFixed(2)} (fractional off).
                  </p>
                );
              }
              return null;
            })()}
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
            disabled={buyBusy}
            data-testid="paper-buy-submit"
            className={`px-4 py-2 rounded-lg font-bold text-sm disabled:opacity-50 text-white ${positionSide === "SHORT" ? "bg-rose-500 hover:bg-rose-600" : "bg-emerald-500 hover:bg-emerald-600"}`}
          >
            {buyBusy ? "..." : (positionSide === "SHORT" ? "SELL SHORT" : "BUY")}
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
            {orders.map(o => {
              const dist = computeOrderDistance(o);
              const trigger = o.limit_price ?? o.stop_price;
              const triggerLabel = o.order_type === "STOP" ? "STOP" : "LIMIT";
              return (
              <div key={o.id} className="bg-amber-50 rounded-lg p-3 text-sm">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-bold">{o.symbol}</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${o.position_side === "SHORT" ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
                      {o.position_side === "SHORT" ? "SHORT" : "LONG"} · {o.side} {o.order_type}
                    </span>
                    {o.investment_usd != null && <span className="text-zinc-600">${o.investment_usd}</span>}
                    {trigger != null && (
                      <span className="text-zinc-700 font-mono">
                        {triggerLabel} ${trigger.toFixed(2)}
                        {dist && (
                          <span className={`ml-1 ${distanceColor(dist.pct)}`}>
                            ({dist.pct >= 0 ? "+" : "−"}{Math.abs(dist.pct).toFixed(1)}% from live ${dist.live.toFixed(2)})
                          </span>
                        )}
                      </span>
                    )}
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
            );
            })}
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

      {/* Reset confirm modal */}
      <ResetConfirmModal
        open={resetOpen}
        accountName={account?.name ?? ""}
        onConfirm={handleConfirmReset}
        onClose={() => !resetBusy && setResetOpen(false)}
        busy={resetBusy}
      />
    </div>
  );
}

export default function PaperTradingPage() {
  return (
    <ToastProvider>
      <PaperTradingPageInner />
    </ToastProvider>
  );
}
