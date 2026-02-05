"use client";

import { useEffect, useState, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ReversalEntry,
  ReversalSettings,
  calculateEntryPnL,
  MEASUREMENT_LABELS,
  MEASUREMENT_FIELDS,
  MeasurementField,
} from "@/lib/reversal";

type Mover = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
};

type MoversData = {
  gainers: Mover[];
  losers: Mover[];
  timestamp: string;
};

type CohortsData = {
  cohorts: Record<string, ReversalEntry[]>;
};

const DEFAULT_SETTINGS: ReversalSettings = {
  position_size_usd: 100,
  commission_per_trade_usd: 1,
  short_borrow_rate_apr: 0.03,
  leverage_interest_apr: 0.08,
  leverage_multiplier: 1,
};

export default function ReversalPage() {
  const [movers, setMovers] = useState<MoversData | null>(null);
  const [cohorts, setCohorts] = useState<Record<string, ReversalEntry[]>>({});
  const [settings, setSettings] = useState<ReversalSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedGainers, setSelectedGainers] = useState<Set<string>>(new Set());
  const [selectedLosers, setSelectedLosers] = useState<Set<string>>(new Set());
  const [editingEntry, setEditingEntry] = useState<number | null>(null);
  const [measurementInputs, setMeasurementInputs] = useState<Record<string, string>>({});

  // Load data on mount
  useEffect(() => {
    loadSettings();
    loadCohorts();
  }, []);

  const loadSettings = async () => {
    try {
      const response = await fetch("/api/reversal/settings");
      const data = await response.json();
      if (data.settings) setSettings(data.settings);
    } catch (err) {
      console.error("Failed to load settings", err);
    }
  };

  const loadCohorts = async () => {
    try {
      const response = await fetch("/api/reversal");
      const data: CohortsData = await response.json();
      setCohorts(data.cohorts || {});
    } catch (err) {
      console.error("Failed to load cohorts", err);
    }
  };

  const fetchMovers = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/reversal/movers");
      if (!response.ok) throw new Error("Failed to fetch movers");
      const data: MoversData = await response.json();
      setMovers(data);
      // Auto-select top 5 of each
      setSelectedGainers(new Set(data.gainers.slice(0, 5).map((m) => m.symbol)));
      setSelectedLosers(new Set(data.losers.slice(0, 5).map((m) => m.symbol)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch movers");
    } finally {
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    try {
      const response = await fetch("/api/reversal/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!response.ok) throw new Error("Failed to save settings");
      setShowSettings(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    }
  };

  const createCohort = async () => {
    if (!movers) return;

    const today = new Date().toISOString().split("T")[0];
    const entries: Array<{
      symbol: string;
      direction: "LONG" | "SHORT";
      day_change_pct: number;
      entry_price: number;
    }> = [];

    // Losers -> LONG (buy expecting reversal up)
    for (const loser of movers.losers) {
      if (selectedLosers.has(loser.symbol)) {
        entries.push({
          symbol: loser.symbol,
          direction: "LONG",
          day_change_pct: loser.changePct,
          entry_price: loser.price,
        });
      }
    }

    // Gainers -> SHORT (sell expecting reversal down)
    for (const gainer of movers.gainers) {
      if (selectedGainers.has(gainer.symbol)) {
        entries.push({
          symbol: gainer.symbol,
          direction: "SHORT",
          day_change_pct: gainer.changePct,
          entry_price: gainer.price,
        });
      }
    }

    if (entries.length === 0) {
      setError("Select at least one stock to track");
      return;
    }

    try {
      const response = await fetch("/api/reversal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cohort_date: today, entries }),
      });
      if (!response.ok) throw new Error("Failed to create cohort");
      await loadCohorts();
      setMovers(null);
      setSelectedGainers(new Set());
      setSelectedLosers(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create cohort");
    }
  };

  const updateMeasurement = async (entryId: number, field: MeasurementField) => {
    const value = measurementInputs[`${entryId}-${field}`];
    if (!value) return;

    try {
      const response = await fetch(`/api/reversal/${entryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: parseFloat(value) }),
      });
      if (!response.ok) throw new Error("Failed to update measurement");
      await loadCohorts();
      setMeasurementInputs((prev) => ({ ...prev, [`${entryId}-${field}`]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    }
  };

  const markCompleted = async (entryId: number) => {
    try {
      // Find the entry and calculate final P&L
      let targetEntry: ReversalEntry | null = null;
      for (const entries of Object.values(cohorts)) {
        const found = entries.find((e) => e.id === entryId);
        if (found) {
          targetEntry = found;
          break;
        }
      }

      if (!targetEntry) return;

      const pnl = calculateEntryPnL(targetEntry, settings);

      await fetch(`/api/reversal/${entryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "COMPLETED",
          final_pnl_usd: pnl?.pnl_usd ?? null,
          final_pnl_pct: pnl?.pnl_pct ?? null,
        }),
      });
      await loadCohorts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark completed");
    }
  };

  // Calculate cohort summary stats
  const cohortStats = useMemo(() => {
    const stats: Record<
      string,
      { total: number; completed: number; totalPnl: number; winners: number }
    > = {};

    for (const [date, entries] of Object.entries(cohorts)) {
      let totalPnl = 0;
      let completed = 0;
      let winners = 0;

      for (const entry of entries) {
        if (entry.status === "COMPLETED" && entry.final_pnl_usd !== null) {
          completed++;
          totalPnl += entry.final_pnl_usd;
          if (entry.final_pnl_usd > 0) winners++;
        }
      }

      stats[date] = {
        total: entries.length,
        completed,
        totalPnl,
        winners,
      };
    }

    return stats;
  }, [cohorts]);

  const toggleSelection = (
    symbol: string,
    set: Set<string>,
    setter: React.Dispatch<React.SetStateAction<Set<string>>>
  ) => {
    const newSet = new Set(set);
    if (newSet.has(symbol)) {
      newSet.delete(symbol);
    } else {
      newSet.add(symbol);
    }
    setter(newSet);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Mean Reversion Study</h1>
          <p className="text-sm text-zinc-500">
            Track top gainers (short) and losers (long) to test reversal hypothesis
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowSettings(!showSettings)}>
            Settings
          </Button>
          <Button onClick={fetchMovers} disabled={loading}>
            {loading ? "Fetching..." : "Fetch Today's Movers"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>
      )}

      {/* Settings Panel */}
      {showSettings && (
        <Card>
          <CardHeader>
            <CardTitle>Study Settings</CardTitle>
            <CardDescription>Configure costs and position sizing</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1">
              <label className="text-sm text-zinc-600">Position Size ($)</label>
              <Input
                type="number"
                value={settings.position_size_usd}
                onChange={(e) =>
                  setSettings({ ...settings, position_size_usd: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm text-zinc-600">Commission per Trade ($)</label>
              <Input
                type="number"
                step="0.1"
                value={settings.commission_per_trade_usd}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    commission_per_trade_usd: Number(e.target.value),
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm text-zinc-600">Leverage Multiplier</label>
              <Input
                type="number"
                step="0.5"
                min="1"
                max="5"
                value={settings.leverage_multiplier}
                onChange={(e) =>
                  setSettings({ ...settings, leverage_multiplier: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm text-zinc-600">Short Borrow Rate (APR %)</label>
              <Input
                type="number"
                step="0.01"
                value={(settings.short_borrow_rate_apr * 100).toFixed(1)}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    short_borrow_rate_apr: Number(e.target.value) / 100,
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm text-zinc-600">Leverage Interest (APR %)</label>
              <Input
                type="number"
                step="0.1"
                value={(settings.leverage_interest_apr * 100).toFixed(1)}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    leverage_interest_apr: Number(e.target.value) / 100,
                  })
                }
              />
            </div>
            <div className="flex items-end">
              <Button onClick={saveSettings}>Save Settings</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Movers Selection */}
      {movers && (
        <Card>
          <CardHeader>
            <CardTitle>Select Stocks for Today's Cohort</CardTitle>
            <CardDescription>
              Fetched at {new Date(movers.timestamp).toLocaleTimeString()}. Select up to 5
              from each list.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 md:grid-cols-2">
              {/* Losers -> LONG */}
              <div>
                <h3 className="mb-2 text-sm font-medium text-red-600">
                  Top Losers → Buy (LONG)
                </h3>
                <div className="space-y-1">
                  {movers.losers.slice(0, 10).map((mover) => (
                    <div
                      key={mover.symbol}
                      className={`flex cursor-pointer items-center justify-between rounded-md border p-2 text-sm transition-colors ${
                        selectedLosers.has(mover.symbol)
                          ? "border-emerald-300 bg-emerald-50"
                          : "border-zinc-200 hover:bg-zinc-50"
                      }`}
                      onClick={() =>
                        toggleSelection(mover.symbol, selectedLosers, setSelectedLosers)
                      }
                    >
                      <div>
                        <span className="font-medium">{mover.symbol}</span>
                        <span className="ml-2 text-xs text-zinc-500">{mover.name}</span>
                      </div>
                      <div className="text-right">
                        <div className="font-mono">${mover.price.toFixed(2)}</div>
                        <div className="text-xs text-red-600">
                          {mover.changePct.toFixed(2)}%
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Gainers -> SHORT */}
              <div>
                <h3 className="mb-2 text-sm font-medium text-emerald-600">
                  Top Gainers → Sell (SHORT)
                </h3>
                <div className="space-y-1">
                  {movers.gainers.slice(0, 10).map((mover) => (
                    <div
                      key={mover.symbol}
                      className={`flex cursor-pointer items-center justify-between rounded-md border p-2 text-sm transition-colors ${
                        selectedGainers.has(mover.symbol)
                          ? "border-red-300 bg-red-50"
                          : "border-zinc-200 hover:bg-zinc-50"
                      }`}
                      onClick={() =>
                        toggleSelection(mover.symbol, selectedGainers, setSelectedGainers)
                      }
                    >
                      <div>
                        <span className="font-medium">{mover.symbol}</span>
                        <span className="ml-2 text-xs text-zinc-500">{mover.name}</span>
                      </div>
                      <div className="text-right">
                        <div className="font-mono">${mover.price.toFixed(2)}</div>
                        <div className="text-xs text-emerald-600">
                          +{mover.changePct.toFixed(2)}%
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between border-t pt-4">
              <div className="text-sm text-zinc-500">
                Selected: {selectedLosers.size} longs + {selectedGainers.size} shorts ={" "}
                {selectedLosers.size + selectedGainers.size} positions
              </div>
              <Button onClick={createCohort}>Create Today's Cohort</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Active Cohorts */}
      {Object.keys(cohorts).length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-medium text-zinc-900">Tracking Cohorts</h2>

          {Object.entries(cohorts)
            .sort(([a], [b]) => b.localeCompare(a))
            .map(([date, entries]) => {
              const stats = cohortStats[date];
              return (
                <Card key={date}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">Cohort: {date}</CardTitle>
                      <div className="flex items-center gap-2">
                        {stats && stats.completed > 0 && (
                          <Badge
                            className={
                              stats.totalPnl >= 0
                                ? "border-emerald-200 bg-emerald-100 text-emerald-700"
                                : "border-red-200 bg-red-100 text-red-700"
                            }
                          >
                            {stats.totalPnl >= 0 ? "+" : ""}${stats.totalPnl.toFixed(2)}
                          </Badge>
                        )}
                        <Badge>
                          {stats?.completed || 0}/{stats?.total || entries.length} done
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left text-xs text-zinc-500">
                            <th className="py-2">Symbol</th>
                            <th>Direction</th>
                            <th>Entry</th>
                            <th>D1 AM</th>
                            <th>D1 Mid</th>
                            <th>D1 PM</th>
                            <th>D2 AM</th>
                            <th>D2 Mid</th>
                            <th>D2 PM</th>
                            <th>D3 AM</th>
                            <th>D3 Mid</th>
                            <th>D3 PM</th>
                            <th>P&L</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {entries.map((entry) => {
                            const pnl = calculateEntryPnL(entry, settings);
                            return (
                              <tr
                                key={entry.id}
                                className="border-b last:border-0 hover:bg-zinc-50"
                              >
                                <td className="py-2 font-medium">{entry.symbol}</td>
                                <td>
                                  <Badge
                                    className={
                                      entry.direction === "LONG"
                                        ? "border-emerald-200 bg-emerald-100 text-emerald-700"
                                        : "border-red-200 bg-red-100 text-red-700"
                                    }
                                  >
                                    {entry.direction}
                                  </Badge>
                                </td>
                                <td className="font-mono">
                                  ${entry.entry_price.toFixed(2)}
                                </td>
                                {MEASUREMENT_FIELDS.map((field) => (
                                  <td key={field} className="px-1">
                                    {entry[field] !== null ? (
                                      <span className="font-mono text-xs">
                                        ${entry[field]!.toFixed(2)}
                                      </span>
                                    ) : editingEntry === entry.id ? (
                                      <div className="flex gap-1">
                                        <Input
                                          type="number"
                                          step="0.01"
                                          className="h-6 w-16 text-xs"
                                          value={
                                            measurementInputs[`${entry.id}-${field}`] || ""
                                          }
                                          onChange={(e) =>
                                            setMeasurementInputs((prev) => ({
                                              ...prev,
                                              [`${entry.id}-${field}`]: e.target.value,
                                            }))
                                          }
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                              updateMeasurement(entry.id, field);
                                            }
                                          }}
                                          placeholder="$"
                                        />
                                      </div>
                                    ) : (
                                      <span className="text-zinc-300">—</span>
                                    )}
                                  </td>
                                ))}
                                <td className="px-1">
                                  {pnl ? (
                                    <span
                                      className={`font-mono text-xs font-medium ${
                                        pnl.pnl_usd >= 0
                                          ? "text-emerald-600"
                                          : "text-red-600"
                                      }`}
                                    >
                                      {pnl.pnl_usd >= 0 ? "+" : ""}${pnl.pnl_usd.toFixed(2)}
                                    </span>
                                  ) : (
                                    <span className="text-zinc-300">—</span>
                                  )}
                                </td>
                                <td className="px-1">
                                  {entry.status === "ACTIVE" ? (
                                    <div className="flex gap-1">
                                      {editingEntry === entry.id ? (
                                        <Button
                                          variant="secondary"
                                          className="h-6 px-2 text-xs"
                                          onClick={() => setEditingEntry(null)}
                                        >
                                          Done
                                        </Button>
                                      ) : (
                                        <Button
                                          variant="secondary"
                                          className="h-6 px-2 text-xs"
                                          onClick={() => setEditingEntry(entry.id)}
                                        >
                                          Edit
                                        </Button>
                                      )}
                                      <Button
                                        variant="secondary"
                                        className="h-6 px-2 text-xs"
                                        onClick={() => markCompleted(entry.id)}
                                      >
                                        Close
                                      </Button>
                                    </div>
                                  ) : (
                                    <Badge className="border-zinc-200 bg-zinc-100 text-zinc-600">
                                      Closed
                                    </Badge>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
        </div>
      )}

      {/* Empty state */}
      {Object.keys(cohorts).length === 0 && !movers && (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="text-zinc-500">
              No cohorts yet. Click "Fetch Today's Movers" to start tracking.
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary Stats */}
      {Object.keys(cohorts).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Overall Statistics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-4">
              <div>
                <div className="text-xs uppercase text-zinc-500">Total Cohorts</div>
                <div className="text-lg font-medium">{Object.keys(cohorts).length}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-zinc-500">Total Positions</div>
                <div className="text-lg font-medium">
                  {Object.values(cohorts).reduce((sum, c) => sum + c.length, 0)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase text-zinc-500">Completed</div>
                <div className="text-lg font-medium">
                  {Object.values(cohortStats).reduce((sum, s) => sum + s.completed, 0)}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase text-zinc-500">Total P&L</div>
                <div
                  className={`text-lg font-medium ${
                    Object.values(cohortStats).reduce((sum, s) => sum + s.totalPnl, 0) >= 0
                      ? "text-emerald-600"
                      : "text-red-600"
                  }`}
                >
                  $
                  {Object.values(cohortStats)
                    .reduce((sum, s) => sum + s.totalPnl, 0)
                    .toFixed(2)}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
