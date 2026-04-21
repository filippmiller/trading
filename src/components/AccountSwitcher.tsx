"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, User, X } from "lucide-react";

/**
 * Account switcher dropdown. W5 — multi-account support.
 *
 * Selected account persists to localStorage under `selectedPaperAccountId`
 * and defaults to the Default account when nothing is stored / invalid id.
 * The parent owns the `selectedId` state so it can:
 *   1. Reload `/api/paper?account_id=<n>` on switch.
 *   2. Propagate `account_id` to the Buy/Sell/Cancel/Edit mutations.
 *   3. Scope Reset to the currently-selected account.
 *
 * Creating a new account happens via an inline form that expands in-panel
 * (no separate modal — keeps the critical path fast). On success the parent
 * reloads the account list and auto-selects the new account.
 */

export type PaperAccountSummary = {
  id: number;
  name: string;
  initial_cash: number;
  cash: number;
};

export type AccountSwitcherProps = {
  accounts: PaperAccountSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onCreate: (input: { name: string; initial_cash: number }) => Promise<{ ok: boolean; error?: string }>;
};

export function AccountSwitcher({ accounts, selectedId, onSelect, onCreate }: AccountSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCash, setNewCash] = useState("100000");
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const selected = accounts.find((a) => a.id === selectedId) ?? accounts[0] ?? null;

  // Close on outside click. Standard click-outside pattern — attach to
  // document at the capture phase so buttons inside the panel can still
  // handle their own clicks first.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleCreate = async () => {
    setCreateErr(null);
    const name = newName.trim();
    const cash = parseFloat(newCash);
    if (!name) { setCreateErr("Name is required"); return; }
    if (!(cash > 0)) { setCreateErr("Initial cash must be > 0"); return; }
    setBusy(true);
    const result = await onCreate({ name, initial_cash: cash });
    setBusy(false);
    if (result.ok) {
      setNewName("");
      setNewCash("100000");
      setCreating(false);
      setOpen(false);
    } else {
      setCreateErr(result.error ?? "Create failed");
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <User className="h-4 w-4 text-zinc-400" />
        <span className="font-semibold text-zinc-900">{selected?.name ?? "…"}</span>
        <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-72 rounded-xl border border-zinc-200 bg-white shadow-xl">
          <div className="max-h-60 overflow-y-auto p-1">
            {accounts.length === 0 && (
              <p className="p-3 text-xs text-zinc-400">No accounts yet.</p>
            )}
            {accounts.map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  onSelect(a.id);
                  setOpen(false);
                  setCreating(false);
                }}
                className={`flex w-full items-start justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-50 ${
                  a.id === selectedId ? "bg-indigo-50" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-zinc-900">{a.name}</p>
                  <p className="truncate text-xs text-zinc-500">
                    ${a.cash.toLocaleString(undefined, { maximumFractionDigits: 0 })} cash · ${a.initial_cash.toLocaleString(undefined, { maximumFractionDigits: 0 })} initial
                  </p>
                </div>
                {a.id === selectedId && (
                  <span className="ml-2 mt-0.5 text-[10px] font-bold uppercase text-indigo-600">
                    current
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="border-t border-zinc-100 p-2">
            {!creating ? (
              <button
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-50"
              >
                <Plus className="h-4 w-4" />
                New account
              </button>
            ) : (
              <div className="space-y-2 p-1">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold uppercase text-zinc-500">New account</p>
                  <button
                    onClick={() => { setCreating(false); setCreateErr(null); }}
                    className="rounded p-1 text-zinc-400 hover:bg-zinc-100"
                    aria-label="Cancel"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Name (e.g. Alt1)"
                  className="w-full rounded-lg border border-zinc-200 px-2 py-1 text-sm"
                  autoFocus
                />
                <input
                  type="number"
                  value={newCash}
                  onChange={(e) => setNewCash(e.target.value)}
                  placeholder="Initial cash"
                  className="w-full rounded-lg border border-zinc-200 px-2 py-1 font-mono text-sm"
                />
                {createErr && <p className="text-xs text-rose-600">{createErr}</p>}
                <button
                  onClick={handleCreate}
                  disabled={busy}
                  className="w-full rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-bold text-white hover:bg-indigo-600 disabled:opacity-50"
                >
                  {busy ? "Creating…" : "Create"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
