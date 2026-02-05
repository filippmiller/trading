"use client";

import { useMemo } from "react";

type Trade = {
  entry_date: string;
  exit_date: string;
  pnl_usd: number;
};

type EquityPoint = {
  date: string;
  equity: number;
  tradeIndex: number;
};

type Props = {
  trades: Trade[];
  baseCapital?: number;
  width?: number;
  height?: number;
};

export function EquityCurve({ trades, baseCapital = 500, width = 600, height = 280 }: Props) {
  const { points, minY, maxY, range } = useMemo(() => {
    if (!trades.length) {
      return { points: [] as EquityPoint[], minY: 0, maxY: baseCapital, range: baseCapital };
    }

    let cumulative = baseCapital;
    const pts: EquityPoint[] = [{ date: "Start", equity: baseCapital, tradeIndex: -1 }];

    for (let i = 0; i < trades.length; i++) {
      cumulative += trades[i].pnl_usd;
      pts.push({
        date: trades[i].exit_date,
        equity: cumulative,
        tradeIndex: i,
      });
    }

    const equities = pts.map((p) => p.equity);
    const min = Math.min(...equities);
    const max = Math.max(...equities);
    const r = max - min || 1;

    return { points: pts, minY: min, maxY: max, range: r };
  }, [trades, baseCapital]);

  const padding = { top: 20, right: 20, bottom: 40, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const scaleX = (index: number) =>
    padding.left + (index / Math.max(points.length - 1, 1)) * chartWidth;
  const scaleY = (value: number) =>
    padding.top + (1 - (value - minY) / range) * chartHeight;

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${scaleX(i).toFixed(1)} ${scaleY(p.equity).toFixed(1)}`)
    .join(" ");

  const zeroY = scaleY(baseCapital);

  // Compute drawdown shading
  const drawdownPath = useMemo(() => {
    if (points.length < 2) return "";
    let peak = points[0].equity;
    const segments: string[] = [];
    let inDrawdown = false;
    let ddStart = 0;

    for (let i = 0; i < points.length; i++) {
      const eq = points[i].equity;
      if (eq >= peak) {
        if (inDrawdown) {
          // Close drawdown region
          segments.push(`L ${scaleX(i).toFixed(1)} ${scaleY(peak).toFixed(1)}`);
          inDrawdown = false;
        }
        peak = eq;
      } else {
        if (!inDrawdown) {
          // Start drawdown region
          ddStart = i - 1;
          segments.push(`M ${scaleX(ddStart).toFixed(1)} ${scaleY(peak).toFixed(1)}`);
          segments.push(`L ${scaleX(i).toFixed(1)} ${scaleY(eq).toFixed(1)}`);
          inDrawdown = true;
        } else {
          segments.push(`L ${scaleX(i).toFixed(1)} ${scaleY(eq).toFixed(1)}`);
        }
      }
    }
    // Close final drawdown if still open
    if (inDrawdown) {
      segments.push(`L ${scaleX(points.length - 1).toFixed(1)} ${scaleY(peak).toFixed(1)}`);
    }

    return segments.join(" ");
  }, [points, scaleX, scaleY]);

  if (!trades.length) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-zinc-400">
        No trades to display
      </div>
    );
  }

  const yTicks = [minY, minY + range * 0.25, minY + range * 0.5, minY + range * 0.75, maxY];
  const xTicks = points.length > 5 ? [0, Math.floor(points.length / 2), points.length - 1] : points.map((_, i) => i);

  return (
    <svg width={width} height={height} className="rounded-lg bg-zinc-50">
      {/* Grid lines */}
      {yTicks.map((tick, i) => (
        <line
          key={`y-${i}`}
          x1={padding.left}
          x2={width - padding.right}
          y1={scaleY(tick)}
          y2={scaleY(tick)}
          stroke="#e4e4e7"
          strokeDasharray="4 2"
        />
      ))}

      {/* Zero/base line */}
      <line
        x1={padding.left}
        x2={width - padding.right}
        y1={zeroY}
        y2={zeroY}
        stroke="#a1a1aa"
        strokeDasharray="4 4"
        strokeWidth={1.5}
      />

      {/* Drawdown shading */}
      {drawdownPath && (
        <path d={drawdownPath} fill="rgba(239, 68, 68, 0.15)" stroke="none" />
      )}

      {/* Equity line */}
      <path d={pathD} fill="none" stroke="#3b82f6" strokeWidth={2} strokeLinecap="round" />

      {/* Data points */}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={scaleX(i)}
          cy={scaleY(p.equity)}
          r={3}
          fill={p.equity >= baseCapital ? "#22c55e" : "#ef4444"}
          className="transition-all hover:r-5"
        />
      ))}

      {/* Y-axis labels */}
      {yTicks.map((tick, i) => (
        <text
          key={`yl-${i}`}
          x={padding.left - 8}
          y={scaleY(tick)}
          textAnchor="end"
          dominantBaseline="middle"
          className="fill-zinc-500 text-[10px]"
        >
          ${tick.toFixed(0)}
        </text>
      ))}

      {/* X-axis labels */}
      {xTicks.map((i) => (
        <text
          key={`xl-${i}`}
          x={scaleX(i)}
          y={height - 10}
          textAnchor="middle"
          className="fill-zinc-500 text-[10px]"
        >
          {points[i]?.date?.slice(5) || ""}
        </text>
      ))}

      {/* Final equity label */}
      {points.length > 0 && (
        <text
          x={scaleX(points.length - 1) + 8}
          y={scaleY(points[points.length - 1].equity)}
          dominantBaseline="middle"
          className="fill-zinc-700 text-xs font-medium"
        >
          ${points[points.length - 1].equity.toFixed(0)}
        </text>
      )}
    </svg>
  );
}
