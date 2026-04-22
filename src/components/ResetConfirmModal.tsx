"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { X, AlertTriangle } from "lucide-react";

/**
 * Typed-confirmation reset modal. Required user action: type the literal
 * string `RESET <account-name>` exactly (case-sensitive) to enable the
 * destructive "Reset account" button.
 *
 * W5 requirement: the old one-click `window.confirm()` was a footgun —
 * user could wipe months of trade history with a mis-click. The typed
 * confirmation is intentionally annoying so a reset decision is conscious.
 *
 * The actual archive export + DELETE fire from the caller's `onConfirm`
 * handler; this component just gates that handler behind the typed
 * confirmation. Caller is responsible for disabling the underlying Reset
 * button during the async operation (we don't own the network call).
 */

export type ResetConfirmModalProps = {
  open: boolean;
  accountName: string;
  /** Invoked when the user hits Reset with the correct confirmation typed. */
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  /** External busy state — caller sets true while the archive+DELETE runs. */
  busy?: boolean;
};

export function ResetConfirmModal({
  open,
  accountName,
  onConfirm,
  onClose,
  busy = false,
}: ResetConfirmModalProps) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const expected = useMemo(() => `RESET ${accountName}`, [accountName]);

  // Reset typed confirmation whenever the modal opens so the user can't
  // "remember" a stale phrase from a prior account reset.
  useEffect(() => {
    if (open) {
      setTyped("");
      // Focus the confirmation input after the modal renders. `setTimeout(0)`
      // defers the focus call until after React commits the DOM — `inputRef`
      // isn't populated yet on the same tick we render with `open=true`.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Close on Escape — one less reason to leave a destructive modal up.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, busy, onClose]);

  if (!open) return null;

  const matches = typed === expected;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reset-confirm-title"
      onClick={(e) => {
        // Click outside closes — but only the backdrop, not clicks propagated
        // up from the modal body.
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-100 p-5">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-rose-100 p-2">
              <AlertTriangle className="h-5 w-5 text-rose-600" />
            </div>
            <div>
              <h2 id="reset-confirm-title" className="text-lg font-bold text-zinc-900">
                Reset account
              </h2>
              <p className="text-sm text-zinc-500">
                <span className="font-semibold text-zinc-700">{accountName}</span> will be restored to its
                initial cash. All open positions, trade history, and equity
                snapshots will be deleted.
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

        <div className="space-y-4 p-5">
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
            <p className="font-bold">Before reset:</p>
            <p className="mt-1">
              An archive CSV (<span className="font-mono">reset-archive-{accountName}-…</span>) will download
              automatically with closed trades + equity snapshots + final account
              state. Keep it if you want to audit this run later.
            </p>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase text-zinc-500 mb-1">
              Type to confirm
            </label>
            <input
              ref={inputRef}
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={expected}
              disabled={busy}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 font-mono text-sm focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-100 disabled:bg-zinc-50"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="mt-1 text-xs text-zinc-400">
              Type <span className="font-mono font-semibold">{expected}</span> exactly.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 p-4">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (matches && !busy) void onConfirm();
            }}
            disabled={!matches || busy}
            className="rounded-lg bg-rose-500 px-4 py-2 text-sm font-bold text-white hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Resetting…" : "Reset account"}
          </button>
        </div>
      </div>
    </div>
  );
}
