"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  BarChart3,
  DollarSign,
  History,
  PlayCircle,
  Plus,
  Search,
  ShieldCheck,
  TrendingUp,
  Zap,
} from "lucide-react";
import Link from "next/link";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type ReversalLite = {
  status: string;
  final_pnl_usd?: number | null;
};

type DashboardStats = {
  activeSurveillance: number;
  completedScenarios: number;
  lastSync: string;
  winRate: string;
  health: string;
};

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats>({
    activeSurveillance: 0,
    completedScenarios: 0,
    lastSync: "Never",
    winRate: "0.0%",
    health: "Operational",
  });

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const [cohRes, runRes] = await Promise.all([
          fetch("/api/reversal"),
          fetch("/api/runs"),
        ]);
        const cohData = await cohRes.json();
        const runData = await runRes.json();

        const allEntries = Object.values(cohData.cohorts || {}).flat() as ReversalLite[];
        const activeCount = allEntries.filter((entry) => entry.status === "ACTIVE").length;
        const completed = allEntries.filter((entry) => entry.status === "COMPLETED");
        const winRate = completed.length > 0
          ? ((completed.filter((entry) => (entry.final_pnl_usd || 0) > 0).length / completed.length) * 100).toFixed(1)
          : "0.0";

        setStats({
          activeSurveillance: activeCount,
          completedScenarios: runData.items?.length || 0,
          lastSync: new Date().toLocaleTimeString(),
          winRate: `${winRate}%`,
          health: "Operational",
        });
      } catch (error) {
        console.error("Dashboard stats error", error);
      }
    };

    void fetchStats();
  }, []);

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-20">
      <div className="overflow-hidden rounded-[2rem] border border-zinc-200/70 bg-white/85 p-8 shadow-xl shadow-zinc-200/50">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-4">
            <Badge className="w-fit bg-emerald-50 text-emerald-700 border-emerald-100">Live Research Stack</Badge>
            <div className="space-y-2">
              <h1 className="text-4xl font-bold tracking-tight text-zinc-900 md:text-5xl">
                Mean reversion research, automation, and paper execution in one loop.
              </h1>
              <p className="text-zinc-600 text-lg">
                Scan daily movers, track the 10-day follow-through, compare strategies, and push approved ideas into automated paper positions.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href="/reversal">
                <Button className="rounded-full px-6 bg-emerald-600 hover:bg-emerald-700 shadow-md shadow-emerald-100">
                  <Activity className="mr-2 h-4 w-4" />
                  Open Surveillance
                </Button>
              </Link>
              <Link href="/strategies">
                <Button variant="outline" className="rounded-full px-6 border-zinc-200 bg-white">
                  <BarChart3 className="mr-2 h-4 w-4" />
                  Strategy Dashboard
                </Button>
              </Link>
              <Link href="/markets">
                <Button variant="outline" className="rounded-full px-6 border-zinc-200 bg-white">
                  <Search className="mr-2 h-4 w-4" />
                  Live Markets
                </Button>
              </Link>
            </div>
          </div>
          <div className="grid min-w-[280px] grid-cols-2 gap-3">
            <HighlightCard label="Surveillance" value={String(stats.activeSurveillance)} detail="Active cohorts" />
            <HighlightCard label="Scenarios" value={String(stats.completedScenarios)} detail="Recorded runs" />
            <HighlightCard label="Win Rate" value={stats.winRate} detail="Completed cohorts" />
            <HighlightCard label="Health" value={stats.health} detail={`Last refresh ${stats.lastSync}`} />
          </div>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-3">
          <ModuleCard href="/markets" icon={<Search className="h-5 w-5 text-blue-600" />} title="Markets" desc="Ad-free quote lookup, watchlist tracking, and live movers." />
          <ModuleCard href="/strategies" icon={<BarChart3 className="h-5 w-5 text-indigo-600" />} title="Strategies" desc="Compare 24 variants with live paper accounts and backtests." />
          <ModuleCard href="/paper" icon={<DollarSign className="h-5 w-5 text-amber-600" />} title="Paper Trading" desc="Inspect fills, cash, pending orders, and realized P&L." />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard label="Engine Health" value={stats.health} icon={<ShieldCheck className="h-5 w-5 text-emerald-500" />} trend={stats.lastSync} />
        <StatCard label="Under Surveillance" value={stats.activeSurveillance} icon={<Activity className="h-5 w-5 text-blue-500" />} trend="Reversal cohorts" />
        <StatCard label="Verified Patterns" value={stats.completedScenarios} icon={<History className="h-5 w-5 text-purple-500" />} trend="Backtests + runs" />
        <StatCard label="Strategy Win Rate" value={stats.winRate} icon={<TrendingUp className="h-5 w-5 text-emerald-500" />} trend="Completed cohorts" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <Card className="lg:col-span-2 overflow-hidden border-none shadow-xl shadow-zinc-200/50 ring-1 ring-zinc-200/50">
          <div className="absolute top-0 right-0 p-8 opacity-5">
            <Activity className="h-40 w-40 text-zinc-900" />
          </div>
          <CardHeader className="pb-2">
            <Badge className="w-fit bg-emerald-50 text-emerald-700 border-emerald-100 mb-2">Protocol Active</Badge>
            <CardTitle className="text-2xl font-bold text-zinc-900">The 10-Day Reversal Protocol</CardTitle>
            <CardDescription className="text-base">
              The stack monitors overextended daily movers, logs 30 measurement points per ticker, and converts the best setups into automated paper positions.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <ProtocolStep number="01" title="Scan" desc="End-of-day mover and streak identification." />
              <ProtocolStep number="02" title="Enroll" desc="Automatic 10-day surveillance intake." />
              <ProtocolStep number="03" title="Audit" desc="3x daily price harvesting with retry tracking." />
            </div>
            <div className="pt-4 flex items-center justify-between border-t border-zinc-100">
              <span className="text-sm font-medium text-zinc-500 flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                Next sync window starts at 09:45 AM ET
              </span>
              <Link href="/reversal" className="text-emerald-600 text-sm font-bold flex items-center gap-1 hover:gap-2 transition-all">
                View Command Center <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="border-none shadow-lg shadow-zinc-200/50 ring-1 ring-zinc-200/50">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg font-bold">Lab Quick Access</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <QuickActionLink href="/strategies" icon={<BarChart3 className="h-4 w-4" />} title="Review strategy leaderboard" />
              <QuickActionLink href="/markets" icon={<Search className="h-4 w-4" />} title="Check live market movers" />
              <QuickActionLink href="/paper" icon={<DollarSign className="h-4 w-4" />} title="Inspect paper positions" />
              <QuickActionLink href="/signals" icon={<Zap className="h-4 w-4" />} title="Market Signal Scan" />
              <QuickActionLink href="/voice" icon={<PlayCircle className="h-4 w-4" />} title="Run Voice Intelligence" />
              <QuickActionLink href="/settings" icon={<Plus className="h-4 w-4" />} title="Configure Cost Basis" />
            </CardContent>
          </Card>

          <div className="bg-zinc-900 rounded-3xl p-6 text-white space-y-4 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="bg-white/10 p-2 rounded-xl">
                <ShieldCheck className="h-5 w-5 text-emerald-400" />
              </div>
              <h3 className="font-bold">System Integrity</h3>
            </div>
            <p className="text-zinc-400 text-sm leading-relaxed">
              The current stack is built around Yahoo-backed surveillance, strategy scoring, and paper execution with failure tracking on missing measurements.
            </p>
            <div className="pt-2">
              <Badge className="bg-emerald-500/20 text-emerald-400 border-none">Surveillance + Paper Engine</Badge>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, trend }: { label: string; value: string | number; icon: React.ReactNode; trend: string }) {
  return (
    <Card className="border-none shadow-sm ring-1 ring-zinc-200/50">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="p-2 bg-zinc-50 rounded-xl">{icon}</div>
          <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">{trend}</span>
        </div>
        <div className="text-2xl font-bold text-zinc-900">{value}</div>
        <p className="text-xs font-medium text-zinc-500 mt-1">{label}</p>
      </CardContent>
    </Card>
  );
}

function HighlightCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl bg-zinc-950 px-4 py-4 text-white">
      <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">{label}</div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
      <div className="mt-1 text-xs text-zinc-400">{detail}</div>
    </div>
  );
}

function ModuleCard({ href, icon, title, desc }: { href: string; icon: React.ReactNode; title: string; desc: string }) {
  return (
    <Link href={href} className="group rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4 transition hover:border-zinc-300 hover:bg-white">
      <div className="flex items-center justify-between">
        <div className="rounded-xl bg-white p-2 shadow-sm shadow-zinc-200/50">{icon}</div>
        <ArrowRight className="h-4 w-4 text-zinc-300 transition group-hover:translate-x-1 group-hover:text-zinc-600" />
      </div>
      <h3 className="mt-4 font-bold text-zinc-900">{title}</h3>
      <p className="mt-1 text-sm text-zinc-500">{desc}</p>
    </Link>
  );
}

function ProtocolStep({ number, title, desc }: { number: string; title: string; desc: string }) {
  return (
    <div className="bg-zinc-50 p-4 rounded-2xl border border-zinc-100">
      <div className="text-xs font-bold text-emerald-600 mb-1">{number}</div>
      <h4 className="font-bold text-zinc-900 mb-1">{title}</h4>
      <p className="text-xs text-zinc-500 leading-snug">{desc}</p>
    </div>
  );
}

function QuickActionLink({ href, icon, title }: { href: string; icon: React.ReactNode; title: string }) {
  return (
    <Link href={href}>
      <div className="flex items-center gap-3 p-3 rounded-xl hover:bg-zinc-50 transition-colors group">
        <div className="text-zinc-400 group-hover:text-emerald-600 transition-colors">{icon}</div>
        <span className="text-sm font-medium text-zinc-600 group-hover:text-zinc-900 transition-colors">{title}</span>
      </div>
    </Link>
  );
}
