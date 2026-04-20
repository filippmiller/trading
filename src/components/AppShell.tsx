"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { 
  Activity,
  LayoutDashboard,
  Zap,
  BarChart3,
  Mic2,
  PlayCircle,
  Settings,
  LineChart,
  Search,
  Menu,
  X,
  DollarSign,
  ChevronRight
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Overview", href: "/", icon: LayoutDashboard },
  { name: "Markets", href: "/markets", icon: Search, badge: "Live" },
  { name: "Mean Reversion", href: "/reversal", icon: Activity, badge: "Live" },
  { name: "Strategy Dashboard", href: "/strategies", icon: BarChart3, badge: "Auto" },
  { name: "Strategy Scenarios", href: "/scenarios", icon: BarChart3 },
  { name: "Strategy Research", href: "/research", icon: Activity, badge: "New" },
  { name: "Market Signals", href: "/signals", icon: Zap },
  { name: "Price Surveillance", href: "/prices", icon: LineChart },
  { name: "Voice Intelligence", href: "/voice", icon: Mic2 },
  { name: "Simulation Runs", href: "/runs", icon: PlayCircle },
  { name: "Paper Trading", href: "/paper", icon: DollarSign, badge: "New" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [quickNav, setQuickNav] = useState("");
  const [quickNavOpen, setQuickNavOpen] = useState(false);

  const filteredNavigation = useMemo(() => {
    const query = quickNav.trim().toLowerCase();
    if (!query) return navigation;
    return navigation.filter((item) => item.name.toLowerCase().includes(query) || item.href.toLowerCase().includes(query));
  }, [quickNav]);

  // Clock + live market phase. Mount-only so SSR and first client paint agree;
  // without this, `new Date()` on the server vs client mismatches at hydration.
  // NYSE regular session = 09:30–16:00 ET Mon–Fri. Pre-market = 04:00–09:30, after-hours = 16:00–20:00.
  // Holiday calendar is deliberately NOT handled here — a wrongly-lit "Live" on a federal
  // holiday is better than pretending to know every NYSE closure; worst case ~9 days/year
  // of amber instead of zinc, never the other way around.
  const [marketNow, setMarketNow] = useState<{ clock: string; phase: 'OPEN' | 'PRE' | 'AFTER' | 'CLOSED' } | null>(null);
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const clock = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(now);
      const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
      const hh = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
      const mm = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
      const mins = hh * 60 + mm;
      const isWeekday = !['Sat', 'Sun'].includes(weekday);
      let phase: 'OPEN' | 'PRE' | 'AFTER' | 'CLOSED' = 'CLOSED';
      if (isWeekday) {
        if (mins >= 570 && mins < 960) phase = 'OPEN';        // 09:30–16:00
        else if (mins >= 240 && mins < 570) phase = 'PRE';    // 04:00–09:30
        else if (mins >= 960 && mins < 1200) phase = 'AFTER'; // 16:00–20:00
      }
      setMarketNow({ clock, phase });
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  const phaseStyle = {
    OPEN:   { dot: 'bg-emerald-500 animate-pulse', text: 'text-emerald-700', label: 'Market Open' },
    PRE:    { dot: 'bg-amber-500 animate-pulse',   text: 'text-amber-700',   label: 'Pre-Market' },
    AFTER:  { dot: 'bg-amber-500',                 text: 'text-amber-700',   label: 'After-Hours' },
    CLOSED: { dot: 'bg-zinc-400',                  text: 'text-zinc-500',    label: 'Market Closed' },
  } as const;

  return (
    <div className="flex min-h-screen bg-zinc-50">
      {/* Sidebar for Desktop */}
      <aside className="hidden md:flex w-72 flex-col fixed inset-y-0 z-50 bg-white border-r border-zinc-200">
        <div className="flex flex-col flex-grow pt-6 overflow-y-auto">
          <div className="px-6 pb-8 border-b border-zinc-100">
            <div className="flex items-center gap-2">
              <div className="bg-emerald-600 rounded-lg p-1.5 shadow-sm shadow-emerald-200">
                <Activity className="h-5 w-5 text-white" />
              </div>
              <span className="font-bold text-lg tracking-tight text-zinc-900">QuantSurveillance</span>
            </div>
            <p className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest mt-2 px-0.5">
              Digital City Market Node
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-xl bg-emerald-50 px-3 py-2 text-emerald-700">
                <div className="font-semibold">Data Loop</div>
                <div className="text-emerald-600/80">Surveillance + sync</div>
              </div>
              <div className="rounded-xl bg-blue-50 px-3 py-2 text-blue-700">
                <div className="font-semibold">Execution</div>
                <div className="text-blue-600/80">Paper orders + exits</div>
              </div>
            </div>
          </div>

          <nav className="flex-1 px-4 mt-6 space-y-1">
            {navigation.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    "group flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-xl transition-all duration-200",
                    isActive 
                      ? "bg-emerald-50 text-emerald-700 shadow-sm shadow-emerald-100/50" 
                      : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <item.icon className={cn(
                      "h-5 w-5 shrink-0 transition-colors",
                      isActive ? "text-emerald-600" : "text-zinc-400 group-hover:text-zinc-600"
                    )} />
                    {item.name}
                  </div>
                  {item.badge && (
                    <span className="bg-emerald-500/10 text-emerald-600 text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-tighter">
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          <div className="px-4 py-6 mt-auto border-t border-zinc-100">
            <Link
              href="/settings"
              className={cn(
                "group flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-xl transition-all",
                pathname === "/settings" ? "bg-zinc-100 text-zinc-900" : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900"
              )}
            >
              <Settings className="h-5 w-5 text-zinc-400 group-hover:text-zinc-600" />
              System Settings
            </Link>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 md:pl-72 flex flex-col">
        {/* Mobile Header */}
        <header className="md:hidden flex items-center justify-between h-16 px-6 bg-white border-b border-zinc-200 sticky top-0 z-40">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-emerald-600" />
            <span className="font-bold text-zinc-900">QuantSurveillance</span>
          </div>
          <button onClick={() => setSidebarOpen(true)} className="text-zinc-500">
            <Menu className="h-6 w-6" />
          </button>
        </header>

        {/* Global Search/Header */}
        <header className="hidden md:flex h-16 items-center justify-between px-8 bg-white/80 backdrop-blur-sm border-b border-zinc-200 sticky top-0 z-40">
          <div className="flex-1 max-w-md">
            <div className="relative group">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400 group-focus-within:text-emerald-500 transition-colors" />
              <input 
                type="text" 
                value={quickNav}
                onChange={(e) => setQuickNav(e.target.value)}
                onFocus={() => setQuickNavOpen(true)}
                onBlur={() => setTimeout(() => setQuickNavOpen(false), 120)}
                placeholder="Jump to a page: markets, strategies, paper..."
                className="w-full bg-zinc-100/50 border-none rounded-full pl-10 pr-4 py-2 text-sm focus:ring-2 focus:ring-emerald-500/20 focus:bg-white transition-all outline-none"
              />
              {quickNavOpen && filteredNavigation.length > 0 && (
                <div className="absolute left-0 right-0 top-12 rounded-2xl border border-zinc-200 bg-white p-2 shadow-xl shadow-zinc-200/50">
                  {filteredNavigation.map((item) => {
                    const isActive = pathname === item.href;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => {
                          setQuickNav("");
                          setQuickNavOpen(false);
                        }}
                        className={cn(
                          "flex items-center justify-between rounded-xl px-3 py-2 text-sm transition-colors",
                          isActive ? "bg-emerald-50 text-emerald-700" : "hover:bg-zinc-50 text-zinc-700"
                        )}
                      >
                        <span className="flex items-center gap-3">
                          <item.icon className="h-4 w-4" />
                          {item.name}
                        </span>
                        <span className="flex items-center gap-2 text-xs text-zinc-400">
                          {item.badge && <span>{item.badge}</span>}
                          <ChevronRight className="h-3.5 w-3.5" />
                        </span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs font-medium text-zinc-500">
            <div className={`flex items-center gap-1.5 ${marketNow ? phaseStyle[marketNow.phase].text : ''}`} suppressHydrationWarning>
              <div className={`h-2 w-2 rounded-full ${marketNow ? phaseStyle[marketNow.phase].dot : 'bg-zinc-300'}`} />
              {marketNow ? phaseStyle[marketNow.phase].label : '—'}
            </div>
            <div className="h-4 w-px bg-zinc-200" />
            <span>Enroll: 16:05 ET</span>
            <div className="h-4 w-px bg-zinc-200" />
            <span suppressHydrationWarning>ET: {marketNow?.clock ?? '—:—'}</span>
          </div>
        </header>

        <main className="flex-1 px-6 py-8 md:px-10">
          {children}
        </main>
      </div>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div className="fixed inset-0 bg-zinc-900/50 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
          <div className="relative flex-1 flex flex-col w-full max-w-[280px] bg-white shadow-xl animate-in slide-in-from-left duration-300">
            <div className="flex items-center justify-between h-16 px-6 border-b border-zinc-100">
              <div className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-emerald-600" />
                <span className="font-bold text-zinc-900">QuantSurveillance</span>
              </div>
              <button onClick={() => setSidebarOpen(false)}>
                <X className="h-6 w-6 text-zinc-400" />
              </button>
            </div>
            <nav className="flex-1 px-4 py-6 space-y-1">
              {navigation.map((item) => (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={() => setSidebarOpen(false)}
                  className={cn(
                    "flex items-center gap-3 px-3 py-3 text-sm font-medium rounded-xl transition-all",
                    pathname === item.href ? "bg-emerald-50 text-emerald-700" : "text-zinc-500 hover:bg-zinc-50"
                  )}
                >
                  <item.icon className={cn("h-5 w-5", pathname === item.href ? "text-emerald-600" : "text-zinc-400")} />
                  {item.name}
                </Link>
              ))}
            </nav>
          </div>
        </div>
      )}
    </div>
  );
}
