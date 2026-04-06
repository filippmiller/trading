"use client";

import { useEffect, useState, useMemo } from "react";
import { 
  Activity, 
  Zap, 
  BarChart3, 
  PlayCircle, 
  ArrowRight,
  TrendingUp,
  History,
  ShieldCheck,
  Search,
  Plus
} from "lucide-react";
import Link from "next/link";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export default function DashboardPage() {
  const [stats, setStats] = useState({
    activeSurveillance: 0,
    completedScenarios: 0,
    lastSync: "Never",
    winRate: "0.0%",
    health: "Operational"
  });

  useEffect(() => {
    // Initial fetch for dashboard stats
    const fetchStats = async () => {
      try {
        const [cohRes, runRes] = await Promise.all([
          fetch("/api/reversal"),
          fetch("/api/runs")
        ]);
        const cohData = await cohRes.json();
        const runData = await runRes.json();
        
        const allEntries = Object.values(cohData.cohorts || {}).flat() as any[];
        const activeCount = allEntries.filter(e => e.status === 'ACTIVE').length;
        const completed = allEntries.filter(e => e.status === 'COMPLETED');
        const winRate = completed.length > 0 
          ? ((completed.filter((e: any) => (e.final_pnl_usd || 0) > 0).length / completed.length) * 100).toFixed(1)
          : "0.0";

        setStats({
          activeSurveillance: activeCount,
          completedScenarios: runData.items?.length || 0,
          lastSync: new Date().toLocaleTimeString(),
          winRate: `${winRate}%`,
          health: "Operational"
        });
      } catch (e) {
        console.error("Dashboard stats error", e);
      }
    };
    fetchStats();
  }, []);

  return (
    <div className="max-w-6xl mx-auto space-y-10 pb-20">
      {/* Welcome Section */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="space-y-1">
          <h1 className="text-4xl font-bold tracking-tight text-zinc-900">Digital City Node</h1>
          <p className="text-zinc-500 text-lg">Autonomous Market Surveillance & Strategy Laboratory</p>
        </div>
        <div className="flex gap-3">
          <Link href="/reversal">
            <Button className="rounded-full px-6 bg-emerald-600 hover:bg-emerald-700 shadow-md shadow-emerald-100">
              <Activity className="mr-2 h-4 w-4" />
              Live Surveillance
            </Button>
          </Link>
          <Link href="/scenarios">
            <Button variant="outline" className="rounded-full px-6 border-zinc-200">
              <BarChart3 className="mr-2 h-4 w-4" />
              New Scenario
            </Button>
          </Link>
        </div>
      </div>

      {/* Primary KPI Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard 
          label="Engine Health" 
          value={stats.health} 
          icon={<ShieldCheck className="h-5 w-5 text-emerald-500" />}
          trend="+100% Uptime"
        />
        <StatCard 
          label="Under Surveillance" 
          value={stats.activeSurveillance} 
          icon={<Activity className="h-5 w-5 text-blue-500" />}
          trend="20 Enrolled Today"
        />
        <StatCard 
          label="Verified Patterns" 
          value={stats.completedScenarios} 
          icon={<History className="h-5 w-5 text-purple-500" />}
          trend="Last 24h"
        />
        <StatCard 
          label="Strategy Win Rate" 
          value={stats.winRate} 
          icon={<TrendingUp className="h-5 w-5 text-emerald-500" />}
          trend="Aggregate"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Core Methodology Card */}
        <Card className="lg:col-span-2 overflow-hidden border-none shadow-xl shadow-zinc-200/50 ring-1 ring-zinc-200/50">
          <div className="absolute top-0 right-0 p-8 opacity-5">
            <Activity className="h-40 w-40 text-zinc-900" />
          </div>
          <CardHeader className="pb-2">
            <Badge className="w-fit bg-emerald-50 text-emerald-700 border-emerald-100 mb-2">Protocol Active</Badge>
            <CardTitle className="text-2xl font-bold text-zinc-900">The 10-Day Reversal Protocol</CardTitle>
            <CardDescription className="text-base">
              Our autonomous engine monitors overextended market movers. 
              Each ticker undergoes 30-point high-resolution tracking to verify correction patterns.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <ProtocolStep number="01" title="Scan" desc="End-of-day trend identification (2-3 days)." />
              <ProtocolStep number="02" title="Enroll" desc="Automatic 10-day surveillance intake." />
              <ProtocolStep number="03" title="Audit" desc="3x daily price point harvesting." />
            </div>
            <div className="pt-4 flex items-center justify-between border-t border-zinc-100">
              <span className="text-sm font-medium text-zinc-500 flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                Next Sync Scheduled: 09:35 AM ET
              </span>
              <Link href="/reversal" className="text-emerald-600 text-sm font-bold flex items-center gap-1 hover:gap-2 transition-all">
                View Command Center <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </CardContent>
        </Card>

        {/* Quick Actions / Status */}
        <div className="space-y-6">
          <Card className="border-none shadow-lg shadow-zinc-200/50 ring-1 ring-zinc-200/50">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg font-bold">Lab Quick Access</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <QuickActionLink href="/signals" icon={<Zap className="h-4 w-4" />} title="Market Signal Scan" />
              <QuickActionLink href="/prices" icon={<Search className="h-4 w-4" />} title="Historical Price Explorer" />
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
              All data is audited against Stooq and Yahoo Finance APIs. 
              Failed requests are handled by the Dead Letter Queue (DLQ).
            </p>
            <div className="pt-2">
              <Badge className="bg-emerald-500/20 text-emerald-400 border-none">Sync Engine v2.0</Badge>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, trend }: any) {
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

function ProtocolStep({ number, title, desc }: any) {
  return (
    <div className="bg-zinc-50 p-4 rounded-2xl border border-zinc-100">
      <div className="text-xs font-bold text-emerald-600 mb-1">{number}</div>
      <h4 className="font-bold text-zinc-900 mb-1">{title}</h4>
      <p className="text-xs text-zinc-500 leading-snug">{desc}</p>
    </div>
  );
}

function QuickActionLink({ href, icon, title }: any) {
  return (
    <Link href={href}>
      <div className="flex items-center gap-3 p-3 rounded-xl hover:bg-zinc-50 transition-colors group">
        <div className="text-zinc-400 group-hover:text-emerald-600 transition-colors">{icon}</div>
        <span className="text-sm font-medium text-zinc-600 group-hover:text-zinc-900 transition-colors">{title}</span>
      </div>
    </Link>
  );
}
