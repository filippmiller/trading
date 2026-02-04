"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScenariosSection } from "@/components/ScenariosSection";
import { scenarios } from "@/lib/scenarios";

const quickPresets = [
  {
    id: "quick-streak-2",
    label: "Streak Fade 2 (SL 0.5%, TP 1%)",
    scenarioId: "streak-fade-2",
  },
  {
    id: "quick-streak-3",
    label: "Streak Fade 3 (SL 0.5%, TP 1%)",
    scenarioId: "streak-fade-3",
  },
];

const SYMBOL_STORAGE_KEY = "symbols:last";
const SYMBOL_REGEX = /^[A-Za-z0-9._-]{1,16}$/;

export default function DashboardPage() {
  const router = useRouter();
  const [dataStatus, setDataStatus] = useState<{
    count: number;
    latest: string | null;
    symbol?: string;
  } | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [activeSymbol, setActiveSymbol] = useState("");
  const [newSymbol, setNewSymbol] = useState("");
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookback, setLookback] = useState(60);
  const [preset, setPreset] = useState(quickPresets[0].id);
  const getErrorMessage = (err: unknown) =>
    err instanceof Error ? err.message : "Unexpected error.";

  const fetchStatus = async (symbol: string) => {
    const response = await fetch(`/api/data/status?symbol=${encodeURIComponent(symbol)}`);
    const payload = await response.json();
    setDataStatus(payload);
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
          setActiveSymbol(saved);
        } else if (items.length) {
          setActiveSymbol(items[0]);
        }
      } catch {
        setSymbols([]);
      }
    };
    loadSymbols();
  }, []);

  useEffect(() => {
    if (!activeSymbol) {
      setDataStatus(null);
      return;
    }
    fetchStatus(activeSymbol);
  }, [activeSymbol]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeSymbol) {
      window.localStorage.setItem(SYMBOL_STORAGE_KEY, activeSymbol);
    }
  }, [activeSymbol]);

  const refreshData = async (symbol: string) => {
    setError(null);
    setLoading(true);
    try {
      const response = await fetch("/api/data/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Failed to refresh data.");
      }
      await fetchStatus(symbol);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const addSymbol = async () => {
    const candidate = newSymbol.trim().toUpperCase();
    if (!candidate) {
      setError("Ticker is required.");
      return;
    }
    if (!SYMBOL_REGEX.test(candidate)) {
      setError("Ticker must be 1-16 chars (letters, numbers, dot, underscore, dash).");
      return;
    }
    setError(null);
    setAdding(true);
    try {
      const response = await fetch("/api/data/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: candidate }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Failed to download data.");
      }
      const symbolsResponse = await fetch("/api/symbols");
      const payload = await symbolsResponse.json();
      const items = Array.isArray(payload.items) ? payload.items : [];
      setSymbols(items);
      if (items.includes(candidate)) {
        setActiveSymbol(candidate);
      }
      setNewSymbol("");
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const runQuickBacktest = async () => {
    if (!activeSymbol) {
      setError("Select a ticker with downloaded data.");
      return;
    }
    setError(null);
    setRunLoading(true);
    try {
      const presetDef = quickPresets.find((item) => item.id === preset);
      const scenario = scenarios.find((item) => item.id === presetDef?.scenarioId);
      if (!scenario) throw new Error("Preset not found.");
      const spec = scenario.buildSpec(scenario.defaultValues, lookback, activeSymbol);
      const response = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spec,
          preset_name: scenario.name,
        }),
      });
      if (!response.ok) throw new Error("Backtest failed.");
      const payload = await response.json();
      router.push(`/runs/${payload.id}`);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setRunLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <section className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Market Data</CardTitle>
            <CardDescription>Download and track daily OHLCV history.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm text-zinc-600">Available tickers</label>
              <select
                className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm"
                value={activeSymbol}
                onChange={(event) => setActiveSymbol(event.target.value)}
                disabled={!symbols.length}
              >
                {!symbols.length && <option value="">No tickers</option>}
                {symbols.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              {!symbols.length && (
                <div className="text-xs text-zinc-500">
                  No tickers downloaded yet. Add one below to get started.
                </div>
              )}
            </div>

            <div className="grid gap-1 text-sm text-zinc-600">
              <div>Rows: {dataStatus?.count ?? "—"}</div>
              <div>Latest date: {dataStatus?.latest ?? "—"}</div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => refreshData(activeSymbol)} disabled={loading || !activeSymbol}>
                Download history
              </Button>
            </div>

            <div className="space-y-2 border-t border-zinc-100 pt-3">
              <label className="text-sm text-zinc-600">Add ticker</label>
              <div className="flex flex-wrap gap-2">
                <Input
                  value={newSymbol}
                  onChange={(event) => setNewSymbol(event.target.value.toUpperCase())}
                  placeholder="SPY, DIA, DJIA.US"
                  className="flex-1"
                />
                <Button onClick={addSymbol} disabled={adding || !newSymbol.trim()}>
                  Download
                </Button>
              </div>
              <div className="text-xs text-zinc-500">
                Uses Stooq symbols. Add the “.US” suffix if needed.
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick Backtest</CardTitle>
            <CardDescription>Run a common preset in one click.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="text-sm text-zinc-600">Ticker</label>
            <select
              className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm"
              value={activeSymbol}
              onChange={(event) => setActiveSymbol(event.target.value)}
              disabled={!symbols.length}
            >
              {!symbols.length && <option value="">No tickers</option>}
              {symbols.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <label className="text-sm text-zinc-600">Preset</label>
            <select
              className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm"
              value={preset}
              onChange={(event) => setPreset(event.target.value)}
            >
              {quickPresets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <label className="text-sm text-zinc-600">Lookback (days)</label>
            <Input
              type="number"
              min={20}
              max={260}
              step={1}
              value={lookback}
              onChange={(event) => setLookback(Number(event.target.value))}
            />
            <Button onClick={runQuickBacktest} disabled={runLoading || !activeSymbol}>
              Run Backtest
            </Button>
          </CardContent>
        </Card>
      </section>

      {error && <div className="text-sm text-red-600">{error}</div>}

      <ScenariosSection
        title="Scenarios"
        symbolOverride={activeSymbol}
        symbolsOverride={symbols}
        onSymbolChange={setActiveSymbol}
      />
    </div>
  );
}
