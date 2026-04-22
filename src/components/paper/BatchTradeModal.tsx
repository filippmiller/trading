"use client";

import React, { useEffect, useMemo, useState } from "react";
import { X, AlertTriangle, CheckCircle2 } from "lucide-react";

import type { ReversalEntry } from "@/lib/reversal";

/**
 * Batch "paper-trade N selected tickers" modal. Opens from the matrix when
 * the user has ≥1 tickers checked via F2 selection. Pre-fills side from
 * `entry.direction`, fill price from `entry.entry_price` (the enrolment
 * close = "yesterday's price" in the user's mental model), and a default
 * quantity sized to ~$1000 per ticker.
 *
 * The modal submits a single POST to /api/paper/batch-order which runs
 * each fill independently inside the paper engine. Partial success is
 * surfaced per-row so a mixed result (some filled, some rejected by
 * whitelist / insufficient cash) is clear to the user instead of "all or
 * nothing".
 */

export type BatchTradeModalProps = {
  open: boolean;
  entries: ReversalEntry[];
  accountId: number | null;
  onClose: () => void;
  /** Called with number of successful fills after submit, so the caller
   *  can e.g. uncheck rows that were filled. */
  onSubmitted?: (filledCount: number) => void;
};

type Row = {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  fillPrice: number;
  stopLossPct: number | null;
  trailingStopPct: number | null;
  takeProfitPct: number | null;
  // Transient submit result
  result?:
    | { status: "filled"; orderId: number; tradeId: number }
    | { status: "rejected"; reason: string }
    | { status: "error"; reason: string };
};

const DEFAULT_SIZE_USD = 1000;
const DEFAULT_STOP_PCT = 3;

function initialRow(entry: ReversalEntry): Row {
  const qty = Math.max(1, Math.floor(DEFAULT_SIZE_USD / Math.max(entry.entry_price, 0.01)));
  return {
    symbol: entry.symbol,
    side: entry.direction,
    qty,
    fillPrice: Number(entry.entry_price.toFixed(4)),
    stopLossPct: DEFAULT_STOP_PCT,
    trailingStopPct: null,
    takeProfitPct: null,
  };
}

export function BatchTradeModal({
  open,
  entries,
  accountId,
  onClose,
  onSubmitted,
}: BatchTradeModalProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ total: number; filled: number; rejected: number; errored: number } | null>(null);
  const [topLevelError, setTopLevelError] = useState<string | null>(null);
  // Per-modal-open batch id. Combined with each row's index, this gives
  // every order a stable `client_request_id` so a double-click / network
  // retry / React-double-mount doesn't produce duplicate paper trades.
  // Regenerated on every open so re-opening the modal after a "Close"
  // starts a fresh batch (a true intentional re-submit).
  const [batchId, setBatchId] = useState<string>("");

  // Re-seed rows whenever the selection changes (modal reopens with a
  // different set). Clearing `submitResult` so prior runs aren't confusing.
  useEffect(() => {
    if (open) {
      setRows(entries.map(initialRow));
      setSubmitResult(null);
      setTopLevelError(null);
      // Fresh batch id on each open. Format: `batch-<hex>` where hex is
      // random enough to avoid collisions even if the user spam-opens the
      // modal in the same second. `client_request_id` regex requires
      // 8..64 chars / [A-Za-z0-9_-]+, which this satisfies.
      setBatchId(`batch-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`);
    }
  }, [open, entries]);

  // Escape closes when not busy.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, busy, onClose]);

  const totals = useMemo(() => {
    const notional = rows.reduce((s, r) => s + r.qty * r.fillPrice, 0);
    const risk = rows.reduce((s, r) => {
      const pct = r.stopLossPct ?? 0;
      return s + r.qty * r.fillPrice * (pct / 100);
    }, 0);
    // Commission estimate mirrors risk config default ($0.005/share min $1
    // per leg); actual commission applied by the engine may differ slightly.
    const commission = rows.reduce((s, r) => {
      const perShare = 0.005 * r.qty;
      return s + Math.max(1, perShare);
    }, 0);
    return { notional, risk, commission };
  }, [rows]);

  const updateRow = (i: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const removeRow = (i: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  };

  const submit = async () => {
    if (rows.length === 0) return;
    setBusy(true);
    setTopLevelError(null);
    setSubmitResult(null);
    try {
      const payload = {
        orders: rows.map((r, i) => ({
          symbol: r.symbol,
          side: r.side,
          qty: r.qty,
          fill_price: r.fillPrice,
          stop_loss_pct: r.stopLossPct ?? undefined,
          trailing_stop_pct: r.trailingStopPct ?? undefined,
          take_profit_pct: r.takeProfitPct ?? undefined,
          // Per-row idempotency key. `${batchId}-${index}` means a retry
          // of the same batch (network blip, double-click) hits the same
          // slot for every row and the API replays the stored result
          // instead of inserting duplicates.
          client_request_id: `${batchId}-${i}`,
        })),
      };
      const url = `/api/paper/batch-order${accountId != null ? `?account_id=${accountId}` : ""}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        const detail = body?.issues?.[0]
          ? `Invalid input — ${(body.issues[0].path ?? []).join(".")}: ${body.issues[0].message}`
          : body?.error ?? `HTTP ${res.status}`;
        setTopLevelError(detail);
        return;
      }
      // Map per-row results back onto rows by symbol+index. API preserves
      // input order, so match by index for safety.
      setRows((prev) =>
        prev.map((r, i) => {
          const apiRow = body.results?.[i];
          if (!apiRow) return r;
          if (apiRow.status === "filled") {
            return { ...r, result: { status: "filled", orderId: apiRow.order_id, tradeId: apiRow.trade_id } };
          }
          return { ...r, result: { status: apiRow.status, reason: apiRow.reason } };
        }),
      );
      setSubmitResult(body.summary);
      if (onSubmitted) onSubmitted(body.summary?.filled ?? 0);
    } catch (err) {
      setTopLevelError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="batch-trade-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="flex w-full max-w-5xl max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-100 p-5">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-indigo-100 p-2">
              <CheckCircle2 className="h-5 w-5 text-indigo-600" />
            </div>
            <div>
              <h2 id="batch-trade-title" className="text-lg font-bold text-zinc-900">
                Paper-trade {rows.length} selected {rows.length === 1 ? "ticker" : "tickers"}
              </h2>
              <p className="text-sm text-zinc-500">
                Fills immediately at the price you specify (default = enrolment close, i.e. yesterday's price). This is paper — no market-hours gate.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-30"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-zinc-200 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                <th className="px-2 py-1.5 text-left">Symbol</th>
                <th className="px-2 py-1.5 text-left">Side</th>
                <th className="px-2 py-1.5 text-right">Qty</th>
                <th className="px-2 py-1.5 text-right">Fill $</th>
                <th className="px-2 py-1.5 text-right">Stop %</th>
                <th className="px-2 py-1.5 text-right">Trail %</th>
                <th className="px-2 py-1.5 text-right">TP %</th>
                <th className="px-2 py-1.5 text-right">Notional</th>
                <th className="px-2 py-1.5"></th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const notional = row.qty * row.fillPrice;
                const resultCell = row.result
                  ? row.result.status === "filled"
                    ? <span className="text-[10px] font-bold text-emerald-600">FILLED #{row.result.tradeId}</span>
                    : <span className="text-[10px] font-bold text-rose-600" title={row.result.reason}>{row.result.status.toUpperCase()}: {row.result.reason.slice(0, 40)}</span>
                  : null;
                return (
                  <tr key={`${row.symbol}-${i}`} className="border-b border-zinc-100">
                    <td className="px-2 py-1.5 font-mono font-semibold">{row.symbol}</td>
                    <td className="px-2 py-1.5">
                      <select
                        value={row.side}
                        onChange={(e) => updateRow(i, { side: e.target.value as "LONG" | "SHORT" })}
                        disabled={busy || !!row.result}
                        className="rounded border border-zinc-200 px-1.5 py-0.5 text-xs font-semibold"
                      >
                        <option value="LONG">LONG</option>
                        <option value="SHORT">SHORT</option>
                      </select>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <input
                        type="number"
                        min={1}
                        max={100000}
                        step={1}
                        value={row.qty}
                        onChange={(e) => updateRow(i, { qty: Math.max(0, Number(e.target.value)) })}
                        disabled={busy || !!row.result}
                        className="w-20 rounded border border-zinc-200 px-1.5 py-0.5 text-right text-xs font-mono"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <input
                        type="number"
                        min={0.01}
                        max={100000}
                        step={0.01}
                        value={row.fillPrice}
                        onChange={(e) => updateRow(i, { fillPrice: Math.max(0, Number(e.target.value)) })}
                        disabled={busy || !!row.result}
                        className="w-24 rounded border border-zinc-200 px-1.5 py-0.5 text-right text-xs font-mono"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <input
                        type="number"
                        min={0.1}
                        max={50}
                        step={0.1}
                        value={row.stopLossPct ?? ""}
                        placeholder="off"
                        onChange={(e) => updateRow(i, { stopLossPct: e.target.value === "" ? null : Number(e.target.value) })}
                        disabled={busy || !!row.result}
                        className="w-16 rounded border border-zinc-200 px-1.5 py-0.5 text-right text-xs font-mono"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <input
                        type="number"
                        min={0.1}
                        max={50}
                        step={0.1}
                        value={row.trailingStopPct ?? ""}
                        placeholder="off"
                        onChange={(e) => updateRow(i, { trailingStopPct: e.target.value === "" ? null : Number(e.target.value) })}
                        disabled={busy || !!row.result}
                        className="w-16 rounded border border-zinc-200 px-1.5 py-0.5 text-right text-xs font-mono"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <input
                        type="number"
                        min={0.1}
                        max={100}
                        step={0.1}
                        value={row.takeProfitPct ?? ""}
                        placeholder="off"
                        onChange={(e) => updateRow(i, { takeProfitPct: e.target.value === "" ? null : Number(e.target.value) })}
                        disabled={busy || !!row.result}
                        className="w-16 rounded border border-zinc-200 px-1.5 py-0.5 text-right text-xs font-mono"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-xs">${notional.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-right">{resultCell}</td>
                    <td className="px-2 py-1.5 text-right">
                      {!row.result && (
                        <button
                          onClick={() => removeRow(i)}
                          disabled={busy}
                          className="text-[10px] text-zinc-400 hover:text-rose-600 disabled:opacity-30"
                          aria-label={`Remove ${row.symbol}`}
                        >
                          remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {topLevelError && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <div>{topLevelError}</div>
            </div>
          )}

          {submitResult && (
            <div className={`mt-3 rounded-lg border p-3 text-sm ${submitResult.filled === submitResult.total ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
              <span className="font-semibold">Result:</span>{" "}
              {submitResult.filled} filled · {submitResult.rejected} rejected · {submitResult.errored} errored · {submitResult.total} total
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-zinc-100 p-4">
          <div className="flex flex-col text-xs text-zinc-600">
            <span>
              <span className="font-bold">Total notional:</span> ${totals.notional.toFixed(2)} ·{" "}
              <span className="font-bold">At-risk:</span> ${totals.risk.toFixed(2)} ·{" "}
              <span className="font-bold">Est. commission:</span> ${totals.commission.toFixed(2)}
            </span>
            <span className="text-zinc-400">Values are client-side estimates; engine applies actual slippage + commission on fill.</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="rounded-lg px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
            >
              {submitResult ? "Close" : "Cancel"}
            </button>
            <button
              onClick={() => { void submit(); }}
              disabled={busy || rows.length === 0 || rows.every((r) => !!r.result)}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Submitting…" : submitResult ? "Submit remaining" : `Submit ${rows.filter((r) => !r.result).length} orders`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
