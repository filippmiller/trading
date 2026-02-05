"use client";

import { useState, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Heatmap } from "@/components/charts/Heatmap";
import { scenarios } from "@/lib/scenarios";

type SweepResult = {
  stopLossPct: number;
  takeProfitPct: number;
  metrics: {
    total_pnl_usd: number;
    total_return_pct: number;
    win_rate: number;
    trades_count: number;
  };
};

type SweepResponse = {
  results: SweepResult[];
  gridSize: number;
  totalRuns: number;
  bestResult: SweepResult;
  symbol: string;
  template: string;
};

type Props = {
  symbol: string;
  lookbackDays: number;
};

export function SweepSection({ symbol, lookbackDays }: Props) {
  const [scenarioId, setScenarioId] = useState(scenarios[0]?.id || "");
  const [slMin, setSlMin] = useState(0.003);
  const [slMax, setSlMax] = useState(0.02);
  const [tpMin, setTpMin] = useState(0.005);
  const [tpMax, setTpMax] = useState(0.03);
  const [steps, setSteps] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SweepResponse | null>(null);

  const selectedScenario = useMemo(
    () => scenarios.find((s) => s.id === scenarioId),
    [scenarioId]
  );

  const heatmapCells = useMemo(() => {
    if (!results) return [];
    return results.results.map((r) => ({
      x: r.stopLossPct,
      y: r.takeProfitPct,
      xLabel: `${(r.stopLossPct * 100).toFixed(1)}%`,
      yLabel: `${(r.takeProfitPct * 100).toFixed(1)}%`,
      value: r.metrics.total_return_pct,
      metrics: r.metrics,
    }));
  }, [results]);

  const runSweep = async () => {
    if (!selectedScenario || !symbol) return;

    setLoading(true);
    setError(null);
    setResults(null);

    try {
      const baseSpec = selectedScenario.buildSpec(
        selectedScenario.defaultValues,
        lookbackDays,
        symbol
      );

      const response = await fetch("/api/backtest/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseSpec,
          stopLossRange: [slMin, slMax],
          takeProfitRange: [tpMin, tpMax],
          steps,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Sweep failed");
      }

      const payload: SweepResponse = await response.json();
      setResults(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Parameter Sweep</CardTitle>
        <div className="text-sm text-zinc-500">
          Run a grid search across stop loss and take profit values to find optimal
          parameters
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!symbol && (
          <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">
            Select a ticker first to run a parameter sweep.
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm text-zinc-600">Strategy Template</label>
            <select
              className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm"
              value={scenarioId}
              onChange={(e) => setScenarioId(e.target.value)}
            >
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-zinc-600">Grid Size</label>
            <Input
              type="number"
              min={2}
              max={10}
              value={steps}
              onChange={(e) => setSteps(Number(e.target.value))}
            />
            <div className="text-xs text-zinc-500">
              {steps}×{steps} = {steps * steps} backtests
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm text-zinc-600">Stop Loss Range</label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step={0.001}
                min={0.001}
                max={0.2}
                value={slMin}
                onChange={(e) => setSlMin(Number(e.target.value))}
                placeholder="Min"
              />
              <span className="text-zinc-400">to</span>
              <Input
                type="number"
                step={0.001}
                min={0.001}
                max={0.2}
                value={slMax}
                onChange={(e) => setSlMax(Number(e.target.value))}
                placeholder="Max"
              />
            </div>
            <div className="text-xs text-zinc-500">
              {(slMin * 100).toFixed(1)}% to {(slMax * 100).toFixed(1)}%
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-zinc-600">Take Profit Range</label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                step={0.001}
                min={0}
                max={0.2}
                value={tpMin}
                onChange={(e) => setTpMin(Number(e.target.value))}
                placeholder="Min"
              />
              <span className="text-zinc-400">to</span>
              <Input
                type="number"
                step={0.001}
                min={0}
                max={0.2}
                value={tpMax}
                onChange={(e) => setTpMax(Number(e.target.value))}
                placeholder="Max"
              />
            </div>
            <div className="text-xs text-zinc-500">
              {(tpMin * 100).toFixed(1)}% to {(tpMax * 100).toFixed(1)}%
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={runSweep} disabled={loading || !symbol}>
            {loading ? "Running Sweep..." : "Run Parameter Sweep"}
          </Button>
          {loading && (
            <span className="text-sm text-zinc-500">
              Running {steps * steps} backtests...
            </span>
          )}
        </div>

        {error && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </div>
        )}

        {results && (
          <div className="space-y-4">
            <div className="rounded-lg bg-emerald-50 p-4">
              <div className="text-sm font-medium text-emerald-700">Best Parameters</div>
              <div className="mt-1 grid gap-2 text-sm md:grid-cols-4">
                <div>
                  <span className="text-emerald-600">Stop Loss:</span>{" "}
                  {(results.bestResult.stopLossPct * 100).toFixed(2)}%
                </div>
                <div>
                  <span className="text-emerald-600">Take Profit:</span>{" "}
                  {(results.bestResult.takeProfitPct * 100).toFixed(2)}%
                </div>
                <div>
                  <span className="text-emerald-600">Return:</span>{" "}
                  {(results.bestResult.metrics.total_return_pct * 100).toFixed(2)}%
                </div>
                <div>
                  <span className="text-emerald-600">Win Rate:</span>{" "}
                  {(results.bestResult.metrics.win_rate * 100).toFixed(1)}%
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <Heatmap
                cells={heatmapCells}
                xAxisLabel="Stop Loss %"
                yAxisLabel="Take Profit %"
                valueLabel="Return"
                width={500}
                height={400}
              />
            </div>

            <div className="text-xs text-zinc-500">
              Ran {results.totalRuns} backtests on {results.symbol} using{" "}
              {results.template} template
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
