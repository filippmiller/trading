"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { scenarios } from "@/lib/scenarios";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TickerDownloader } from "@/components/TickerDownloader";

const STORAGE_KEY = "scenarios:last";
const SYMBOL_STORAGE_KEY = "symbols:last";

type ValuesMap = Record<string, Record<string, number | boolean>>;

function buildInitialValues(): ValuesMap {
  const map: ValuesMap = {};
  for (const scenario of scenarios) {
    map[scenario.id] = { ...scenario.defaultValues };
  }
  return map;
}

const getErrorMessage = (err: unknown) =>
  err instanceof Error ? err.message : "Failed to run backtest.";

type ScenariosSectionProps = {
  title?: string;
  symbolOverride?: string;
  symbolsOverride?: string[];
  onSymbolChange?: (symbol: string) => void;
};

export function ScenariosSection({
  title = "Scenarios",
  symbolOverride,
  symbolsOverride,
  onSymbolChange,
}: ScenariosSectionProps) {
  const router = useRouter();
  const [active, setActive] = useState(scenarios[0]?.id ?? "");
  const [valuesMap, setValuesMap] = useState<ValuesMap>(buildInitialValues);
  const [symbols, setSymbols] = useState<string[]>(symbolsOverride ?? []);
  const [symbol, setSymbol] = useState(symbolOverride ?? "");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const effectiveSymbols = symbolsOverride ?? symbols;
  const effectiveSymbol = symbolOverride ?? symbol;
  const isSymbolControlled = symbolOverride !== undefined;
  const isSymbolsControlled = symbolsOverride !== undefined;

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (stored && scenarios.find((item) => item.id === stored)) {
      setActive(stored);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (active) {
      window.localStorage.setItem(STORAGE_KEY, active);
    }
  }, [active]);

  const loadSymbols = async () => {
    if (isSymbolsControlled) {
      setSymbols(symbolsOverride ?? []);
      return symbolsOverride ?? [];
    }
    try {
      const response = await fetch("/api/symbols");
      const payload = await response.json();
      const items = Array.isArray(payload.items) ? payload.items : [];
      setSymbols(items);
      if (typeof window === "undefined") return items;
      const saved = window.localStorage.getItem(SYMBOL_STORAGE_KEY);
      if (saved && items.includes(saved)) {
        setSymbol(saved);
      } else if (items.length) {
        setSymbol(items[0]);
      }
      return items;
    } catch {
      setSymbols([]);
      return [];
    }
  };

  useEffect(() => {
    loadSymbols();
  }, [isSymbolsControlled, symbolsOverride]);

  useEffect(() => {
    if (isSymbolControlled) return;
    if (typeof window === "undefined") return;
    if (symbol) {
      window.localStorage.setItem(SYMBOL_STORAGE_KEY, symbol);
    }
  }, [symbol, isSymbolControlled]);

  const activeScenario = scenarios.find((item) => item.id === active) ?? scenarios[0];
  const activeValues = valuesMap[activeScenario.id];

  // Tri-state: { spec } → valid; { error } → buildSpec rejected the form values;
  // { notReady: true } → waiting on a ticker selection. Previously all three collapsed
  // to "Invalid parameters." which misled users into hunting for form mistakes
  // when the real issue was "no ticker downloaded yet."
  const specPreview = useMemo<
    | { spec: ReturnType<typeof activeScenario.buildSpec> }
    | { error: string }
    | { notReady: true }
  >(() => {
    if (!effectiveSymbol) return { notReady: true };
    try {
      return { spec: activeScenario.buildSpec(activeValues, 60, effectiveSymbol) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [activeScenario, activeValues, effectiveSymbol]);

  const updateValue = (scenarioId: string, key: string, value: number | boolean) => {
    setValuesMap((prev) => ({
      ...prev,
      [scenarioId]: {
        ...prev[scenarioId],
        [key]: value,
      },
    }));
  };

  const runNow = async (lookbackDays: number) => {
    if (!activeScenario) return;
    if (!effectiveSymbol) {
      setError("Select a ticker with downloaded data.");
      return;
    }
    setError(null);
    setRunning(`${activeScenario.id}-${lookbackDays}`);
    try {
      const spec = activeScenario.buildSpec(valuesMap[activeScenario.id], lookbackDays, effectiveSymbol);
      const response = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spec,
          preset_name: activeScenario.name,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Backtest failed.");
      }
      const payload = await response.json();
      router.push(`/runs/${payload.id}`);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setRunning(null);
    }
  };

  const copySpec = async () => {
    if (!specPreview) return;
    await navigator.clipboard.writeText(JSON.stringify(specPreview, null, 2));
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="text-sm text-zinc-500">Curated, editable presets with quick runs.</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-zinc-500">Ticker</span>
          <select
            className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm"
            value={effectiveSymbol}
            onChange={(event) =>
              isSymbolControlled ? onSymbolChange?.(event.target.value) : setSymbol(event.target.value)
            }
            disabled={!effectiveSymbols.length || (isSymbolControlled && !onSymbolChange)}
          >
            {!effectiveSymbols.length && <option value="">No tickers</option>}
            {effectiveSymbols.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
      </div>

      {effectiveSymbols.length === 0 && (
        <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-3 space-y-2">
          <div className="text-sm text-zinc-600">No tickers downloaded yet.</div>
          <TickerDownloader
            hint="Pick any US ticker — pulls ~60d OHLC and enables every scenario."
            onDownloaded={async (sym) => {
              const items = await loadSymbols();
              if (!isSymbolControlled && items.includes(sym)) {
                setSymbol(sym);
                onSymbolChange?.(sym);
              }
            }}
          />
        </div>
      )}

      <Tabs value={active} onValueChange={setActive}>
        <TabsList className="flex flex-wrap gap-2 bg-transparent p-0">
          {scenarios.map((scenario) => (
            <TabsTrigger key={scenario.id} value={scenario.id} className="bg-zinc-100">
              {scenario.name}
            </TabsTrigger>
          ))}
        </TabsList>
        {scenarios.map((scenario) => {
          const values = valuesMap[scenario.id];
          return (
            <TabsContent key={scenario.id} value={scenario.id}>
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">{scenario.name}</CardTitle>
                  {/* Using a plain div instead of CardDescription (which is a <p>)
                      because nested <div> inside <p> is invalid HTML and produces
                      a hydration error. */}
                  <div className="text-sm text-zinc-500">
                    <div>{scenario.description_en}</div>
                    <div>{scenario.description_ru}</div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {scenario.riskWarning && (
                    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                      {scenario.riskWarning}
                    </div>
                  )}

                  <div className="grid gap-3 md:grid-cols-2">
                    {scenario.fields.map((field) => (
                      <label key={field.key} className="flex items-center justify-between gap-4 text-sm">
                        <span className="text-zinc-700">{field.label}</span>
                        {field.type === "checkbox" ? (
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={Boolean(values[field.key])}
                            onChange={(event) =>
                              updateValue(scenario.id, field.key, event.target.checked)
                            }
                          />
                        ) : (
                          <Input
                            type="number"
                            step={field.step ?? 0.01}
                            min={field.min}
                            max={field.max}
                            value={Number(values[field.key] ?? 0)}
                            onChange={(event) =>
                              updateValue(scenario.id, field.key, Number(event.target.value))
                            }
                            className="max-w-[160px]"
                          />
                        )}
                      </label>
                    ))}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => runNow(30)}
                      disabled={running !== null || !effectiveSymbol}
                    >
                      Run now (30d)
                    </Button>
                    <Button
                      onClick={() => runNow(60)}
                      variant="secondary"
                      disabled={running !== null || !effectiveSymbol}
                    >
                      Run now (60d)
                    </Button>
                    <Button
                      onClick={() => runNow(180)}
                      variant="outline"
                      disabled={running !== null || !effectiveSymbol}
                    >
                      Run now (6mo)
                    </Button>
                    <Button onClick={copySpec} variant="ghost" disabled={!specPreview}>
                      Copy StrategySpec
                    </Button>
                  </div>

                  {error && <div className="text-sm text-red-600">{error}</div>}

                  <div className="rounded-lg bg-zinc-950/5 p-3 text-xs text-zinc-700">
                    <div className="mb-2 text-xs font-semibold text-zinc-600">
                      StrategySpec preview
                    </div>
                    {"spec" in specPreview && (
                      <pre className="whitespace-pre-wrap">{JSON.stringify(specPreview.spec, null, 2)}</pre>
                    )}
                    {"error" in specPreview && (
                      <div className="text-rose-600">
                        <div className="font-semibold mb-1">Invalid parameters</div>
                        <div className="font-mono text-[11px]">{specPreview.error}</div>
                      </div>
                    )}
                    {"notReady" in specPreview && (
                      <div className="text-zinc-500 italic">
                        Select a ticker above to preview the StrategySpec.
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          );
        })}
      </Tabs>
    </section>
  );
}
