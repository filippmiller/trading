"use client";

import { useEffect, useState } from "react";

import { ScenariosSection } from "@/components/ScenariosSection";
import { SweepSection } from "@/components/SweepSection";

const SYMBOL_STORAGE_KEY = "symbols:last";

export default function ScenariosPage() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [symbol, setSymbol] = useState("");

  useEffect(() => {
    const loadSymbols = async () => {
      try {
        const response = await fetch("/api/symbols");
        const payload = await response.json();
        const items = Array.isArray(payload.items) ? payload.items : [];
        setSymbols(items);
        if (typeof window === "undefined") return;
        const saved = window.localStorage.getItem(SYMBOL_STORAGE_KEY);
        if (saved && items.includes(saved)) {
          setSymbol(saved);
        } else if (items.length) {
          setSymbol(items[0]);
        }
      } catch {
        setSymbols([]);
      }
    };
    loadSymbols();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (symbol) {
      window.localStorage.setItem(SYMBOL_STORAGE_KEY, symbol);
    }
  }, [symbol]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <label className="text-sm text-zinc-600">Ticker for sweep:</label>
        <select
          className="h-10 rounded-md border border-zinc-200 bg-white px-3 text-sm"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          disabled={!symbols.length}
        >
          {!symbols.length && <option value="">No tickers</option>}
          {symbols.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <ScenariosSection title="Scenarios" />

      <SweepSection symbol={symbol} lookbackDays={60} />
    </div>
  );
}
