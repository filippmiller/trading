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
  const [view, setView] = useState<'active' | 'history' | 'matrix'>('active');

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
    <div className="max-w-6xl mx-auto space-y-8 pb-20">
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

function SurveillanceMatrix({ entries, settings }: { entries: ReversalEntry[], settings: any }) {
  // Group by cohort_date, newest first
  const grouped = useMemo(() => {
    const map: Record<string, ReversalEntry[]> = {};
    for (const e of entries) {
      const d = typeof e.cohort_date === 'string' ? e.cohort_date.slice(0, 10) : new Date(e.cohort_date).toISOString().slice(0, 10);
      (map[d] ??= []).push(e);
    }
    return Object.entries(map).sort(([a], [b]) => b.localeCompare(a));
  }, [entries]);

  return (
    <Card className="border-none shadow-xl ring-1 ring-zinc-200/50 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="border-collapse text-xs" style={{ minWidth: '1800px' }}>
          <thead className="sticky top-0 z-20">
            <tr className="bg-zinc-800 text-zinc-300">
              <th className="sticky left-0 z-30 bg-zinc-800 px-3 py-2 text-left text-[10px] font-bold uppercase tracking-widest border-r border-zinc-700 min-w-[120px]">Ticker</th>
              <th className="px-2 py-2 text-right text-[10px] font-bold uppercase tracking-widest border-r border-zinc-700 min-w-[70px]">Entry</th>
              <th className="px-2 py-2 text-right text-[10px] font-bold uppercase tracking-widest border-r border-zinc-700 min-w-[50px]">Chg%</th>
              {Array.from({ length: 10 }).map((_, d) => (
                <th key={d} colSpan={3} className={`px-1 py-2 text-center text-[10px] font-bold uppercase tracking-widest ${d < 9 ? 'border-r border-zinc-700' : ''}`}>
                  D{d + 1}
                </th>
              ))}
            </tr>
            <tr className="bg-zinc-700 text-zinc-400">
              <th className="sticky left-0 z-30 bg-zinc-700 border-r border-zinc-600" />
              <th className="border-r border-zinc-600" />
              <th className="border-r border-zinc-600" />
              {Array.from({ length: 10 }).map((_, d) => (
                <React.Fragment key={d}>
                  <th className="px-1 py-1 text-[8px] font-bold min-w-[42px]">M</th>
                  <th className="px-1 py-1 text-[8px] font-bold min-w-[42px]">D</th>
                  <th className={`px-1 py-1 text-[8px] font-bold min-w-[42px] ${d < 9 ? 'border-r border-zinc-600' : ''}`}>E</th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {grouped.map(([date, group]) => (
              <React.Fragment key={date}>
                <tr className="bg-zinc-100">
                  <td colSpan={33} className="sticky left-0 px-3 py-1.5 text-[10px] font-bold text-zinc-500 uppercase tracking-widest font-mono">
                    Cohort {date}
                    <span className="ml-2 text-zinc-400 font-normal">{group.length} tickers</span>
                  </td>
                </tr>
                {group.map((entry) => (
                  <tr key={entry.id} className="hover:bg-amber-50/30 transition-colors border-b border-zinc-100">
                    <td className="sticky left-0 z-10 bg-white px-3 py-2 font-bold border-r border-zinc-100 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">
                      <div className="flex items-center gap-1.5">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${entry.direction === 'LONG' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                        <span>{entry.symbol}</span>
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
                        <MatrixCell entry={entry} field={`d${d+1}_morning`} />
                        <MatrixCell entry={entry} field={`d${d+1}_midday`} />
                        <MatrixCell entry={entry} field={`d${d+1}_close`} isLast={d < 9} />
                      </React.Fragment>
                    ))}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function MatrixCell({ entry, field, isLast }: { entry: ReversalEntry, field: string, isLast?: boolean }) {
  const price = entry[field as keyof ReversalEntry] as number | null;
  const border = isLast ? 'border-r border-zinc-100' : '';

  if (!price) return <td className={`px-1 py-1.5 text-center text-zinc-200 font-mono text-[9px] ${border}`}>·</td>;

  // % change from entry price, adjusted for direction
  const rawChange = ((price - entry.entry_price) / entry.entry_price) * 100;
  const directedChange = entry.direction === 'SHORT' ? -rawChange : rawChange;

  // Color intensity scales with magnitude
  const intensity = Math.min(Math.abs(directedChange) / 5, 1);
  const isProfit = directedChange > 0;
  const bg = isProfit
    ? `rgba(16, 185, 129, ${0.08 + intensity * 0.25})`
    : `rgba(239, 68, 68, ${0.08 + intensity * 0.25})`;

  return (
    <td
      className={`px-1 py-1.5 text-center font-mono text-[9px] font-medium ${border}`}
      style={{ backgroundColor: bg }}
      title={`$${price.toFixed(2)} (${rawChange > 0 ? '+' : ''}${rawChange.toFixed(2)}% raw)`}
    >
      {directedChange > 0 ? '+' : ''}{directedChange.toFixed(1)}
    </td>
  );
}
