"use client";

import React, { useEffect, useState } from "react";

/**
 * Dual-clock market display — shows ET (exchange time) + user's local time
 * side-by-side, plus current session state.
 *
 * W5 requirement: the app deals in US-market trading but the browser shows
 * the user's local timezone. That makes "the market opens in 30 min" ambiguous
 * if the user is in London / Tokyo. Surfacing both clocks kills the ambiguity.
 *
 * Session state rules (ET):
 *   - Mon-Fri 04:00–09:30 → Pre-Market
 *   - Mon-Fri 09:30–16:00 → Market Open
 *   - Mon-Fri 16:00–20:00 → After-Hours
 *   - Everything else     → Closed
 * Holidays are NOT honored (same trade-off as `isRTH` in src/lib/paper.ts).
 */

export type MarketSession = "Pre-Market" | "Market Open" | "After-Hours" | "Closed";

type Clock = { hh: number; mm: number; ss: number; weekday: string; display: string };

function readClock(d: Date, timeZone: string): Clock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const ss = Number(parts.find((p) => p.type === "second")?.value ?? "0");
  const display = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(d);
  return { hh, mm, ss, weekday, display };
}

export function computeSession(etClock: Clock): MarketSession {
  if (etClock.weekday === "Sat" || etClock.weekday === "Sun") return "Closed";
  const minutes = etClock.hh * 60 + etClock.mm;
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "Pre-Market";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "Market Open";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "After-Hours";
  return "Closed";
}

function sessionStyle(s: MarketSession) {
  switch (s) {
    case "Market Open": return "bg-emerald-100 text-emerald-700 border-emerald-200";
    case "Pre-Market":  return "bg-amber-100 text-amber-700 border-amber-200";
    case "After-Hours": return "bg-indigo-100 text-indigo-700 border-indigo-200";
    case "Closed":
    default:            return "bg-zinc-100 text-zinc-600 border-zinc-200";
  }
}

export function MarketClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    // Only start the clock after mount — Next.js server-renders this
    // component with a static empty state so the server HTML and the first
    // client render match (no hydration mismatch from Date.now()).
    setNow(new Date());
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!now) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className="font-mono">ET: —</span>
        <span className="text-zinc-300">·</span>
        <span className="font-mono">Local: —</span>
      </div>
    );
  }

  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const etClock = readClock(now, "America/New_York");
  const localClock = readClock(now, localTz);
  const session = computeSession(etClock);

  return (
    <div className="flex items-center gap-2 text-xs text-zinc-600">
      <span className="font-mono">
        <span className="text-zinc-400">ET:</span> <span className="font-semibold text-zinc-800">{etClock.display}</span>
      </span>
      <span className="text-zinc-300">·</span>
      <span className="font-mono">
        <span className="text-zinc-400">Local:</span> <span className="font-semibold text-zinc-800">{localClock.display}</span>
      </span>
      <span
        className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${sessionStyle(session)}`}
        title={`US equity session based on ET clock (${etClock.weekday})`}
      >
        {session}
      </span>
    </div>
  );
}
