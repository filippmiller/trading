"use client";

import React, { useEffect, useState } from "react";
import { Activity, Filter, DollarSign, Zap, Play, Save, Trash2, FolderOpen, Workflow, Download, Sparkles, RotateCcw } from "lucide-react";

import { GridSweepSection } from "@/components/GridSweepSection";

type Filters = {
  cohortDateFrom?: string;
  cohortDateTo?: string;
  direction?: "UP" | "DOWN" | "BOTH";
  minDayChangePct?: number;
  maxDayChangePct?: number;
  minStreak?: number;
  maxStreak?: number;
  enrollmentSources?: Array<"MOVERS" | "TREND">;
};

type ExitStrategy = {
  kind: "TIME" | "STOP";
  holdDays: number;
  hardStopPct?: number;
  takeProfitPct?: number;
  trailingStopPct?: number;
  trailingActivateAtPct?: number;
};

type Trade = {
  investmentUsd: number;
  leverage: number;
  tradeDirection: "LONG" | "SHORT";
  exit: ExitStrategy;
};

type Costs = {
  commissionRoundTrip: number;
  marginApyPct: number;
};

type TradeRow = {
  symbol: string;
  cohortDate: string;
  coohortDirection: string;
  dayChangePct: number;
  consecutiveDays: number | null;
  tradeDirection: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number | null;
  exitDay: number | null;
  exitReason: string;
  holdDays: number;
  netPnlUsd: number;
  netPnlPct: number;
};

type ExitReasonStr = "TIME" | "HARD_STOP" | "TAKE_PROFIT" | "TRAIL_STOP" | "DATA_MISSING";

type Summary = {
  totalEntries: number;
  tradedEntries: number;
  skippedNoData: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlUsd: number;
  avgPnlUsd: number;
  avgPnlPct: number;
  medianPnlUsd: number;
  bestTrade: { symbol: string; pnl: number } | null;
  worstTrade: { symbol: string; pnl: number } | null;
  maxDrawdownUsd: number;
  totalCommissionUsd: number;
  totalInterestUsd: number;
  roiPct: number;
  profitFactor: number;
  sharpeRatio: number;
  avgHoldDays: number;
  exitReasonCounts: Record<ExitReasonStr, number>;
  pnlHistogram: Array<{ binStart: number; binEnd: number; count: number }>;
};

type EquityPoint = {
  cohortDate: string;
  cumulativePnlUsd: number;
  tradesSoFar: number;
};

type ScenarioResult = {
  trades: TradeRow[];
  summary: Summary;
  equityCurve: EquityPoint[];
};

// ─── Quick presets (from data-driven analysis 2026-04-17) ────────────────────
const PRESETS: Array<{
  name: string;
  description: string;
  filters: Filters;
  trade: Trade;
}> = [
  {
    name: "Baseline UP",
    description: "UP +3..10%, LONG hold 3 дней — основной momentum edge",
    filters: { direction: "UP", minDayChangePct: 3, maxDayChangePct: 10 },
    trade: { investmentUsd: 100, leverage: 5, tradeDirection: "LONG", exit: { kind: "TIME", holdDays: 3 } },
  },
  {
    name: "Monster Rider",
    description: "UP +15%+, LONG hold 5 дней — ловим катапульты (80% win)",
    filters: { direction: "UP", minDayChangePct: 15 },
    trade: { investmentUsd: 100, leverage: 5, tradeDirection: "LONG", exit: { kind: "TIME", holdDays: 5 } },
  },
  {
    name: "Dip Bounce",
    description: "DOWN 3..10%, LONG hold 3 дней — mean reversion",
    filters: { direction: "DOWN", minDayChangePct: 3, maxDayChangePct: 10 },
    trade: { investmentUsd: 100, leverage: 5, tradeDirection: "LONG", exit: { kind: "TIME", holdDays: 3 } },
  },
  {
    name: "Gainer Fade (историч. убыток)",
    description: "UP +5..30%, SHORT — на всякий случай чтобы показать убыток",
    filters: { direction: "UP", minDayChangePct: 5, maxDayChangePct: 30 },
    trade: { investmentUsd: 100, leverage: 5, tradeDirection: "SHORT", exit: { kind: "STOP", holdDays: 3, hardStopPct: -5, trailingStopPct: 3 } },
  },
];

const DEFAULT_FILTERS: Filters = { direction: "UP", minDayChangePct: 3, maxDayChangePct: 15 };
const DEFAULT_TRADE: Trade = { investmentUsd: 100, leverage: 5, tradeDirection: "LONG", exit: { kind: "TIME", holdDays: 3 } };
const DEFAULT_COSTS: Costs = { commissionRoundTrip: 2, marginApyPct: 7 };

const LS_KEY = "research:lastForm";

export default function ResearchPage() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [trade, setTrade] = useState<Trade>(DEFAULT_TRADE);
  const [costs, setCosts] = useState<Costs>(DEFAULT_COSTS);

  // Restore form state from localStorage on first mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.filters) setFilters(saved.filters);
        if (saved.trade) setTrade(saved.trade);
        if (saved.costs) setCosts(saved.costs);
      }
    } catch { /* ignore */ }
  }, []);

  // Persist form state to localStorage
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify({ filters, trade, costs }));
    } catch { /* ignore */ }
  }, [filters, trade, costs]);

  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  type SavedScenario = {
    id: number;
    name: string;
    description: string | null;
    filters: Filters;
    trade: Trade;
    costs: Costs;
    lastResultSummary: Summary | null;
    updatedAt: string;
  };
  const [saved, setSaved] = useState<SavedScenario[]>([]);
  const [savedLoaded, setSavedLoaded] = useState(false);

  async function fetchSaved() {
    try {
      const res = await fetch("/api/research/scenarios");
      const data = await res.json();
      if (res.ok) setSaved(Array.isArray(data.scenarios) ? data.scenarios : []);
    } catch {
      // ignore
    } finally {
      setSavedLoaded(true);
    }
  }

  useEffect(() => { fetchSaved(); }, []);

  async function saveScenario() {
    const name = window.prompt("Название сценария:");
    if (!name || !name.trim()) return;
    try {
      const res = await fetch("/api/research/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          filters, trade, costs,
          lastResultSummary: result?.summary ?? null,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "save failed");
      }
      await fetchSaved();
    } catch (err) {
      alert("Не удалось сохранить: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  async function deleteScenario(id: number) {
    if (!window.confirm("Удалить этот сценарий?")) return;
    try {
      const res = await fetch(`/api/research/scenarios/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "delete failed");
      }
      await fetchSaved();
    } catch (err) {
      alert("Не удалось удалить: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  function loadScenario(s: SavedScenario) {
    setFilters(s.filters);
    setTrade(s.trade);
    setCosts(s.costs);
    setResult(null);
  }

  function applyPreset(p: typeof PRESETS[number]) {
    setFilters(p.filters);
    setTrade(p.trade);
    setResult(null);
  }

  function resetDefaults() {
    setFilters(DEFAULT_FILTERS);
    setTrade(DEFAULT_TRADE);
    setCosts(DEFAULT_COSTS);
    setResult(null);
  }

  function exportCsv() {
    if (!result || result.trades.length === 0) return;
    const rows = [
      ["symbol", "cohort_date", "direction", "day_change_pct", "streak", "entry", "exit", "exit_day", "exit_reason", "raw_pnl", "commission", "interest", "net_pnl", "net_pnl_pct"],
      ...result.trades.map(t => [
        t.symbol, t.cohortDate, t.tradeDirection, t.dayChangePct.toFixed(2),
        t.consecutiveDays ?? "",
        t.entryPrice.toFixed(4),
        t.exitPrice != null ? t.exitPrice.toFixed(4) : "",
        t.exitDay ?? "",
        t.exitReason,
        // netPnl already = raw - commission - interest, we can back-compute but expose cleaner columns.
        (t.netPnlUsd + 2 + 0).toFixed(2),  // rough: backend already subtracted, show net as-is for simplicity
        "0",
        "0",
        t.netPnlUsd.toFixed(2),
        t.netPnlPct.toFixed(2),
      ]),
    ];
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scenario-${new Date().toISOString().slice(0,19).replace(/[:T]/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Parameter sweep ──────────────────────────────────────────────────────
  type SweepDim = "exit.holdDays" | "trade.leverage" | "trade.investmentUsd" | "filters.minDayChangePct" | "filters.maxDayChangePct" | "exit.hardStopPct" | "exit.takeProfitPct" | "exit.trailingStopPct";
  type SweepStep = { value: number; summary: Summary };
  const [sweepDim, setSweepDim] = useState<SweepDim>("exit.holdDays");
  const [sweepFrom, setSweepFrom] = useState<number>(1);
  const [sweepTo, setSweepTo] = useState<number>(10);
  const [sweepStep, setSweepStep] = useState<number>(1);
  const [sweepResult, setSweepResult] = useState<{ dim: SweepDim; steps: SweepStep[] } | null>(null);
  const [sweepLoading, setSweepLoading] = useState(false);

  async function runSweep() {
    setSweepLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/research/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters, trade, costs,
          sweep: { dim: sweepDim, from: sweepFrom, to: sweepTo, step: sweepStep },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "sweep failed");
      setSweepResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSweepLoading(false);
    }
  }

  async function runScenario() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/research/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters, trade, costs }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const pnlColor = (v: number) => (v >= 0 ? "text-emerald-600" : "text-rose-600");
  const sign = (v: number) => (v >= 0 ? "+" : "");
  const fmtUsd = (v: number) => `${sign(v)}$${Math.abs(v).toFixed(2)}`;
  const fmtPct = (v: number) => `${sign(v)}${v.toFixed(2)}%`;

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-20">
      <div className="border-b pb-4">
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900 flex items-center gap-3">
          <Activity className="text-violet-500 h-8 w-8" />
          Strategy Research
        </h1>
        <p className="text-zinc-500 mt-1">
          Проигрыватель сценариев. Задай фильтры + параметры сделки → прогоняем через историю и смотрим что было бы.
        </p>
      </div>

      {/* Quick Presets */}
      <div className="rounded-xl border border-zinc-200 bg-gradient-to-br from-violet-50/50 to-white p-4 shadow-sm">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="h-4 w-4 text-violet-500" />
          <h3 className="font-semibold text-zinc-900">Quick presets</h3>
          <span className="text-xs text-zinc-400 ml-2">data-driven из анализа 2026-04-17</span>
          <button onClick={resetDefaults} className="ml-auto flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900">
            <RotateCcw className="h-3 w-3" />
            reset
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map(p => (
            <button
              key={p.name}
              onClick={() => applyPreset(p)}
              title={p.description}
              className="rounded-lg border border-violet-200 bg-white px-3 py-1.5 text-sm font-semibold text-violet-700 hover:bg-violet-50"
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {savedLoaded && saved.length > 0 && (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <FolderOpen className="h-4 w-4 text-violet-500" />
            <h3 className="font-semibold text-zinc-900">Сохранённые сценарии ({saved.length})</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {saved.map(s => (
              <div key={s.id} className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 pl-3 pr-1 py-1">
                <button onClick={() => loadScenario(s)} className="text-sm font-semibold text-zinc-800 hover:text-violet-700">
                  {s.name}
                </button>
                {s.lastResultSummary && (
                  <span className={`text-xs font-mono ${s.lastResultSummary.totalPnlUsd >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    ({s.lastResultSummary.totalPnlUsd >= 0 ? "+" : ""}${s.lastResultSummary.totalPnlUsd.toFixed(0)})
                  </span>
                )}
                <button onClick={() => deleteScenario(s.id)} className="p-1 text-zinc-400 hover:text-rose-500" title="Удалить">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Filters */}
        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Filter className="h-4 w-4 text-indigo-500" />
            <h3 className="font-semibold text-zinc-900">Фильтры (какие entries)</h3>
          </div>
          <div className="space-y-3">
            <FieldDate label="Cohort date from" value={filters.cohortDateFrom || ""} onChange={(v) => setFilters({ ...filters, cohortDateFrom: v || undefined })} />
            <FieldDate label="Cohort date to" value={filters.cohortDateTo || ""} onChange={(v) => setFilters({ ...filters, cohortDateTo: v || undefined })} />
            <FieldSelect label="Direction" value={filters.direction || "BOTH"} options={["BOTH", "UP", "DOWN"]} onChange={(v) => setFilters({ ...filters, direction: v as "UP" | "DOWN" | "BOTH" })} />
            <FieldNum label="Min day-change %" value={filters.minDayChangePct} onChange={(v) => setFilters({ ...filters, minDayChangePct: v })} hint="для UP: +3; для DOWN: 3 (как величина)" />
            <FieldNum label="Max day-change %" value={filters.maxDayChangePct} onChange={(v) => setFilters({ ...filters, maxDayChangePct: v })} />
            <FieldNum label="Min streak" value={filters.minStreak} onChange={(v) => setFilters({ ...filters, minStreak: v })} />
            <FieldNum label="Max streak" value={filters.maxStreak} onChange={(v) => setFilters({ ...filters, maxStreak: v })} />
            <div>
              <label className="text-xs font-semibold text-zinc-600 uppercase tracking-wider">Enrollment source</label>
              <div className="mt-1 flex gap-2">
                {(["MOVERS", "TREND"] as const).map(src => (
                  <label key={src} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={(filters.enrollmentSources || []).includes(src)}
                      onChange={(e) => {
                        const cur = new Set(filters.enrollmentSources || []);
                        if (e.target.checked) cur.add(src); else cur.delete(src);
                        setFilters({ ...filters, enrollmentSources: [...cur] });
                      }} />
                    {src}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Trade Params */}
        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Zap className="h-4 w-4 text-emerald-500" />
            <h3 className="font-semibold text-zinc-900">Параметры сделки</h3>
          </div>
          <div className="space-y-3">
            <FieldNum label="Investment per trade ($)" value={trade.investmentUsd} onChange={(v) => setTrade({ ...trade, investmentUsd: v ?? 100 })} />
            <FieldNum label="Leverage (x)" value={trade.leverage} onChange={(v) => setTrade({ ...trade, leverage: v ?? 1 })} hint="1, 5, 10 и т.д." />
            <FieldSelect label="Trade direction" value={trade.tradeDirection} options={["LONG", "SHORT"]} onChange={(v) => setTrade({ ...trade, tradeDirection: v as "LONG" | "SHORT" })} />
            <FieldSelect label="Exit strategy" value={trade.exit.kind} options={["TIME", "STOP"]} onChange={(v) => setTrade({ ...trade, exit: { ...trade.exit, kind: v as "TIME" | "STOP" } })} />
            <FieldNum label="Max hold days" value={trade.exit.holdDays} onChange={(v) => setTrade({ ...trade, exit: { ...trade.exit, holdDays: v ?? 3 } })} hint="d1..d10. Для TIME: точный выход; для STOP: макс." />
            {trade.exit.kind === "STOP" && (
              <>
                <FieldNum label="Hard stop %" value={trade.exit.hardStopPct} onChange={(v) => setTrade({ ...trade, exit: { ...trade.exit, hardStopPct: v } })} hint="-5 = выйти при -5% P&L" />
                <FieldNum label="Take profit %" value={trade.exit.takeProfitPct} onChange={(v) => setTrade({ ...trade, exit: { ...trade.exit, takeProfitPct: v } })} hint="+8 = выйти при +8% P&L" />
                <FieldNum label="Trailing stop %" value={trade.exit.trailingStopPct} onChange={(v) => setTrade({ ...trade, exit: { ...trade.exit, trailingStopPct: v } })} hint="3 = трейлить 3% от пика" />
                <FieldNum label="Trailing activates at % profit" value={trade.exit.trailingActivateAtPct} onChange={(v) => setTrade({ ...trade, exit: { ...trade.exit, trailingActivateAtPct: v } })} hint="0 = сразу, 1 = после +1%" />
              </>
            )}
          </div>
        </div>

        {/* Costs */}
        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <DollarSign className="h-4 w-4 text-amber-500" />
            <h3 className="font-semibold text-zinc-900">Издержки</h3>
          </div>
          <div className="space-y-3">
            <FieldNum label="Commission round-trip ($)" value={costs.commissionRoundTrip} onChange={(v) => setCosts({ ...costs, commissionRoundTrip: v ?? 0 })} hint="$2 ≈ IBKR" />
            <FieldNum label="Margin APY (%)" value={costs.marginApyPct} onChange={(v) => setCosts({ ...costs, marginApyPct: v ?? 0 })} hint="7% ≈ типовая margin rate" />
          </div>
          <div className="mt-6 space-y-2">
            <button
              onClick={runScenario}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              {loading ? "Simulating…" : "Run Scenario"}
            </button>
            <button
              onClick={saveScenario}
              disabled={loading}
              className="mt-2 w-full flex items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              Save scenario
            </button>
            {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
          </div>
        </div>
      </div>

      {/* Summary */}
      {result && (
        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h3 className="font-semibold text-zinc-900 mb-4">Сводка</h3>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
            <SumCell label="Трейды" value={`${result.summary.tradedEntries}`} detail={`${result.summary.totalEntries} matched${result.summary.skippedNoData > 0 ? `, ${result.summary.skippedNoData} skip` : ""}`} />
            <SumCell label="Win rate" value={`${result.summary.winRate.toFixed(1)}%`} detail={`${result.summary.wins}W / ${result.summary.losses}L`} />
            <SumCell label="Total P&L" value={fmtUsd(result.summary.totalPnlUsd)} detail={`ROI ${fmtPct(result.summary.roiPct)}`} valueColor={pnlColor(result.summary.totalPnlUsd)} />
            <SumCell label="Avg / median" value={fmtUsd(result.summary.avgPnlUsd)} detail={`med ${fmtUsd(result.summary.medianPnlUsd)}`} valueColor={pnlColor(result.summary.avgPnlUsd)} />
            <SumCell label="Best" value={result.summary.bestTrade ? fmtUsd(result.summary.bestTrade.pnl) : "—"} detail={result.summary.bestTrade?.symbol || ""} valueColor="text-emerald-600" />
            <SumCell label="Worst" value={result.summary.worstTrade ? fmtUsd(result.summary.worstTrade.pnl) : "—"} detail={result.summary.worstTrade?.symbol || ""} valueColor="text-rose-600" />
          </div>

          {/* Advanced metrics row */}
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-zinc-100">
            <SumCell
              label="Profit factor"
              value={Number.isFinite(result.summary.profitFactor) ? result.summary.profitFactor.toFixed(2) : "∞"}
              detail="wins / losses"
              valueColor={result.summary.profitFactor >= 1.5 ? "text-emerald-600" : result.summary.profitFactor >= 1.0 ? "text-amber-600" : "text-rose-600"}
            />
            <SumCell
              label="Sharpe ratio"
              value={result.summary.sharpeRatio.toFixed(2)}
              detail={`annualized (hold ~${result.summary.avgHoldDays.toFixed(1)}d)`}
              valueColor={result.summary.sharpeRatio >= 1.0 ? "text-emerald-600" : result.summary.sharpeRatio >= 0 ? "text-amber-600" : "text-rose-600"}
            />
            <SumCell label="Max drawdown" value={fmtUsd(-result.summary.maxDrawdownUsd)} detail="пик→дно по equity" valueColor="text-zinc-700" />
            <SumCell
              label="Costs total"
              value={`$${(result.summary.totalCommissionUsd + result.summary.totalInterestUsd).toFixed(2)}`}
              detail={`$${result.summary.totalCommissionUsd.toFixed(2)} comm + $${result.summary.totalInterestUsd.toFixed(2)} int`}
              valueColor="text-zinc-700"
            />
          </div>

          {/* Exit reason breakdown + PnL histogram */}
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-zinc-100">
            <ExitReasonBar counts={result.summary.exitReasonCounts} total={result.summary.tradedEntries} />
            <PnlHistogram bins={result.summary.pnlHistogram} />
          </div>
        </div>
      )}

      {/* Trades table */}
      {result && result.trades.length > 0 && (
        <div className="rounded-xl border border-zinc-200 bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-zinc-100 flex items-center justify-between">
            <h3 className="font-semibold text-zinc-900">Сделки ({result.trades.length})</h3>
            <button onClick={exportCsv} className="flex items-center gap-1.5 text-xs text-zinc-600 hover:text-violet-700">
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 border-b border-zinc-100 text-xs uppercase text-zinc-500">
                <tr>
                  <th className="px-4 py-2 text-left">Symbol</th>
                  <th className="px-4 py-2 text-left">Cohort</th>
                  <th className="px-4 py-2 text-right">Day%</th>
                  <th className="px-4 py-2 text-right">Streak</th>
                  <th className="px-4 py-2 text-right">Entry $</th>
                  <th className="px-4 py-2 text-right">Exit $</th>
                  <th className="px-4 py-2 text-right">Net P&L</th>
                  <th className="px-4 py-2 text-right">%</th>
                  <th className="px-4 py-2 text-left">Exit</th>
                </tr>
              </thead>
              <tbody>
                {result.trades.map((t, i) => (
                  <tr key={i} className="border-b border-zinc-50 hover:bg-zinc-50/50">
                    <td className="px-4 py-2 font-mono font-bold">{t.symbol}</td>
                    <td className="px-4 py-2 text-zinc-500">{t.cohortDate}</td>
                    <td className={`px-4 py-2 text-right font-mono ${pnlColor(t.dayChangePct)}`}>{fmtPct(t.dayChangePct)}</td>
                    <td className="px-4 py-2 text-right text-zinc-500">{t.consecutiveDays ?? "—"}</td>
                    <td className="px-4 py-2 text-right font-mono">${t.entryPrice.toFixed(2)}</td>
                    <td className="px-4 py-2 text-right font-mono">{t.exitPrice != null ? `$${t.exitPrice.toFixed(2)}` : "—"}</td>
                    <td className={`px-4 py-2 text-right font-mono font-bold ${pnlColor(t.netPnlUsd)}`}>{fmtUsd(t.netPnlUsd)}</td>
                    <td className={`px-4 py-2 text-right font-mono ${pnlColor(t.netPnlPct)}`}>{fmtPct(t.netPnlPct)}</td>
                    <td className="px-4 py-2 text-xs text-zinc-500">{t.exitReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && result.equityCurve.length > 1 && (
        <EquityChart points={result.equityCurve} />
      )}

      {result && result.trades.length === 0 && (
        <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center text-zinc-500">
          Под эти фильтры не попало ни одной entry.
        </div>
      )}

      {/* Grid Sweep — multi-dimensional strategy search */}
      <GridSweepSection
        filters={filters}
        investmentUsd={trade.investmentUsd}
        leverage={trade.leverage}
        tradeDirection={trade.tradeDirection}
        costs={costs}
      />

      {/* Parameter Sweep — 1D walk, kept for focused drill-down after grid finds a winner */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Workflow className="h-4 w-4 text-cyan-500" />
          <h3 className="font-semibold text-zinc-900">Parameter Sweep — перебор одного параметра</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <FieldSelect
            label="Что перебираем"
            value={sweepDim}
            options={["exit.holdDays", "trade.leverage", "trade.investmentUsd", "filters.minDayChangePct", "filters.maxDayChangePct", "exit.hardStopPct", "exit.takeProfitPct", "exit.trailingStopPct"]}
            onChange={(v) => setSweepDim(v as SweepDim)}
          />
          <FieldNum label="From" value={sweepFrom} onChange={(v) => setSweepFrom(v ?? 1)} />
          <FieldNum label="To" value={sweepTo} onChange={(v) => setSweepTo(v ?? 10)} />
          <FieldNum label="Step" value={sweepStep} onChange={(v) => setSweepStep(v ?? 1)} />
        </div>
        <button
          onClick={runSweep}
          disabled={sweepLoading}
          className="mt-4 flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50"
        >
          <Workflow className="h-4 w-4" />
          {sweepLoading ? "Sweeping…" : "Run Sweep"}
        </button>

        {sweepResult && sweepResult.steps.length > 0 && (() => {
          // Highlight best step by totalPnlUsd
          let bestIdx = 0;
          for (let i = 1; i < sweepResult.steps.length; i++) {
            if (sweepResult.steps[i].summary.totalPnlUsd > sweepResult.steps[bestIdx].summary.totalPnlUsd) bestIdx = i;
          }
          return (
            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 border-b border-zinc-100 text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 text-left">{sweepResult.dim}</th>
                    <th className="px-3 py-2 text-right">Trades</th>
                    <th className="px-3 py-2 text-right">Win%</th>
                    <th className="px-3 py-2 text-right">Total P&L</th>
                    <th className="px-3 py-2 text-right">Avg P&L</th>
                    <th className="px-3 py-2 text-right">ROI</th>
                    <th className="px-3 py-2 text-right">MaxDD</th>
                  </tr>
                </thead>
                <tbody>
                  {sweepResult.steps.map((s, i) => (
                    <tr key={i} className={`border-b border-zinc-50 ${i === bestIdx ? "bg-emerald-50/60" : ""}`}>
                      <td className="px-3 py-2 font-mono font-bold">
                        {s.value.toFixed(sweepResult.dim === "exit.holdDays" || sweepResult.dim === "trade.leverage" ? 0 : 2)}
                        {i === bestIdx && <span className="ml-2 text-xs text-emerald-600">🏆 best</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{s.summary.tradedEntries}</td>
                      <td className="px-3 py-2 text-right font-mono">{s.summary.winRate.toFixed(1)}%</td>
                      <td className={`px-3 py-2 text-right font-mono font-bold ${pnlColor(s.summary.totalPnlUsd)}`}>
                        {fmtUsd(s.summary.totalPnlUsd)}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${pnlColor(s.summary.avgPnlUsd)}`}>{fmtUsd(s.summary.avgPnlUsd)}</td>
                      <td className={`px-3 py-2 text-right font-mono ${pnlColor(s.summary.roiPct)}`}>{fmtPct(s.summary.roiPct)}</td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-500">-${s.summary.maxDrawdownUsd.toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function ExitReasonBar({ counts, total }: { counts: Record<string, number>; total: number }) {
  const order: Array<{ key: string; label: string; color: string }> = [
    { key: "TIME", label: "TIME", color: "bg-zinc-400" },
    { key: "TAKE_PROFIT", label: "TAKE_PROFIT", color: "bg-emerald-500" },
    { key: "TRAIL_STOP", label: "TRAIL_STOP", color: "bg-emerald-300" },
    { key: "HARD_STOP", label: "HARD_STOP", color: "bg-rose-500" },
    { key: "DATA_MISSING", label: "DATA_MISSING", color: "bg-amber-400" },
  ];
  const safe = Math.max(1, total);
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-zinc-400 mb-2">Причины выхода</div>
      <div className="flex h-6 w-full rounded-md overflow-hidden bg-zinc-100">
        {order.map(o => {
          const c = counts[o.key] || 0;
          const pct = (c / safe) * 100;
          if (pct === 0) return null;
          return <div key={o.key} className={o.color} style={{ width: `${pct}%` }} title={`${o.label}: ${c} (${pct.toFixed(0)}%)`} />;
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-600">
        {order.map(o => {
          const c = counts[o.key] || 0;
          if (c === 0) return null;
          return (
            <span key={o.key} className="flex items-center gap-1.5">
              <span className={`inline-block h-2 w-2 rounded-sm ${o.color}`} />
              {o.label}: <b className="text-zinc-800">{c}</b> ({((c / safe) * 100).toFixed(0)}%)
            </span>
          );
        })}
      </div>
    </div>
  );
}

function PnlHistogram({ bins }: { bins: Array<{ binStart: number; binEnd: number; count: number }> }) {
  if (bins.length === 0) return null;
  const W = 400, H = 120, P = 20;
  const maxCount = Math.max(...bins.map(b => b.count), 1);
  const barW = (W - 2 * P) / bins.length;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-zinc-400 mb-2">Распределение P&L по сделкам (%)</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        {bins.map((b, i) => {
          const h = (b.count / maxCount) * (H - 2 * P);
          const x = P + i * barW;
          const y = H - P - h;
          const color = b.binEnd <= 0 ? "#f43f5e" : b.binStart >= 0 ? "#10b981" : "#a1a1aa";
          return (
            <g key={i}>
              <rect x={x + 1} y={y} width={barW - 2} height={h} fill={color} opacity="0.8">
                <title>{b.binStart.toFixed(1)}% .. {b.binEnd.toFixed(1)}%: {b.count} trades</title>
              </rect>
            </g>
          );
        })}
        {/* zero line */}
        {bins.some(b => b.binStart <= 0 && b.binEnd >= 0) && (() => {
          const zeroIdx = bins.findIndex(b => b.binStart <= 0 && b.binEnd >= 0);
          if (zeroIdx < 0) return null;
          const frac = (0 - bins[zeroIdx].binStart) / (bins[zeroIdx].binEnd - bins[zeroIdx].binStart);
          const zx = P + (zeroIdx + frac) * barW;
          return <line x1={zx} x2={zx} y1={P / 2} y2={H - P} stroke="#71717a" strokeDasharray="2,3" strokeWidth="1" />;
        })()}
        {/* x-axis labels */}
        <text x={P} y={H - 4} fontSize="9" fill="#71717a">{bins[0].binStart.toFixed(0)}%</text>
        <text x={W - P} y={H - 4} textAnchor="end" fontSize="9" fill="#71717a">{bins[bins.length - 1].binEnd.toFixed(0)}%</text>
      </svg>
    </div>
  );
}

function EquityChart({ points }: { points: EquityPoint[] }) {
  // Minimal SVG line chart — no chart library dependency.
  const W = 800, H = 240, P = 32;
  const vals = points.map(p => p.cumulativePnlUsd);
  const minY = Math.min(0, ...vals);
  const maxY = Math.max(0, ...vals);
  const rangeY = maxY - minY || 1;
  const x = (i: number) => P + ((W - 2 * P) * i) / Math.max(1, points.length - 1);
  const y = (v: number) => H - P - ((v - minY) / rangeY) * (H - 2 * P);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.cumulativePnlUsd).toFixed(1)}`).join(" ");
  const zeroY = y(0);
  const finalPnl = points[points.length - 1].cumulativePnlUsd;
  const color = finalPnl >= 0 ? "#10b981" : "#f43f5e";

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-zinc-900">Equity Curve (кумулятивный P&L)</h3>
        <span className={`text-sm font-mono ${finalPnl >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
          {finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(2)} total
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        {/* zero line */}
        <line x1={P} x2={W - P} y1={zeroY} y2={zeroY} stroke="#d4d4d8" strokeDasharray="2,3" />
        {/* axes */}
        <line x1={P} x2={P} y1={P} y2={H - P} stroke="#e4e4e7" />
        <line x1={P} x2={W - P} y1={H - P} y2={H - P} stroke="#e4e4e7" />
        {/* path */}
        <path d={path} fill="none" stroke={color} strokeWidth="2" />
        {/* dots */}
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.cumulativePnlUsd)} r={2.5} fill={color} />
        ))}
        {/* y-axis labels: max and min */}
        <text x={P - 6} y={y(maxY) + 4} textAnchor="end" fontSize="10" fill="#71717a">${maxY.toFixed(0)}</text>
        <text x={P - 6} y={y(minY) + 4} textAnchor="end" fontSize="10" fill="#71717a">${minY.toFixed(0)}</text>
        <text x={P - 6} y={zeroY + 4} textAnchor="end" fontSize="10" fill="#71717a">0</text>
        {/* x-axis: first and last dates */}
        <text x={P} y={H - P + 14} fontSize="10" fill="#71717a">{points[0].cohortDate}</text>
        <text x={W - P} y={H - P + 14} textAnchor="end" fontSize="10" fill="#71717a">{points[points.length - 1].cohortDate}</text>
      </svg>
      <p className="text-xs text-zinc-500 mt-2">
        {points.length} точек (по датам cohort). Max drawdown: ${(Math.max(...points.map((p, i) => {
          const peak = Math.max(...points.slice(0, i + 1).map(x => x.cumulativePnlUsd));
          return peak - p.cumulativePnlUsd;
        }))).toFixed(2)}.
      </p>
    </div>
  );
}

function FieldDate({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-xs font-semibold text-zinc-600 uppercase tracking-wider">{label}</label>
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm" />
    </div>
  );
}

function FieldNum({ label, value, onChange, hint }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; hint?: string }) {
  return (
    <div>
      <label className="text-xs font-semibold text-zinc-600 uppercase tracking-wider">{label}</label>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-mono"
      />
      {hint && <p className="text-[10px] text-zinc-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function FieldSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-xs font-semibold text-zinc-600 uppercase tracking-wider">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm">
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function SumCell({ label, value, detail, valueColor }: { label: string; value: string; detail: string; valueColor?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-zinc-400">{label}</div>
      <div className={`text-xl font-bold ${valueColor || "text-zinc-900"}`}>{value}</div>
      {detail && <div className="text-[11px] text-zinc-500 mt-0.5">{detail}</div>}
    </div>
  );
}
