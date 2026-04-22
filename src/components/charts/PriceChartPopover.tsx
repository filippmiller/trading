"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ReversalEntry } from "@/lib/reversal";

/**
 * PriceChartPopover — on-click candlestick chart for a single ticker.
 * Fetches last 90 daily bars from /api/prices and renders OHLC bars with:
 *  - Vertical band highlighting the pre-enrollment streak days
 *  - Vertical marker line on the enrollment day
 *  - Green/red body per candle (close vs open)
 * Uses a portal so the popover escapes the table's stacking context and
 * positions via viewport coordinates.
 *
 * Answers the "how do I verify this ticker was really rising 5 days in a row
 * before we picked it up?" domain question from 2026-04-22.
 */

type Bar = { date: string; open: number; high: number; low: number; close: number };

// Module-level cache is correct here: same symbol clicked twice in one session
// skips the re-fetch. Tests call _resetPriceCacheForTests() between cases.
const priceCache = new Map<string, Bar[]>();

/** Test-only hook: clear module cache between tests. Not referenced by app code. */
export function _resetPriceCacheForTests(): void {
  priceCache.clear();
}

export type PriceChartPopoverProps = {
  entry: ReversalEntry;
  onClose: () => void;
  anchor: { top: number; left: number };
};

export function PriceChartPopover({ entry, onClose, anchor }: PriceChartPopoverProps) {
  const [bars, setBars] = useState<Bar[] | null>(priceCache.get(entry.symbol) ?? null);
  const [loading, setLoading] = useState(!priceCache.has(entry.symbol));
  const [error, setError] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    if (bars) return;
    setLoading(true);
    // 90 bars ≈ 4 months of trading days — covers most cohorts in the matrix.
    // If enrollment is older than that, we surface a clear "outside window"
    // warning in the footer so the user doesn't mistake a fragmented chart
    // for a verified streak.
    fetch(`/api/prices?symbol=${encodeURIComponent(entry.symbol)}&limit=90`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        const items: Bar[] = Array.isArray(j.items) ? j.items : [];
        priceCache.set(entry.symbol, items);
        setBars(items);
      })
      .catch((e) => setError(String((e as Error).message ?? e)))
      .finally(() => setLoading(false));
  }, [entry.symbol, bars]);

  const cohortDate =
    typeof entry.cohort_date === "string"
      ? entry.cohort_date.slice(0, 10)
      : new Date(entry.cohort_date).toISOString().slice(0, 10);
  const streakLen = Math.abs(entry.consecutive_days ?? 0);
  const up = entry.day_change_pct > 0;

  // Chart geometry
  const WIDTH = 420;
  const HEIGHT = 180;
  const PAD_L = 36, PAD_R = 8, PAD_T = 10, PAD_B = 20;
  const plotW = WIDTH - PAD_L - PAD_R;
  const plotH = HEIGHT - PAD_T - PAD_B;

  // Index enrollment day inside bars
  let enrollIdx = -1;
  if (bars) {
    for (let i = 0; i < bars.length; i++) if (bars[i].date === cohortDate) { enrollIdx = i; break; }
  }

  let chart: React.ReactNode = null;
  if (bars && bars.length > 0) {
    const lows = bars.map((b) => b.low);
    const highs = bars.map((b) => b.high);
    const yMin = Math.min(...lows);
    const yMax = Math.max(...highs);
    const yRange = (yMax - yMin) || 1;
    const barW = plotW / bars.length;
    const y = (v: number) => PAD_T + plotH - ((v - yMin) / yRange) * plotH;
    const x = (i: number) => PAD_L + i * barW + barW / 2;

    // streak band: from (enrollIdx - streakLen + 1) through enrollIdx, inclusive
    const streakStart = enrollIdx >= 0 ? Math.max(0, enrollIdx - streakLen + 1) : -1;
    const streakEnd = enrollIdx;

    chart = (
      <svg width={WIDTH} height={HEIGHT} className="bg-white" data-testid="price-chart-svg">
        {/* streak band */}
        {streakStart >= 0 && streakLen >= 2 && (
          <rect
            x={PAD_L + streakStart * barW}
            y={PAD_T}
            width={(streakEnd - streakStart + 1) * barW}
            height={plotH}
            fill={up ? "rgba(16,185,129,0.12)" : "rgba(244,63,94,0.12)"}
          />
        )}
        {/* enrollment marker line */}
        {enrollIdx >= 0 && (
          <line
            x1={x(enrollIdx)}
            x2={x(enrollIdx)}
            y1={PAD_T}
            y2={PAD_T + plotH}
            stroke="#6366f1"
            strokeWidth={1}
            strokeDasharray="2 2"
          />
        )}
        {/* y-axis price labels */}
        <text x={4} y={PAD_T + 4} fontSize={9} fill="#71717a" fontFamily="monospace">${yMax.toFixed(2)}</text>
        <text x={4} y={PAD_T + plotH} fontSize={9} fill="#71717a" fontFamily="monospace">${yMin.toFixed(2)}</text>
        {/* candlesticks — each bar has a full-height invisible hit-target so hover works even on flat days */}
        {bars.map((b, i) => {
          const isUp = b.close >= b.open;
          const color = isUp ? "#10b981" : "#ef4444";
          const bodyTop = y(Math.max(b.open, b.close));
          const bodyBot = y(Math.min(b.open, b.close));
          const bodyH = Math.max(1, bodyBot - bodyTop);
          const inStreak = streakStart >= 0 && i >= streakStart && i <= streakEnd;
          return (
            <g key={b.date} onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)} style={{ cursor: "pointer" }} data-testid={`candle-${b.date}`}>
              <rect x={PAD_L + i * barW} y={PAD_T} width={barW} height={plotH} fill="transparent" />
              <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} stroke={color} strokeWidth={1} />
              <rect
                x={x(i) - barW * 0.35}
                y={bodyTop}
                width={barW * 0.7}
                height={bodyH}
                fill={color}
                stroke={hoverIdx === i ? "#6366f1" : (inStreak && i === enrollIdx ? "#6366f1" : "none")}
                strokeWidth={hoverIdx === i ? 1.5 : 1}
              />
            </g>
          );
        })}
        {/* hover marker line */}
        {hoverIdx !== null && (
          <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={PAD_T} y2={PAD_T + plotH} stroke="#6366f1" strokeWidth={0.5} strokeOpacity={0.5} />
        )}
        {/* first/last/enrollment date labels */}
        <text x={PAD_L} y={HEIGHT - 6} fontSize={8} fill="#71717a" fontFamily="monospace">{bars[0].date.slice(5)}</text>
        <text x={WIDTH - PAD_R} y={HEIGHT - 6} fontSize={8} fill="#71717a" fontFamily="monospace" textAnchor="end">{bars[bars.length - 1].date.slice(5)}</text>
        {enrollIdx >= 0 && (
          <text x={x(enrollIdx)} y={HEIGHT - 6} fontSize={8} fill="#6366f1" fontFamily="monospace" fontWeight="bold" textAnchor="middle">
            {cohortDate.slice(5)}
          </text>
        )}
      </svg>
    );
  }

  return createPortal(
    <div
      style={{ position: "fixed", inset: 0, zIndex: 70 }}
      onClick={onClose}
      data-testid="price-chart-backdrop"
    >
      <div
        style={{ position: "fixed", top: anchor.top, left: anchor.left, zIndex: 71, maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100vh - 16px)" }}
        onClick={(e) => e.stopPropagation()}
        className="bg-white ring-1 ring-zinc-200 rounded-lg shadow-2xl p-3 overflow-auto"
        role="dialog"
        aria-label={`Price chart for ${entry.symbol}`}
      >
        <div className="flex items-center justify-between mb-1">
          <div>
            <span className="font-bold text-sm text-zinc-900">{entry.symbol}</span>
            <span className="ml-2 text-[10px] text-zinc-500 font-mono">
              enrolled {cohortDate} · entry ${entry.entry_price?.toFixed(2)} ·
              <span className={up ? "text-emerald-600 ml-1" : "text-rose-600 ml-1"}>
                {up ? "+" : ""}{entry.day_change_pct.toFixed(1)}%
              </span>
              {streakLen >= 2 && (
                <span className={up ? " ml-1 text-emerald-700" : " ml-1 text-rose-700"}>
                  · {streakLen}-day {up ? "UP" : "DOWN"} streak
                </span>
              )}
            </span>
          </div>
          <button onClick={onClose} aria-label="Close chart" className="text-zinc-400 hover:text-zinc-700 text-lg leading-none">×</button>
        </div>
        {loading && <div className="text-xs text-zinc-500 py-6 px-3">Loading last 90 days…</div>}
        {bars && bars.length > 0 && enrollIdx < 0 && (
          <div className="text-[10px] mb-2 px-2 py-1.5 rounded bg-amber-50 text-amber-800 ring-1 ring-amber-200 font-mono leading-relaxed">
            ⚠ Enrollment day <span className="font-bold">{cohortDate}</span> is OUTSIDE the loaded window
            (bars {bars[0].date} → {bars[bars.length - 1].date}). Streak band and enrollment marker
            cannot be drawn, so this chart does <span className="font-bold">not</span> visually verify
            the pre-enrollment streak. Trust <span className="font-mono text-amber-900">consecutive_days = {entry.consecutive_days ?? 0}</span> from the feed, not this render.
          </div>
        )}
        {error && <div className="text-xs text-rose-600 py-4 px-3">Failed to load prices: {error}</div>}
        {!loading && !error && !bars?.length && (
          <div className="text-xs text-zinc-600 py-4 px-3 max-w-[400px] leading-relaxed">
            <div className="font-semibold text-zinc-800 mb-1">No historical bars in <span className="font-mono">prices_daily</span> for {entry.symbol}.</div>
            <p className="text-zinc-500">
              The surveillance pipeline tagged this ticker with{" "}
              <span className="font-mono text-zinc-700">consecutive_days = {entry.consecutive_days ?? 0}</span>
              {streakLen >= 2 ? <> ({streakLen}-day {up ? "UP" : "DOWN"} streak through enrollment)</> : ""},
              but the daily-price table was only seeded for a handful of symbols (SPY, MU, …). The streak length is computed server-side from the feed, so you can trust the number — but to <em>visually</em> verify the pre-enrollment bars, a backfill of <span className="font-mono">prices_daily</span> for all enrolled tickers is needed. Open an issue / ask me to wire up a backfill script.
            </p>
          </div>
        )}
        {chart}
        {bars && bars.length > 0 && (() => {
          // Compute streak-aggregate stats for the hover hint row: range, total
          // move, mean daily change across the streak window. Cheap, runs once
          // per render, scoped to the visible bars only.
          const streakStart = enrollIdx >= 0 && streakLen >= 2 ? Math.max(0, enrollIdx - streakLen + 1) : -1;
          const streakEnd = enrollIdx;
          const streakBars = streakStart >= 0 ? bars.slice(streakStart, streakEnd + 1) : [];
          const streakOpen = streakBars[0]?.open ?? null;
          const streakClose = streakBars[streakBars.length - 1]?.close ?? null;
          const streakTotalPct = streakOpen != null && streakClose != null && streakOpen > 0
            ? ((streakClose - streakOpen) / streakOpen) * 100
            : null;
          const streakHigh = streakBars.length > 0 ? Math.max(...streakBars.map((b) => b.high)) : null;
          const streakLow = streakBars.length > 0 ? Math.min(...streakBars.map((b) => b.low)) : null;

          const hovered = hoverIdx != null ? bars[hoverIdx] : null;
          const hoveredPrev = hoverIdx != null && hoverIdx > 0 ? bars[hoverIdx - 1] : null;
          const hoveredChangePct = hovered && hoveredPrev && hoveredPrev.close > 0
            ? ((hovered.close - hoveredPrev.close) / hoveredPrev.close) * 100
            : null;
          const hoveredInStreak = hoverIdx != null && streakStart >= 0 && hoverIdx >= streakStart && hoverIdx <= streakEnd;

          return (
            <>
              {/* Hover info row — shows stats of the specific day under the cursor */}
              <div className="mt-1 font-mono text-[10px] bg-zinc-50 border border-zinc-100 rounded px-2 py-1 min-h-[22px] flex items-center gap-3 flex-wrap">
                {hovered ? (
                  <>
                    <span className="font-semibold text-zinc-800">{hovered.date}</span>
                    {hoveredInStreak && <span className={`px-1 rounded text-[9px] ${up ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>in streak</span>}
                    {hoverIdx === enrollIdx && <span className="px-1 rounded text-[9px] bg-indigo-100 text-indigo-700">ENROLLMENT</span>}
                    <span>O ${hovered.open.toFixed(2)}</span>
                    <span>H ${hovered.high.toFixed(2)}</span>
                    <span>L ${hovered.low.toFixed(2)}</span>
                    <span>C ${hovered.close.toFixed(2)}</span>
                    {hoveredChangePct != null && (
                      <span className={hoveredChangePct >= 0 ? "text-emerald-600 font-bold" : "text-rose-600 font-bold"}>
                        {hoveredChangePct >= 0 ? "+" : ""}{hoveredChangePct.toFixed(2)}%
                      </span>
                    )}
                  </>
                ) : streakBars.length >= 2 ? (
                  <>
                    <span className="text-zinc-400">Streak window ({streakBars.length}d):</span>
                    <span className="text-zinc-700">{streakBars[0].date} → {streakBars[streakBars.length - 1].date}</span>
                    {streakHigh != null && streakLow != null && (
                      <span className="text-zinc-500">range ${streakLow.toFixed(2)} – ${streakHigh.toFixed(2)}</span>
                    )}
                    {streakTotalPct != null && (
                      <span className={streakTotalPct >= 0 ? "text-emerald-600 font-bold" : "text-rose-600 font-bold"}>
                        total {streakTotalPct >= 0 ? "+" : ""}{streakTotalPct.toFixed(2)}%
                      </span>
                    )}
                    <span className="text-zinc-400 italic ml-auto">hover a bar for that day's OHLC</span>
                  </>
                ) : (
                  <span className="text-zinc-400 italic">Hover any bar to see that day's OHLC and day-over-day change.</span>
                )}
              </div>
              <div className="text-[9px] text-zinc-400 mt-1 flex gap-3 flex-wrap">
                <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3" style={{ backgroundColor: up ? "rgba(16,185,129,0.12)" : "rgba(244,63,94,0.12)" }} /> streak band</span>
                <span className="inline-flex items-center gap-1"><span className="inline-block w-0.5 h-3 bg-indigo-500" /> enrollment day</span>
                <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 bg-emerald-500" /> close ≥ open</span>
                <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 bg-rose-500" /> close &lt; open</span>
              </div>
            </>
          );
        })()}
      </div>
    </div>,
    document.body,
  );
}

export default PriceChartPopover;
