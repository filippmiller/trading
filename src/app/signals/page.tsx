"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Signal = {
  side: "LONG" | "SHORT";
  reason: string;
  entryPrice: number;
  template: string;
  symbol: string;
};

type SignalResult = {
  scenarioName: string;
  symbol: string;
  signal: Signal;
};

type SignalsResponse = {
  signals: SignalResult[];
  scannedSymbols: number;
  scannedScenarios: number;
  timestamp: string;
};

const SYMBOL_STORAGE_KEY = "symbols:last";

export default function SignalsPage() {
  const [signals, setSignals] = useState<SignalResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [stats, setStats] = useState({ symbols: 0, scenarios: 0 });
  const [symbols, setSymbols] = useState<string[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string>("");

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
          setSelectedSymbol(saved);
        }
      } catch {
        setSymbols([]);
      }
    };
    loadSymbols();
  }, []);

  const refreshSignals = async () => {
    if (loading) return; // Prevent concurrent requests
    setLoading(true);
    setError(null);
    try {
      const url = selectedSymbol
        ? `/api/signals?symbol=${encodeURIComponent(selectedSymbol)}`
        : "/api/signals";
      const response = await fetch(url);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Failed to scan signals");
      }
      const payload: SignalsResponse = await response.json();
      setSignals(payload.signals);
      setStats({ symbols: payload.scannedSymbols, scenarios: payload.scannedScenarios });
      setLastRefresh(new Date(payload.timestamp).toLocaleTimeString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle>Live Signals</CardTitle>
            <CardDescription>
              Check which strategies would trigger entry signals based on the latest data
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="h-10 rounded-md border border-zinc-200 bg-white px-2 text-sm"
              value={selectedSymbol}
              onChange={(e) => setSelectedSymbol(e.target.value)}
            >
              <option value="">All symbols</option>
              {symbols.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <Button onClick={refreshSignals} disabled={loading}>
              {loading ? "Scanning..." : "Refresh Signals"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </div>
          )}

          {lastRefresh && (
            <div className="mb-4 text-xs text-zinc-500">
              Last refreshed: {lastRefresh} | Scanned {stats.symbols} symbols ×{" "}
              {stats.scenarios} scenarios
            </div>
          )}

          {!lastRefresh && !loading && (
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-4 text-center text-sm text-zinc-600">
              Click "Refresh Signals" to scan for active trading signals across all
              downloaded tickers and preset strategies.
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600" />
              Scanning strategies...
            </div>
          )}

          {!loading && lastRefresh && signals.length === 0 && (
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-4 text-center text-sm text-zinc-600">
              No signals triggered today. Check back after the market moves.
            </div>
          )}

          {signals.length > 0 && (
            <div className="space-y-3">
              {signals.map((result, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-4"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{result.symbol}</span>
                      <Badge
                        className={
                          result.signal.side === "LONG"
                            ? "border-emerald-200 bg-emerald-100 text-emerald-700"
                            : "border-red-200 bg-red-100 text-red-700"
                        }
                      >
                        {result.signal.side}
                      </Badge>
                      <span className="text-sm text-zinc-500">{result.scenarioName}</span>
                    </div>
                    <div className="text-sm text-zinc-600">{result.signal.reason}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-zinc-500">Entry Price</div>
                    <div className="font-mono text-sm font-medium">
                      ${result.signal.entryPrice.toFixed(2)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">How It Works</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-zinc-600">
          <ul className="list-inside list-disc space-y-1">
            <li>Scans all downloaded tickers against all preset strategies</li>
            <li>Detects if the latest bar triggers an entry signal</li>
            <li>Shows LONG signals for potential buy opportunities</li>
            <li>Shows SHORT signals for potential short opportunities</li>
            <li>This is informational only - not trading advice</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
