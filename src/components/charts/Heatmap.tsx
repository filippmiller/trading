"use client";

import { useMemo, useState } from "react";

type HeatmapCell = {
  x: number;
  y: number;
  xLabel: string;
  yLabel: string;
  value: number;
  metrics?: {
    total_pnl_usd: number;
    total_return_pct: number;
    win_rate: number;
    trades_count: number;
  };
};

type Props = {
  cells: HeatmapCell[];
  xAxisLabel: string;
  yAxisLabel: string;
  valueLabel?: string;
  width?: number;
  height?: number;
};

function interpolateColor(value: number, min: number, max: number): string {
  // Red (negative) -> Yellow (zero) -> Green (positive)
  const mid = (min + max) / 2;
  const normalized = max === min ? 0.5 : (value - min) / (max - min);

  if (value < mid) {
    // Red to Yellow
    const t = max === min ? 0.5 : (value - min) / (mid - min);
    const r = 239;
    const g = Math.round(68 + (234 - 68) * Math.max(0, Math.min(1, t)));
    const b = 68;
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    // Yellow to Green
    const t = max === min ? 0.5 : (value - mid) / (max - mid);
    const r = Math.round(234 - (234 - 34) * Math.max(0, Math.min(1, t)));
    const g = Math.round(234 - (234 - 197) * Math.max(0, Math.min(1, t)));
    const b = 68 + Math.round((94 - 68) * Math.max(0, Math.min(1, t)));
    return `rgb(${r}, ${g}, ${b})`;
  }
}

export function Heatmap({
  cells,
  xAxisLabel,
  yAxisLabel,
  valueLabel = "Return %",
  width = 500,
  height = 400,
}: Props) {
  const [hoveredCell, setHoveredCell] = useState<HeatmapCell | null>(null);

  const { xLabels, yLabels, grid, minVal, maxVal } = useMemo(() => {
    const xs = [...new Set(cells.map((c) => c.x))].sort((a, b) => a - b);
    const ys = [...new Set(cells.map((c) => c.y))].sort((a, b) => a - b);

    const xLbls = xs.map((x) => cells.find((c) => c.x === x)?.xLabel || String(x));
    const yLbls = ys.map((y) => cells.find((c) => c.y === y)?.yLabel || String(y));

    const gridMap = new Map<string, HeatmapCell>();
    for (const cell of cells) {
      gridMap.set(`${cell.x}-${cell.y}`, cell);
    }

    const values = cells.map((c) => c.value);
    const min = Math.min(...values, 0);
    const max = Math.max(...values, 0);

    return { xLabels: xLbls, yLabels: yLbls, grid: gridMap, minVal: min, maxVal: max };
  }, [cells]);

  const padding = { top: 40, right: 120, bottom: 60, left: 80 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const cellWidth = chartWidth / xLabels.length;
  const cellHeight = chartHeight / yLabels.length;

  const xsUnique = [...new Set(cells.map((c) => c.x))].sort((a, b) => a - b);
  const ysUnique = [...new Set(cells.map((c) => c.y))].sort((a, b) => a - b);

  if (!cells.length) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-zinc-400">
        No data to display
      </div>
    );
  }

  return (
    <div className="relative">
      <svg width={width} height={height} className="rounded-lg bg-zinc-50">
        {/* Title */}
        <text
          x={width / 2}
          y={20}
          textAnchor="middle"
          className="fill-zinc-700 text-sm font-medium"
        >
          {valueLabel} by {xAxisLabel} × {yAxisLabel}
        </text>

        {/* Cells */}
        {xsUnique.map((x, xi) =>
          ysUnique.map((y, yi) => {
            const cell = grid.get(`${x}-${y}`);
            if (!cell) return null;
            const color = interpolateColor(cell.value, minVal, maxVal);
            return (
              <g key={`${x}-${y}`}>
                <rect
                  x={padding.left + xi * cellWidth}
                  y={padding.top + yi * cellHeight}
                  width={cellWidth - 1}
                  height={cellHeight - 1}
                  fill={color}
                  rx={2}
                  className="cursor-pointer transition-opacity hover:opacity-80"
                  onMouseEnter={() => setHoveredCell(cell)}
                  onMouseLeave={() => setHoveredCell(null)}
                />
                <text
                  x={padding.left + xi * cellWidth + cellWidth / 2}
                  y={padding.top + yi * cellHeight + cellHeight / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="pointer-events-none fill-white text-[10px] font-medium"
                  style={{ textShadow: "0 1px 2px rgba(0,0,0,0.3)" }}
                >
                  {(cell.value * 100).toFixed(1)}%
                </text>
              </g>
            );
          })
        )}

        {/* X-axis labels */}
        {xLabels.map((label, i) => (
          <text
            key={`x-${i}`}
            x={padding.left + i * cellWidth + cellWidth / 2}
            y={height - padding.bottom + 20}
            textAnchor="middle"
            className="fill-zinc-600 text-[10px]"
          >
            {label}
          </text>
        ))}

        {/* X-axis title */}
        <text
          x={padding.left + chartWidth / 2}
          y={height - 10}
          textAnchor="middle"
          className="fill-zinc-700 text-xs font-medium"
        >
          {xAxisLabel}
        </text>

        {/* Y-axis labels */}
        {yLabels.map((label, i) => (
          <text
            key={`y-${i}`}
            x={padding.left - 10}
            y={padding.top + i * cellHeight + cellHeight / 2}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-zinc-600 text-[10px]"
          >
            {label}
          </text>
        ))}

        {/* Y-axis title */}
        <text
          x={15}
          y={padding.top + chartHeight / 2}
          textAnchor="middle"
          dominantBaseline="middle"
          transform={`rotate(-90, 15, ${padding.top + chartHeight / 2})`}
          className="fill-zinc-700 text-xs font-medium"
        >
          {yAxisLabel}
        </text>

        {/* Color legend */}
        <defs>
          <linearGradient id="heatmapGradient" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stopColor="rgb(239, 68, 68)" />
            <stop offset="50%" stopColor="rgb(234, 234, 68)" />
            <stop offset="100%" stopColor="rgb(34, 197, 94)" />
          </linearGradient>
        </defs>
        <rect
          x={width - padding.right + 20}
          y={padding.top}
          width={20}
          height={chartHeight}
          fill="url(#heatmapGradient)"
          rx={2}
        />
        <text
          x={width - padding.right + 50}
          y={padding.top}
          dominantBaseline="hanging"
          className="fill-zinc-600 text-[10px]"
        >
          {(maxVal * 100).toFixed(0)}%
        </text>
        <text
          x={width - padding.right + 50}
          y={padding.top + chartHeight / 2}
          dominantBaseline="middle"
          className="fill-zinc-600 text-[10px]"
        >
          0%
        </text>
        <text
          x={width - padding.right + 50}
          y={padding.top + chartHeight}
          dominantBaseline="auto"
          className="fill-zinc-600 text-[10px]"
        >
          {(minVal * 100).toFixed(0)}%
        </text>
      </svg>

      {/* Tooltip */}
      {hoveredCell && (
        <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-lg bg-zinc-900 px-3 py-2 text-xs text-white shadow-lg">
          <div className="font-medium">
            {xAxisLabel}: {hoveredCell.xLabel}, {yAxisLabel}: {hoveredCell.yLabel}
          </div>
          <div className="mt-1 space-y-0.5 text-zinc-300">
            <div>Return: {(hoveredCell.value * 100).toFixed(2)}%</div>
            {hoveredCell.metrics && (
              <>
                <div>PnL: ${hoveredCell.metrics.total_pnl_usd.toFixed(2)}</div>
                <div>Win Rate: {(hoveredCell.metrics.win_rate * 100).toFixed(1)}%</div>
                <div>Trades: {hoveredCell.metrics.trades_count}</div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
