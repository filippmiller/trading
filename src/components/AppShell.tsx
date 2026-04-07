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
  DollarSign
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Executive Summary", href: "/", icon: LayoutDashboard },
  { name: "Mean Reversion", href: "/reversal", icon: Activity, badge: "Live" },
  { name: "Strategy Scenarios", href: "/scenarios", icon: BarChart3 },
  { name: "Market Signals", href: "/signals", icon: Zap },
  { name: "Price Surveillance", href: "/prices", icon: LineChart },
  { name: "Voice Intelligence", href: "/voice", icon: Mic2 },
  { name: "Simulation Runs", href: "/runs", icon: PlayCircle },
  { name: "Paper Trading", href: "/paper", icon: DollarSign, badge: "New" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-zinc-50">
      {/* Sidebar for Desktop */}
      <aside className="hidden md:flex w-72 flex-col fixed inset-y-0 z-50 bg-white border-r border-zinc-200">
        <div className="flex flex-col flex-grow pt-6 overflow-y-auto">
          <div className="px-6 pb-8 border-b border-zinc-50">
            <div className="flex items-center gap-2">
              <div className="bg-emerald-600 rounded-lg p-1.5 shadow-sm shadow-emerald-200">
                <Activity className="h-5 w-5 text-white" />
              </div>
              <span className="font-bold text-lg tracking-tight text-zinc-900">QuantSurveillance</span>
            </div>
            <p className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest mt-2 px-0.5">
              Digital City Market Node
            </p>
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
                placeholder="Search surveillance data..."
                className="w-full bg-zinc-100/50 border-none rounded-full pl-10 pr-4 py-2 text-sm focus:ring-2 focus:ring-emerald-500/20 focus:bg-white transition-all outline-none"
              />
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs font-medium text-zinc-500">
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              Market Live
            </div>
            <div className="h-4 w-px bg-zinc-200" />
            <span>UTC-5: {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })}</span>
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
