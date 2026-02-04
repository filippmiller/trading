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

export default function DashboardPage() {
  const router = useRouter();
  const [dataStatus, setDataStatus] = useState<{ count: number; latest: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookback, setLookback] = useState(60);
  const [preset, setPreset] = useState(quickPresets[0].id);
  const getErrorMessage = (err: unknown) =>
    err instanceof Error ? err.message : "Unexpected error.";

  const fetchStatus = async () => {
    const response = await fetch("/api/data/status");
    const payload = await response.json();
    setDataStatus(payload);
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const refreshData = async () => {
    setError(null);
    setLoading(true);
    try {
      const response = await fetch("/api/data/refresh", { method: "POST" });
      if (!response.ok) throw new Error("Failed to refresh data.");
      await fetchStatus();
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const runQuickBacktest = async () => {
    setError(null);
    setRunLoading(true);
    try {
      const presetDef = quickPresets.find((item) => item.id === preset);
      const scenario = scenarios.find((item) => item.id === presetDef?.scenarioId);
      if (!scenario) throw new Error("Preset not found.");
      const spec = scenario.buildSpec(scenario.defaultValues, lookback);
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
            <CardTitle>SPY Data Status</CardTitle>
            <CardDescription>Latest OHLCV snapshot stored in MySQL.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-sm text-zinc-600">
              Rows: {dataStatus?.count ?? "—"}
            </div>
            <div className="text-sm text-zinc-600">
              Latest date: {dataStatus?.latest ?? "—"}
            </div>
            <Button onClick={refreshData} disabled={loading}>
              Refresh SPY Data (6mo)
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick Backtest</CardTitle>
            <CardDescription>Run a common preset in one click.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
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
            <Button onClick={runQuickBacktest} disabled={runLoading}>
              Run Backtest
            </Button>
          </CardContent>
        </Card>
      </section>

      {error && <div className="text-sm text-red-600">{error}</div>}

      <ScenariosSection title="Scenarios" />
    </div>
  );
}
