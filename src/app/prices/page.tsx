"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const formatNumber = (value: number, digits = 2) => value.toFixed(digits);
const SYMBOL_STORAGE_KEY = "symbols:last";

type PriceRow = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

type EnrichedRow = PriceRow & {
  change: number;
  changePct: number;
};

export default function PricesPage() {
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [limit, setLimit] = useState(60);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [symbol, setSymbol] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<EnrichedRow | null>(null);

  const fetchPrices = async (symbolToLoad: string) => {
    if (!symbolToLoad) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `/api/prices?symbol=${encodeURIComponent(symbolToLoad)}&limit=${limit}`
      );
      const payload = await response.json();
      setRows(payload.items || []);
    } finally {
      setLoading(false);
    }
  };

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
    if (!symbol) return;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SYMBOL_STORAGE_KEY, symbol);
    }
    setSelected(null);
    fetchPrices(symbol);
  }, [symbol]);

  const enriched = useMemo<EnrichedRow[]>(() => {
    return rows.map((row) => {
      const change = row.close - row.open;
      const changePct = row.open ? change / row.open : 0;
      return { ...row, change, changePct };
    });
  }, [rows]);

  const chart = useMemo(() => {
    if (!selected) return null;
    const width = 280;
    const height = 180;
    const padding = 20;
    const range = Math.max(0.01, selected.high - selected.low);
    const y = (price: number) =>
      padding + ((selected.high - price) / range) * (height - padding * 2);

    const openY = y(selected.open);
    const closeY = y(selected.close);
    const highY = y(selected.high);
    const lowY = y(selected.low);
    const bodyTop = Math.min(openY, closeY);
    const bodyHeight = Math.max(4, Math.abs(openY - closeY));
    const up = selected.change >= 0;

    return { width, height, padding, openY, closeY, highY, lowY, bodyTop, bodyHeight, up };
  }, [selected]);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <CardTitle>Daily {symbol || "—"} Prices</CardTitle>
          <div className="text-sm text-zinc-500">
            Click a day to view its trading diagram.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="h-10 rounded-md border border-zinc-200 bg-white px-2 text-sm"
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            disabled={!symbols.length}
          >
            {!symbols.length && <option value="">No tickers</option>}
            {symbols.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <Input
            type="number"
            min={1}
            max={260}
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            className="w-24"
          />
          <Button onClick={() => fetchPrices(symbol)} disabled={loading || !symbol}>
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {symbols.length === 0 && (
          <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
            No tickers downloaded yet. Add one on the Dashboard first.
          </div>
        )}
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-zinc-500">
                <th className="py-2">Date</th>
                <th>Open</th>
                <th>Close</th>
                <th>Change ($)</th>
                <th>Change (%)</th>
              </tr>
            </thead>
            <tbody>
              {enriched.map((row) => {
                const up = row.change >= 0;
                return (
                  <tr
                    key={row.date}
                    className="cursor-pointer border-b hover:bg-zinc-50"
                    onClick={() => setSelected(row)}
                  >
                    <td className="py-2">{row.date}</td>
                    <td>{formatNumber(row.open, 2)}</td>
                    <td>{formatNumber(row.close, 2)}</td>
                    <td className={up ? "text-emerald-600" : "text-red-600"}>
                      {up ? "+" : ""}
                      {formatNumber(row.change, 2)}
                    </td>
                    <td className={up ? "text-emerald-600" : "text-red-600"}>
                      {up ? "+" : ""}
                      {(row.changePct * 100).toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>

      {selected && chart && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="w-full max-w-xl rounded-xl bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-zinc-500">Trading diagram</div>
                <div className="text-lg font-semibold">{selected.date}</div>
              </div>
              <Button variant="secondary" onClick={() => setSelected(null)}>
                Close
              </Button>
            </div>

            <div className="mt-4 flex flex-col gap-4 md:flex-row md:items-center">
              <svg width={chart.width} height={chart.height} className="rounded-lg bg-zinc-50">
                <line
                  x1={chart.width / 2}
                  x2={chart.width / 2}
                  y1={chart.highY}
                  y2={chart.lowY}
                  stroke={chart.up ? "#16a34a" : "#dc2626"}
                  strokeWidth={2}
                />
                <rect
                  x={chart.width / 2 - 16}
                  y={chart.bodyTop}
                  width={32}
                  height={chart.bodyHeight}
                  fill={chart.up ? "#22c55e" : "#ef4444"}
                  rx={4}
                />
              </svg>

              <div className="grid flex-1 gap-2 text-sm">
                <div className="flex justify-between text-zinc-600">
                  <span>Open</span>
                  <span className="font-medium text-zinc-900">{formatNumber(selected.open, 2)}</span>
                </div>
                <div className="flex justify-between text-zinc-600">
                  <span>High</span>
                  <span className="font-medium text-zinc-900">{formatNumber(selected.high, 2)}</span>
                </div>
                <div className="flex justify-between text-zinc-600">
                  <span>Low</span>
                  <span className="font-medium text-zinc-900">{formatNumber(selected.low, 2)}</span>
                </div>
                <div className="flex justify-between text-zinc-600">
                  <span>Close</span>
                  <span className="font-medium text-zinc-900">{formatNumber(selected.close, 2)}</span>
                </div>
                <div className="flex justify-between text-zinc-600">
                  <span>Change</span>
                  <span className={selected.change >= 0 ? "font-medium text-emerald-600" : "font-medium text-red-600"}>
                    {selected.change >= 0 ? "+" : ""}{formatNumber(selected.change, 2)}
                  </span>
                </div>
                <div className="flex justify-between text-zinc-600">
                  <span>Change %</span>
                  <span className={selected.change >= 0 ? "font-medium text-emerald-600" : "font-medium text-red-600"}>
                    {selected.change >= 0 ? "+" : ""}{(selected.changePct * 100).toFixed(2)}%
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
