"use client";

import React, { useEffect, useState, useMemo } from "react";
import { 
  Activity, 
  ArrowUpCircle, 
  ArrowDownCircle, 
  RefreshCw, 
  Settings2, 
  TrendingUp, 
  TrendingDown, 
  History,
  AlertCircle,
  CheckCircle2,
  Calendar
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ReversalEntry,
  ReversalSettings,
  calculateEntryPnL
} from "@/lib/reversal";
import {
  SCENARIOS,
  type ScenarioId,
  type ScenarioTickerInput,
  type ScenarioSnapshotInput,
  type PerTickerResult,
  type PerSnapshotResult,
  type ScenarioReport,
  evaluateScenario,
  summarizeScenario,
  compareAllScenarios,
} from "@/lib/matrix-scenarios";

const DEFAULT_SETTINGS: ReversalSettings = {
  position_size_usd: 100,
  commission_per_trade_usd: 1,
  short_borrow_rate_apr: 0.03,
  leverage_interest_apr: 0.08,
  leverage_multiplier: 1,
};

export default function ReversalDashboard() {
  const [cohorts, setCohorts] = useState<Record<string, ReversalEntry[]>>({});
  const [settings, setSettings] = useState<ReversalSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'active' | 'history' | 'matrix'>(() => {
    if (typeof window === 'undefined') return 'active';
    const q = new URLSearchParams(window.location.search).get('view');
    return q === 'matrix' || q === 'history' ? q : 'active';
  });

  // ... (rest of loadData and runSync)

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [setRes, cohRes] = await Promise.all([
        fetch("/api/reversal/settings"),
        fetch("/api/reversal")
      ]);
      const setData = await setRes.json();
      const cohData = await cohRes.json();
      if (setData.settings) setSettings(setData.settings);
      setCohorts(cohData.cohorts || {});
    } catch (err) {
      setError("Failed to sync with surveillance backend.");
    } finally {
      setLoading(false);
    }
  };

  const runSync = async () => {
    setLoading(true);
    try {
      await fetch("/api/surveillance/sync");
      await loadData();
    } catch (err) {
      setError("Surveillance sync failed.");
    } finally {
      setLoading(false);
    }
  };

  // Stats Logic
  const stats = useMemo(() => {
    const allEntries = Object.values(cohorts).flat();
    const active = allEntries.filter(e => e.status === 'ACTIVE');
    const completed = allEntries.filter(e => e.status === 'COMPLETED');
    const totalPnl = completed.reduce((sum, e) => sum + (e.final_pnl_usd || 0), 0);
    const winRate = completed.length > 0 
      ? (completed.filter(e => (e.final_pnl_usd || 0) > 0).length / completed.length) * 100 
      : 0;

    return { active, completed, totalPnl, winRate };
  }, [cohorts]);

  const activeGroups = useMemo(() => {
    const sorted = Object.entries(cohorts)
      .filter(([, entries]) => entries.some(e => e.status === 'ACTIVE'))
      .sort(([a], [b]) => b.localeCompare(a));
    return sorted;
  }, [cohorts]);

  const historyGroups = useMemo(() => {
    const sorted = Object.entries(cohorts)
      .filter(([, entries]) => entries.every(e => e.status === 'COMPLETED'))
      .sort(([a], [b]) => b.localeCompare(a));
    return sorted;
  }, [cohorts]);

  return (
    <div className={`mx-auto space-y-8 pb-20 ${view === 'matrix' ? 'max-w-full px-2' : 'max-w-6xl'}`}>
      {/* World-Class Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 flex items-center gap-3">
            <Activity className="text-emerald-500 h-8 w-8" />
            Surveillance Command
          </h1>
          <p className="text-zinc-500 mt-1">10-Day Mean Reversion Monitoring System</p>
        </div>
        <div className="flex items-center gap-3">
          <Button 
            variant="outline" 
            className="rounded-full px-6"
            onClick={runSync} 
            disabled={loading}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Scan & Sync
          </Button>
          <Button variant="ghost" size="icon" className="rounded-full">
            <Settings2 className="h-5 w-5 text-zinc-500" />
          </Button>
        </div>
      </div>

      {/* High-Level KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard 
          title="Active Tickers" 
          value={stats.active.length} 
          icon={<Activity className="h-4 w-4 text-emerald-500" />} 
          description="Under surveillance"
        />
        <KpiCard 
          title="Total P&L" 
          value={`$${stats.totalPnl.toFixed(2)}`} 
          icon={<TrendingUp className="h-4 w-4 text-emerald-500" />} 
          color={stats.totalPnl >= 0 ? "text-emerald-600" : "text-red-600"}
          description="Realized returns"
        />
        <KpiCard 
          title="Win Rate" 
          value={`${stats.winRate.toFixed(1)}%`} 
          icon={<CheckCircle2 className="h-4 w-4 text-blue-500" />} 
          description="Based on history"
        />
        <KpiCard 
          title="Observation Window" 
          value="10 Days" 
          icon={<Calendar className="h-4 w-4 text-zinc-500" />} 
          description="30 data points/stock"
        />
      </div>

      {/* Navigation Tabs */}
      <div className="flex gap-1 bg-zinc-100 p-1 rounded-xl w-fit">
        <button
          onClick={() => setView('active')}
          className={`px-6 py-2 rounded-lg text-sm font-medium transition-all ${view === 'active' ? 'bg-white shadow-sm text-zinc-900' : 'text-zinc-500 hover:text-zinc-700'}`}
        >
          Live Surveillance
        </button>
        <button
          onClick={() => setView('matrix')}
          className={`px-6 py-2 rounded-lg text-sm font-medium transition-all ${view === 'matrix' ? 'bg-white shadow-sm text-zinc-900' : 'text-zinc-500 hover:text-zinc-700'}`}
        >
          Matrix
        </button>
        <button
          onClick={() => setView('history')}
          className={`px-6 py-2 rounded-lg text-sm font-medium transition-all ${view === 'history' ? 'bg-white shadow-sm text-zinc-900' : 'text-zinc-500 hover:text-zinc-700'}`}
        >
          Historical Audit
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-100 text-red-600 px-4 py-3 rounded-xl flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
          <AlertCircle className="h-5 w-5" />
          <span className="text-sm font-medium">{error}</span>
        </div>
      )}

      {/* Main Content */}
      <div className="space-y-6">
        {view === 'matrix' ? (
          <SurveillanceMatrix
            entries={Object.values(cohorts).flat()}
            settings={settings}
          />
        ) : (
          <>
            {(view === 'active' ? activeGroups : historyGroups).map(([date, entries]) => (
              <div key={date} className="space-y-3">
                <div className="flex items-center gap-3 px-1">
                  <Badge className="bg-white text-zinc-500 font-mono border-zinc-200">
                    {date}
                  </Badge>
                  <div className="h-px flex-1 bg-zinc-100" />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {entries.map(entry => (
                    <SurveillanceCard key={entry.id} entry={entry} settings={settings} />
                  ))}
                </div>
              </div>
            ))}

            {(view === 'active' ? activeGroups : historyGroups).length === 0 && (
              <div className="py-20 text-center border-2 border-dashed rounded-3xl bg-zinc-50/50">
                <Activity className="h-12 w-12 text-zinc-300 mx-auto mb-4" />
                <h3 className="text-zinc-900 font-medium">No {view} data found</h3>
                <p className="text-zinc-500 text-sm mt-1">Run a Scan & Sync to identify new opportunities.</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function KpiCard({ title, value, icon, description, color = "text-zinc-900" }: any) {
  return (
    <Card className="border-none shadow-sm ring-1 ring-zinc-200/50">
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-xs font-medium text-zinc-500 uppercase tracking-wider">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold ${color}`}>{value}</div>
        <p className="text-[10px] text-zinc-400 mt-1 uppercase font-medium">{description}</p>
      </CardContent>
    </Card>
  );
}

function SurveillanceCard({ entry, settings }: { entry: ReversalEntry, settings: any }) {
  const pnl = calculateEntryPnL(entry, settings);
  
  const points = [];
  for(let d=1; d<=10; d++) {
    points.push(entry[`d${d}_morning` as keyof ReversalEntry] ? 1 : 0);
    points.push(entry[`d${d}_midday` as keyof ReversalEntry] ? 1 : 0);
    points.push(entry[`d${d}_close` as keyof ReversalEntry] ? 1 : 0);
  }
  const completedPoints = points.reduce((a, b) => a + b, 0);

  return (
    <Card className="overflow-hidden border-none shadow-sm ring-1 ring-zinc-200/50 hover:ring-zinc-300 transition-all">
      <div className="p-5 flex items-start justify-between">
        <div className="flex gap-4">
          <div className={`p-3 rounded-2xl ${entry.direction === 'LONG' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
            {entry.direction === 'LONG' ? <TrendingUp className="h-6 w-6" /> : <TrendingDown className="h-6 w-6" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-zinc-900">{entry.symbol}</h3>
              <Badge className="text-[10px] font-mono border-zinc-200 bg-white">
                {entry.consecutive_days}D Trend
              </Badge>
            </div>
            <p className="text-xs text-zinc-400 font-medium uppercase tracking-tighter">
              Trigger: {entry.day_change_pct.toFixed(2)}% move
            </p>
          </div>
        </div>
        
        <div className="text-right">
          <div className={`text-lg font-bold ${pnl && pnl.pnl_usd >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {pnl ? `${pnl.pnl_usd >= 0 ? '+' : ''}$${pnl.pnl_usd.toFixed(2)}` : '--'}
          </div>
          <div className="text-[10px] text-zinc-400 font-medium uppercase">
            Current P&L
          </div>
        </div>
      </div>

      <div className="px-5 pb-5 space-y-4">
        <div className="space-y-2">
          <div className="flex justify-between items-end">
            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Surveillance Progress</span>
            <span className="text-[10px] font-mono text-zinc-400">{completedPoints}/30 Points</span>
          </div>
          <div className="flex gap-0.5 h-1.5 w-full">
            {points.map((pt, i) => (
              <div 
                key={i} 
                className={`h-full flex-1 rounded-full transition-colors ${pt ? 'bg-emerald-400' : 'bg-zinc-100'}`}
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 bg-zinc-50 p-3 rounded-xl border border-zinc-100">
          <div>
            <p className="text-[9px] text-zinc-400 uppercase font-bold">Entry</p>
            <p className="text-xs font-mono font-medium">${entry.entry_price.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-[9px] text-zinc-400 uppercase font-bold">Current</p>
            <p className="text-xs font-mono font-medium">--</p>
          </div>
          <div>
            <p className="text-[9px] text-zinc-400 uppercase font-bold">Trend Size</p>
            <p className="text-xs font-mono font-medium">{entry.cumulative_change_pct?.toFixed(1)}%</p>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Compute trading days offset from a date (skips weekends) */
function addBusinessDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d.toISOString().slice(5, 10); // MM-DD format
}

/**
 * Build the per-ticker timeline (30 snapshots: 10 days × [morning, midday, close])
 * from a ReversalEntry. Used both for the scenario overlay (live) and to keep
 * cell keys aligned with the matrix columns.
 */
function buildTimeline(entry: ReversalEntry): ScenarioSnapshotInput[] {
  const out: ScenarioSnapshotInput[] = [];
  for (let d = 1; d <= 10; d++) {
    for (const t of ["morning", "midday", "close"] as const) {
      const key = `d${d}_${t}`;
      const price = entry[key as keyof ReversalEntry] as number | null;
      out.push({ key, price: price == null ? null : Number(price) });
    }
  }
  return out;
}

function entryToScenarioInput(entry: ReversalEntry): ScenarioTickerInput {
  return {
    symbol: entry.symbol,
    entryPrice: Number(entry.entry_price),
    dayChangePct: Number(entry.day_change_pct),
    consecutiveDays: entry.consecutive_days ?? null,
  };
}

function SurveillanceMatrix({ entries, settings }: { entries: ReversalEntry[], settings: any }) {
  const [sideFilter, setSideFilter] = useState<'all' | 'gainers' | 'losers'>(() => {
    if (typeof window === 'undefined') return 'all';
    const q = new URLSearchParams(window.location.search).get('filter');
    return q === 'gainers' || q === 'losers' ? q : 'all';
  });

  // --- Scenario overlay state ---------------------------------------------
  // Collapsed by default so existing UX is unchanged until the user opts in.
  const [scenarioPanelOpen, setScenarioPanelOpen] = useState(false);
  const [scenarioId, setScenarioId] = useState<ScenarioId>('momentum');
  const [investment, setInvestment] = useState<number>(100);
  const [leverage, setLeverage] = useState<number>(1);
  // "applied" is a snapshot of the scenario + params that actually colors the
  // grid. This prevents the grid from re-coloring live on every keystroke.
  const [applied, setApplied] = useState<{ id: ScenarioId; investment: number; leverage: number } | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  // Totals across all cohorts (for toggle labels — these don't shift when the filter changes)
  const totals = useMemo(() => {
    let gainers = 0;
    let losers = 0;
    for (const e of entries) {
      if (e.day_change_pct > 0) gainers++;
      else if (e.day_change_pct < 0) losers++;
    }
    return { all: entries.length, gainers, losers };
  }, [entries]);

  // Group by cohort_date, newest first — apply gainer/loser filter before grouping
  const grouped = useMemo(() => {
    const filtered = entries.filter(e => {
      if (sideFilter === 'gainers') return e.day_change_pct > 0;
      if (sideFilter === 'losers') return e.day_change_pct < 0;
      return true;
    });
    const map: Record<string, ReversalEntry[]> = {};
    for (const e of filtered) {
      const d = typeof e.cohort_date === 'string' ? e.cohort_date.slice(0, 10) : new Date(e.cohort_date).toISOString().slice(0, 10);
      (map[d] ??= []).push(e);
    }
    // Sort entries within each cohort by absolute trigger change (biggest movers first)
    for (const arr of Object.values(map)) {
      arr.sort((a, b) => Math.abs(b.day_change_pct) - Math.abs(a.day_change_pct));
    }
    return Object.entries(map).sort(([a], [b]) => b.localeCompare(a));
  }, [entries, sideFilter]);

  // Use the first cohort date for header dates (they shift per cohort, but header is generic)
  const refDate = grouped[0]?.[0] || new Date().toISOString().slice(0, 10);

  // Scenario evaluation over the currently-filtered cohort. Recomputes only
  // when a scenario is applied or inputs/entries change.
  const visibleEntries = useMemo(() => grouped.flatMap(([, arr]) => arr), [grouped]);

  const scenarioResults = useMemo(() => {
    if (!applied) return null;
    const byId = new Map<number, PerTickerResult>();
    const bySnapKey = new Map<number, Map<string, PerSnapshotResult>>();
    for (const e of visibleEntries) {
      const res = evaluateScenario(applied.id, entryToScenarioInput(e), buildTimeline(e), {
        investment: applied.investment,
        leverage: applied.leverage,
      });
      byId.set(e.id, res);
      const snapMap = new Map<string, PerSnapshotResult>();
      for (const s of res.snapshots) snapMap.set(s.key, s);
      bySnapKey.set(e.id, snapMap);
    }
    return { byId, bySnapKey };
  }, [applied, visibleEntries]);

  const report: ScenarioReport | null = useMemo(() => {
    if (!applied || !scenarioResults) return null;
    return summarizeScenario(applied.id, Array.from(scenarioResults.byId.values()), {
      investment: applied.investment,
      leverage: applied.leverage,
    });
  }, [applied, scenarioResults]);

  const comparison = useMemo(() => {
    if (!applied) return null;
    return compareAllScenarios(
      visibleEntries.map(entryToScenarioInput),
      (t) => {
        const entry = visibleEntries.find((e) => e.symbol === t.symbol);
        return entry ? buildTimeline(entry) : [];
      },
      { investment: applied.investment, leverage: applied.leverage },
    );
  }, [applied, visibleEntries]);

  const applyScenario = () => {
    if (!(investment > 0) || !(leverage >= 1)) return;
    setApplied({ id: scenarioId, investment, leverage });
  };

  const clearOverlay = () => setApplied(null);

  return (
    <Card className="border-none shadow-xl ring-1 ring-zinc-200/50 overflow-hidden">
      {/* Scenario What-If panel — collapsed by default so the default matrix UX is preserved. */}
      <ScenarioPanel
        open={scenarioPanelOpen}
        onToggle={() => setScenarioPanelOpen((v) => !v)}
        scenarioId={scenarioId}
        setScenarioId={setScenarioId}
        investment={investment}
        setInvestment={setInvestment}
        leverage={leverage}
        setLeverage={setLeverage}
        applied={applied}
        onApply={applyScenario}
        onClear={clearOverlay}
        onOpenReport={() => setReportOpen(true)}
        report={report}
      />
      <div className="px-3 py-2 bg-zinc-50 border-b border-zinc-100 flex items-center justify-between gap-4 flex-wrap">
        <div className="inline-flex items-center gap-1 rounded-lg bg-white ring-1 ring-zinc-200 p-0.5">
          {([
            { key: 'all', label: 'All', count: totals.all, dot: 'bg-zinc-400' },
            { key: 'gainers', label: 'Gainers', count: totals.gainers, dot: 'bg-emerald-500' },
            { key: 'losers', label: 'Losers', count: totals.losers, dot: 'bg-rose-500' },
          ] as const).map(opt => (
            <button
              key={opt.key}
              onClick={() => setSideFilter(opt.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-semibold tracking-wide transition-all ${
                sideFilter === opt.key
                  ? 'bg-zinc-900 text-white shadow-sm'
                  : 'text-zinc-500 hover:text-zinc-800'
              }`}
              title={opt.key === 'gainers'
                ? 'Tickers that moved UP on the trigger day (day_change_pct > 0)'
                : opt.key === 'losers'
                ? 'Tickers that moved DOWN on the trigger day (day_change_pct < 0)'
                : 'All enrolled tickers'}
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${opt.dot}`} />
              <span>{opt.label}</span>
              <span className={`text-[10px] font-mono ${sideFilter === opt.key ? 'text-zinc-400' : 'text-zinc-400'}`}>
                {opt.count}
              </span>
            </button>
          ))}
        </div>
        <div className="text-[9px] text-zinc-400 flex gap-4 flex-wrap">
          {applied ? (
            <>
              <span>Overlay: <b className="text-zinc-700">{SCENARIOS.find(s => s.id === applied.id)?.label}</b> · ${applied.investment}/ticker × {applied.leverage}x</span>
              <span>Values = <b className="text-zinc-600">P&L % vs entry (direction + leverage applied)</b></span>
              <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: 'rgba(16,185,129,0.3)' }} /> = profit
              <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: 'rgba(239,68,68,0.3)' }} /> = loss
              <span className="inline-block w-3 h-3 rounded bg-zinc-200" /> = filter excluded
              <span className="inline-block w-3 h-3 rounded bg-black text-white text-center text-[7px] leading-[12px]">L</span> = liquidated
            </>
          ) : (
            <>
              <span>Values = <b className="text-zinc-600">% change from entry price</b> (positive = profitable for the direction)</span>
              <span>M = <b className="text-zinc-600">Morning open +5min</b></span>
              <span>D = <b className="text-zinc-600">Midday</b></span>
              <span>E = <b className="text-zinc-600">Evening close</b></span>
              <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: 'rgba(16,185,129,0.25)' }} /> = profit
              <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: 'rgba(239,68,68,0.25)' }} /> = loss
            </>
          )}
        </div>
      </div>
      <div className="overflow-auto" style={{ maxHeight: 'calc(100vh - 160px)' }}>
        <table className="border-collapse text-xs" style={{ minWidth: '2400px' }}>
          <thead className="sticky top-0 z-20">
            <tr className="bg-zinc-800 text-zinc-300">
              <th className="sticky left-0 z-30 bg-zinc-800 px-3 py-2 text-left text-[10px] font-bold uppercase tracking-widest border-r border-zinc-700 min-w-[120px]">Ticker</th>
              <th className="px-2 py-2 text-right text-[10px] font-bold uppercase tracking-widest border-r border-zinc-700 min-w-[70px]">Entry $</th>
              <th className="px-2 py-2 text-right text-[10px] font-bold uppercase tracking-widest border-r border-zinc-700 min-w-[55px]">Trigger</th>
              {Array.from({ length: 10 }).map((_, d) => (
                <th key={d} colSpan={3} className={`px-1 py-1 text-center text-[10px] font-bold uppercase tracking-widest ${d < 9 ? 'border-r border-zinc-700' : ''}`}>
                  <div>Day {d + 1}</div>
                </th>
              ))}
            </tr>
            <tr className="bg-zinc-700 text-zinc-400">
              <th className="sticky left-0 z-30 bg-zinc-700 border-r border-zinc-600" />
              <th className="border-r border-zinc-600" />
              <th className="border-r border-zinc-600" />
              {Array.from({ length: 10 }).map((_, d) => (
                <React.Fragment key={d}>
                  <th className="px-1 py-1 text-[8px] font-bold min-w-[56px]">M</th>
                  <th className="px-1 py-1 text-[8px] font-bold min-w-[56px]">D</th>
                  <th className={`px-1 py-1 text-[8px] font-bold min-w-[56px] ${d < 9 ? 'border-r border-zinc-600' : ''}`}>E</th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {grouped.length === 0 && (
              <tr>
                <td colSpan={33} className="px-6 py-16 text-center text-zinc-400 text-xs">
                  No {sideFilter === 'gainers' ? 'gainers' : sideFilter === 'losers' ? 'losers' : 'entries'} in the current data.
                  {sideFilter !== 'all' && (
                    <button onClick={() => setSideFilter('all')} className="ml-2 underline text-zinc-600 hover:text-zinc-900">
                      Show all
                    </button>
                  )}
                </td>
              </tr>
            )}
            {grouped.map(([date, group]) => (
              <React.Fragment key={date}>
                <tr className="bg-zinc-100">
                  <td className="sticky left-0 z-10 bg-zinc-100 px-3 py-1.5 text-[10px] font-bold text-zinc-500 uppercase tracking-widest font-mono border-r border-zinc-200">
                    {date}
                    <span className="ml-2 text-zinc-400 font-normal">{group.length} tickers</span>
                  </td>
                  <td className="border-r border-zinc-200" />
                  <td className="border-r border-zinc-200" />
                  {Array.from({ length: 10 }).map((_, d) => (
                    <td key={d} colSpan={3} className={`text-center text-[9px] font-mono text-zinc-400 ${d < 9 ? 'border-r border-zinc-200' : ''}`}>
                      {addBusinessDays(date, d + 1)}
                    </td>
                  ))}
                </tr>
                {group.map((entry) => {
                  const perTicker = scenarioResults?.byId.get(entry.id) ?? null;
                  const snapMap = scenarioResults?.bySnapKey.get(entry.id) ?? null;
                  // When a scenario is applied but this ticker doesn't match the filter,
                  // dim the ticker name to convey "not traded in this scenario".
                  const dimmed = applied !== null && perTicker !== null && !perTicker.matches;
                  // Direction in scenario mode comes from the overlay, not entry.direction.
                  const scnDirection = perTicker?.direction ?? 0;
                  return (
                  <tr key={entry.id} className={`hover:bg-amber-50/30 transition-colors border-b border-zinc-100 ${dimmed ? 'opacity-40' : ''}`}>
                    <td className="sticky left-0 z-10 bg-white px-3 py-2 font-bold border-r border-zinc-100 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">
                      <div className="flex items-center gap-1.5">
                        {applied ? (
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${scnDirection === 1 ? 'bg-emerald-500' : scnDirection === -1 ? 'bg-rose-500' : 'bg-zinc-300'}`} />
                        ) : (
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${entry.direction === 'LONG' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                        )}
                        <span>{entry.symbol}</span>
                        <span className="text-[8px] text-zinc-400 font-normal">
                          {applied
                            ? (scnDirection === 1 ? 'buy' : scnDirection === -1 ? 'short' : 'n/a')
                            : (entry.direction === 'LONG' ? 'buy' : 'short')}
                        </span>
                      </div>
                    </td>
                    <td className="px-2 py-2 font-mono text-right border-r border-zinc-100">
                      ${entry.entry_price.toFixed(2)}
                    </td>
                    <td className={`px-2 py-2 font-mono text-right font-bold border-r border-zinc-100 ${entry.day_change_pct > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {entry.day_change_pct > 0 ? '+' : ''}{entry.day_change_pct.toFixed(1)}%
                    </td>
                    {Array.from({ length: 10 }).map((_, d) => (
                      <React.Fragment key={d}>
                        <MatrixCell entry={entry} field={`d${d+1}_morning`} dayLabel={`Day ${d+1} Morning`} scenarioSnap={snapMap?.get(`d${d+1}_morning`) ?? null} scenarioActive={applied !== null} />
                        <MatrixCell entry={entry} field={`d${d+1}_midday`} dayLabel={`Day ${d+1} Midday`} scenarioSnap={snapMap?.get(`d${d+1}_midday`) ?? null} scenarioActive={applied !== null} />
                        <MatrixCell entry={entry} field={`d${d+1}_close`} dayLabel={`Day ${d+1} Close`} isLast={d < 9} scenarioSnap={snapMap?.get(`d${d+1}_close`) ?? null} scenarioActive={applied !== null} />
                      </React.Fragment>
                    ))}
                  </tr>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {reportOpen && applied && report && comparison && (
        <ScenarioReportModal
          report={report}
          comparison={comparison}
          investment={applied.investment}
          leverage={applied.leverage}
          entries={visibleEntries}
          scenarioResults={scenarioResults?.byId ?? null}
          onClose={() => setReportOpen(false)}
        />
      )}
    </Card>
  );
}

/**
 * MatrixCell — renders a single price snapshot cell.
 *
 * Two rendering modes:
 *  - Default (no scenario applied): shows % change from entry price,
 *    direction-adjusted using the pre-baked reversal direction.
 *  - Scenario overlay: shows hypothetical P&L in $ and % using the overlay
 *    direction + leverage. Liquidated cells get a black "LIQ" badge.
 *    Non-matching tickers (grey filter-excluded state) render a neutral grey cell.
 */
function MatrixCell({
  entry,
  field,
  isLast,
  dayLabel,
  scenarioSnap,
  scenarioActive,
}: {
  entry: ReversalEntry;
  field: string;
  isLast?: boolean;
  dayLabel: string;
  scenarioSnap?: PerSnapshotResult | null;
  scenarioActive?: boolean;
}) {
  const price = entry[field as keyof ReversalEntry] as number | null;
  const border = isLast ? 'border-r border-zinc-200' : '';

  // --- Scenario-overlay mode -----------------------------------------------
  if (scenarioActive) {
    // No price snapshot yet
    if (price == null) {
      return <td className={`px-1 py-2 text-center text-zinc-200 font-mono text-[9px] ${border}`}>·</td>;
    }
    // Ticker doesn't match scenario filter — grey cell
    if (!scenarioSnap || scenarioSnap.pnlUsd == null) {
      return (
        <td className={`px-1 py-1 text-center font-mono cursor-default ${border} bg-zinc-100`} title={`${entry.symbol} — not traded in this scenario`}>
          <div className="text-[10px] font-semibold text-zinc-400">${price.toFixed(0)}</div>
          <div className="text-[8px] text-zinc-400">n/a</div>
        </td>
      );
    }

    const pnlPct = scenarioSnap.pnlPct ?? 0;
    const pnlUsd = scenarioSnap.pnlUsd ?? 0;
    const liq = scenarioSnap.liquidated;
    if (liq) {
      return (
        <td className={`px-1 py-1 text-center font-mono cursor-default ${border} bg-black text-white`}
            title={`${entry.symbol} — LIQUIDATED @ ${dayLabel}\nInvestment wiped (-100%).`}>
          <div className="text-[9px] font-bold">LIQ</div>
          <div className="text-[8px] text-red-300">-${Math.abs(pnlUsd).toFixed(0)}</div>
        </td>
      );
    }
    // Intensity scales with P&L magnitude. 20% = saturated.
    const intensity = Math.min(Math.abs(pnlPct) / 20, 1);
    const isProfit = pnlUsd > 0;
    const bg = isProfit
      ? `rgba(16, 185, 129, ${0.10 + intensity * 0.35})`
      : `rgba(239, 68, 68, ${0.10 + intensity * 0.35})`;
    const tooltip = [
      `${entry.symbol} — ${dayLabel}`,
      `Price: $${price.toFixed(2)}  Entry: $${entry.entry_price.toFixed(2)}`,
      `P&L: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
    ].join('\n');
    return (
      <td className={`px-1 py-1 text-center font-mono cursor-default ${border}`} style={{ backgroundColor: bg }} title={tooltip}>
        <div className={`text-[10px] font-semibold ${isProfit ? 'text-emerald-800' : 'text-rose-800'}`}>
          {pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(0)}
        </div>
        <div className={`text-[8px] ${isProfit ? 'text-emerald-700' : 'text-rose-700'}`}>
          {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%
        </div>
      </td>
    );
  }

  // --- Default mode (unchanged) --------------------------------------------
  if (!price) return <td className={`px-1 py-2 text-center text-zinc-200 font-mono text-[9px] ${border}`}>·</td>;

  // % change from entry price, adjusted for direction
  const rawChange = ((price - entry.entry_price) / entry.entry_price) * 100;
  const directedChange = entry.direction === 'SHORT' ? -rawChange : rawChange;

  // Color intensity scales with magnitude
  const intensity = Math.min(Math.abs(directedChange) / 5, 1);
  const isProfit = directedChange > 0;
  const bg = isProfit
    ? `rgba(16, 185, 129, ${0.08 + intensity * 0.25})`
    : `rgba(239, 68, 68, ${0.08 + intensity * 0.25})`;

  const tooltip = [
    `${entry.symbol} ${entry.direction} — ${dayLabel}`,
    `Price: $${price.toFixed(2)}`,
    `Entry: $${entry.entry_price.toFixed(2)}`,
    `Change: ${rawChange > 0 ? '+' : ''}${rawChange.toFixed(2)}%`,
    `P&L (direction-adjusted): ${directedChange > 0 ? '+' : ''}${directedChange.toFixed(2)}%`,
    directedChange > 0 ? 'Profitable' : 'Losing',
  ].join('\n');

  return (
    <td
      className={`px-1 py-1 text-center font-mono cursor-default ${border}`}
      style={{ backgroundColor: bg }}
      title={tooltip}
    >
      <div className="text-[10px] font-semibold text-zinc-700">${price.toFixed(0)}</div>
      <div className={`text-[8px] ${isProfit ? 'text-emerald-700' : 'text-rose-700'}`}>
        {directedChange > 0 ? '+' : ''}{directedChange.toFixed(1)}%
      </div>
    </td>
  );
}

// ---------------------------------------------------------------------------
// Scenario What-If — collapsible control panel
// ---------------------------------------------------------------------------

function ScenarioPanel({
  open,
  onToggle,
  scenarioId,
  setScenarioId,
  investment,
  setInvestment,
  leverage,
  setLeverage,
  applied,
  onApply,
  onClear,
  onOpenReport,
  report,
}: {
  open: boolean;
  onToggle: () => void;
  scenarioId: ScenarioId;
  setScenarioId: (id: ScenarioId) => void;
  investment: number;
  setInvestment: (n: number) => void;
  leverage: number;
  setLeverage: (n: number) => void;
  applied: { id: ScenarioId; investment: number; leverage: number } | null;
  onApply: () => void;
  onClear: () => void;
  onOpenReport: () => void;
  report: ScenarioReport | null;
}) {
  const current = SCENARIOS.find((s) => s.id === scenarioId);

  if (!open) {
    return (
      <div className="px-3 py-2 border-b border-zinc-100 bg-gradient-to-r from-zinc-50 to-white flex items-center justify-between gap-4">
        <button
          onClick={onToggle}
          className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-600 hover:text-zinc-900"
        >
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500" />
          Scenario What-If
          <span className="text-[9px] text-zinc-400 font-normal normal-case">
            click to explore hypothetical bets on this matrix
          </span>
          <span className="text-zinc-400">▸</span>
        </button>
        {applied && (
          <div className="flex items-center gap-2 text-[10px] text-zinc-500">
            <span className="text-indigo-600 font-semibold">Active:</span>
            <span>{SCENARIOS.find(s => s.id === applied.id)?.label}</span>
            <span>${applied.investment}/ticker × {applied.leverage}x</span>
            {report && (
              <span className={report.unrealizedPnlUsd >= 0 ? 'text-emerald-600 font-semibold' : 'text-rose-600 font-semibold'}>
                {report.unrealizedPnlUsd >= 0 ? '+' : ''}${report.unrealizedPnlUsd.toFixed(0)}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="px-3 py-3 border-b border-zinc-100 bg-gradient-to-r from-indigo-50/40 via-white to-white">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={onToggle}
          className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-indigo-700 hover:text-indigo-900"
        >
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500" />
          Scenario What-If
          <span className="text-zinc-400">▾</span>
        </button>
        <span className="text-[10px] text-zinc-400">
          Pure mark-to-market overlay. No positions are opened. Exits are not simulated.
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Scenario</span>
          <select
            value={scenarioId}
            onChange={(e) => setScenarioId(e.target.value as ScenarioId)}
            className="text-xs px-2 py-1.5 rounded-md border border-zinc-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 min-w-[220px]"
          >
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Investment ($/ticker)</span>
          <input
            type="number"
            min={1}
            step={10}
            value={investment}
            onChange={(e) => setInvestment(Number(e.target.value))}
            className="text-xs px-2 py-1.5 rounded-md border border-zinc-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 w-[120px]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Leverage</span>
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={leverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
            className="text-xs px-2 py-1.5 rounded-md border border-zinc-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 w-[80px]"
          />
        </label>
        <button
          onClick={onApply}
          className="text-xs px-4 py-1.5 rounded-md bg-indigo-600 text-white font-semibold hover:bg-indigo-700 shadow-sm"
        >
          Apply
        </button>
        <button
          onClick={onOpenReport}
          disabled={!applied}
          className={`text-xs px-4 py-1.5 rounded-md font-semibold shadow-sm ${applied ? 'bg-zinc-900 text-white hover:bg-zinc-800' : 'bg-zinc-100 text-zinc-300 cursor-not-allowed'}`}
        >
          View Report
        </button>
        {applied && (
          <button
            onClick={onClear}
            className="text-xs px-3 py-1.5 rounded-md border border-zinc-200 text-zinc-600 hover:text-zinc-900 hover:border-zinc-300"
          >
            Clear overlay
          </button>
        )}
      </div>
      {current && (
        <p className="mt-2 text-[10px] text-zinc-500 italic">{current.description}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Report modal
// ---------------------------------------------------------------------------

function ScenarioReportModal({
  report,
  comparison,
  investment,
  leverage,
  entries,
  scenarioResults,
  onClose,
}: {
  report: ScenarioReport;
  comparison: { scenarioId: ScenarioId; label: string; eligibleCount: number; totalCohort: number; totalPnlUsd: number }[];
  investment: number;
  leverage: number;
  entries: ReversalEntry[];
  scenarioResults: Map<number, PerTickerResult> | null;
  onClose: () => void;
}) {
  // Build CSV client-side
  const exportCsv = () => {
    const header = ['ticker', 'direction', 'entry_price', 'latest_price', 'current_pnl_usd', 'current_pnl_pct', 'liquidated', 'days_held', 'matches_filter', 'scenario'];
    const rows: string[][] = [header];
    for (const entry of entries) {
      const res = scenarioResults?.get(entry.id);
      if (!res) continue;
      const latestPrice = res.snapshots.slice().reverse().find((s) => s.price != null)?.price ?? null;
      rows.push([
        entry.symbol,
        res.direction === 1 ? 'LONG' : res.direction === -1 ? 'SHORT' : 'NONE',
        String(entry.entry_price),
        latestPrice != null ? String(latestPrice) : '',
        res.latestPnlUsd != null ? res.latestPnlUsd.toFixed(4) : '',
        res.latestPnlPct != null ? res.latestPnlPct.toFixed(4) : '',
        String(res.liquidated),
        String(res.daysHeld),
        String(res.matches),
        report.scenarioId,
      ]);
    }
    const csv = rows.map((r) => r.map((v) => /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scenario-${report.scenarioId}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const fmt$ = (n: number) => `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(0)}`;
  const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 animate-in fade-in" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl ring-1 ring-zinc-200 max-w-2xl w-full max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-zinc-100 flex items-center justify-between">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-600">Scenario Report</div>
            <h3 className="text-xl font-bold text-zinc-900">{report.scenarioLabel}</h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              ${investment}/ticker × {leverage}x · As-of: {report.asOfKey ?? 'no data'}
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 text-2xl leading-none">×</button>
        </div>

        <div className="px-6 py-4 space-y-4">
          <section>
            <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-400 mb-2">Portfolio</div>
            <div className="grid grid-cols-2 gap-y-1 text-sm">
              <span className="text-zinc-500">Tickers eligible</span>
              <span className="font-mono text-right">{report.eligibleCount} / {report.totalCohort}</span>
              <span className="text-zinc-500">Capital deployed</span>
              <span className="font-mono text-right">${report.capitalDeployed.toFixed(0)}</span>
              <span className="text-zinc-500">Current value</span>
              <span className="font-mono text-right">${report.currentValue.toFixed(0)}</span>
              <span className="text-zinc-500">Unrealized P&L</span>
              <span className={`font-mono text-right font-bold ${report.unrealizedPnlUsd >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                {fmt$(report.unrealizedPnlUsd)} ({fmtPct(report.unrealizedPnlPct)})
              </span>
            </div>
          </section>

          <section>
            <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-400 mb-2">Right-now state</div>
            <div className="grid grid-cols-2 gap-y-1 text-sm">
              <span className="text-zinc-500">In profit now</span>
              <span className="font-mono text-right">{report.inProfitCount} / {report.eligibleCount}</span>
              <span className="text-zinc-500">At loss now</span>
              <span className="font-mono text-right">{report.atLossCount} / {report.eligibleCount}</span>
              <span className="text-zinc-500">Liquidated</span>
              <span className="font-mono text-right">{report.liquidatedCount} / {report.eligibleCount}</span>
              <span className="text-zinc-500">Best</span>
              <span className="font-mono text-right">
                {report.best ? `${report.best.symbol} ${fmt$(report.best.pnlUsd)} (${fmtPct(report.best.pnlPct)}, ${report.best.daysHeld}d)` : '—'}
              </span>
              <span className="text-zinc-500">Worst</span>
              <span className="font-mono text-right">
                {report.worst ? `${report.worst.symbol} ${fmt$(report.worst.pnlUsd)} (${fmtPct(report.worst.pnlPct)}, ${report.worst.daysHeld}d)` : '—'}
              </span>
            </div>
          </section>

          <section>
            <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-400 mb-2">Side split</div>
            <div className="grid grid-cols-2 gap-y-1 text-sm">
              <span className="text-zinc-500">LONG bets ({report.longCount})</span>
              <span className={`font-mono text-right ${report.longSumPnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                {fmt$(report.longSumPnl)} (avg {fmtPct(report.longAvgPnlPct)})
              </span>
              <span className="text-zinc-500">SHORT bets ({report.shortCount})</span>
              <span className={`font-mono text-right ${report.shortSumPnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                {fmt$(report.shortSumPnl)} (avg {fmtPct(report.shortAvgPnlPct)})
              </span>
            </div>
          </section>

          <section>
            <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-400 mb-2">Comparison — same cohort, all 5 scenarios</div>
            <table className="w-full text-sm">
              <tbody>
                {comparison.map((c) => (
                  <tr key={c.scenarioId} className={c.scenarioId === report.scenarioId ? 'font-semibold' : ''}>
                    <td className="py-1 text-zinc-500">
                      {c.label}
                      <span className="ml-2 text-[10px] text-zinc-400 font-mono">(eligible: {c.eligibleCount}/{c.totalCohort})</span>
                    </td>
                    <td className={`py-1 font-mono text-right ${c.totalPnlUsd >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {fmt$(c.totalPnlUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>

        <div className="px-6 py-3 border-t border-zinc-100 flex items-center justify-end gap-2 bg-zinc-50">
          <button
            onClick={exportCsv}
            className="text-xs px-3 py-1.5 rounded-md border border-zinc-200 text-zinc-700 hover:bg-white"
          >
            Export CSV
          </button>
          <button
            onClick={onClose}
            className="text-xs px-4 py-1.5 rounded-md bg-zinc-900 text-white font-semibold hover:bg-zinc-800"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
