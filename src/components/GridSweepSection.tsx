"use client";

import { useState } from "react";

type BarTime = "morning" | "midday" | "close";
const BAR_TIMES: readonly BarTime[] = ["morning", "midday", "close"] as const;
const BAR_LABELS: Record<BarTime, string> = {
  morning: "AM",
  midday: "MD",
  close: "CL",
};

type GridRow = {
  holdDays: number;
  exitBar: BarTime;
  entryDelayDays: number;
  entryBar: BarTime;
  hardStopPct: number | null;
  takeProfitPct: number | null;
  trailingStopPct: number | null;
  breakevenAtPct: number | null;
  n: number;
  winRate: number;
  totalPnlUsd: number;
  avgPnlPct: number;
  bestPct: number;
  worstPct: number;
  profitFactor: number;
  sharpeRatio: number;
  avgHoldDays: number;
};

type GridResult = {
  totalCombinations: number;
  evaluated: number;
  rows: GridRow[];
  sampleSize: number;
};

type Filters = {
  cohortDateFrom?: string;
  cohortDateTo?: string;
  direction?: "UP" | "DOWN" | "BOTH";
  minDayChangePct?: number;
  maxDayChangePct?: number;
  minStreak?: number;
  maxStreak?: number;
  enrollmentSources?: Array<"MOVERS" | "TREND">;
  symbols?: string[];
};

type Preset = {
  name: string;
  description: string;
  holdDays: number[];
  exitBar: BarTime[];
  entryDelayDays: number[];
  entryBar: BarTime[];
  hardStopPct: (number | null)[];
  takeProfitPct: (number | null)[];
  trailingStopPct: (number | null)[];
  breakevenAtPct: (number | null)[];
};

const PRESETS: Preset[] = [
  {
    name: "Basic hold × exit",
    description: "4 holds × 3 exit bars · no stops · 12 configs",
    holdDays: [1, 2, 3, 5],
    exitBar: ["morning", "midday", "close"],
    entryDelayDays: [0],
    entryBar: ["close"],
    hardStopPct: [null],
    takeProfitPct: [null],
    trailingStopPct: [null],
    breakevenAtPct: [null],
  },
  {
    name: "Trailing-stop search",
    description: "3 holds × close · 5 trailing % · 15 configs",
    holdDays: [2, 3, 5],
    exitBar: ["close"],
    entryDelayDays: [0],
    entryBar: ["close"],
    hardStopPct: [null],
    takeProfitPct: [null],
    trailingStopPct: [null, 3, 5, 10, 15],
    breakevenAtPct: [null],
  },
  {
    name: "SL × TP grid (hold=1)",
    description: "4 SL × 4 TP · hold 1 close · 16 configs",
    holdDays: [1],
    exitBar: ["close"],
    entryDelayDays: [0],
    entryBar: ["close"],
    hardStopPct: [null, -3, -5, -10],
    takeProfitPct: [null, 5, 10, 20],
    trailingStopPct: [null],
    breakevenAtPct: [null],
  },
  {
    name: "Entry-delay probe",
    description: "3 delays × 2 holds × 3 trails · 18 configs",
    holdDays: [3, 5],
    exitBar: ["close"],
    entryDelayDays: [0, 1, 2],
    entryBar: ["morning", "midday", "close"],
    hardStopPct: [null],
    takeProfitPct: [null],
    trailingStopPct: [null, 5, 10],
    breakevenAtPct: [null],
  },
  {
    name: "Deep search (slow)",
    description: "Everything cross-producted · ~1000 configs · ~10-20s",
    holdDays: [1, 2, 3, 5, 10],
    exitBar: ["morning", "midday", "close"],
    entryDelayDays: [0, 1, 2],
    entryBar: ["morning", "midday", "close"],
    hardStopPct: [null, -5, -10],
    takeProfitPct: [null, 10, 20],
    trailingStopPct: [null, 5, 10, 15],
    breakevenAtPct: [null, 3, 5],
  },
];

type Props = {
  filters: Filters;
  investmentUsd: number;
  leverage: number;
  tradeDirection: "LONG" | "SHORT";
  costs: { commissionRoundTrip: number; marginApyPct: number };
};

export function GridSweepSection(props: Props) {
  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
  const [sortBy, setSortBy] = useState<"totalPnl" | "winRate" | "sharpe" | "profitFactor">("totalPnl");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GridResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const body = {
        filters: props.filters,
        trade: {
          investmentUsd: props.investmentUsd,
          leverage: props.leverage,
          tradeDirection: props.tradeDirection,
          holdDays: { values: preset.holdDays },
          exitBar: { values: preset.exitBar },
          entryDelayDays: { values: preset.entryDelayDays },
          entryBar: { values: preset.entryBar },
          hardStopPct: { values: preset.hardStopPct },
          takeProfitPct: { values: preset.takeProfitPct },
          trailingStopPct: { values: preset.trailingStopPct },
          breakevenAtPct: { values: preset.breakevenAtPct },
        },
        costs: props.costs,
        topN: 25,
        sortBy,
      };
      const res = await fetch("/api/research/grid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const combos = countCombos(preset);

  const fmtNum = (v: number | null) => (v == null ? "—" : `${v}%`);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm space-y-4">
      <div>
        <h2 className="text-lg font-bold text-zinc-900 flex items-center gap-2">
          🔬 Grid Sweep
          <span className="text-xs font-normal text-zinc-500">search the whole strategy space in one run</span>
        </h2>
      </div>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            onClick={() => setPreset(p)}
            className={`rounded-lg px-3 py-2 text-xs font-semibold border transition-all ${
              preset.name === p.name
                ? "bg-violet-600 text-white border-violet-600"
                : "bg-white text-zinc-700 border-zinc-200 hover:border-violet-300"
            }`}
            title={p.description}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div className="text-xs text-zinc-500 font-mono">{preset.description}</div>

      <details className="text-xs">
        <summary className="cursor-pointer text-zinc-600 hover:text-zinc-900 select-none">Edit axis values (advanced)</summary>
        <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-3 p-3 bg-zinc-50 rounded-lg">
          <AxisEditor key={axisKey("holdDays", preset.holdDays)} label="Hold days" value={preset.holdDays} onChange={(v) => setPreset({ ...preset, holdDays: v as number[] })} />
          <AxisEditor key={axisKey("exitBar", preset.exitBar)} label="Exit bar" value={preset.exitBar} onChange={(v) => setPreset({ ...preset, exitBar: v as BarTime[] })} allowedStrings={BAR_TIMES} />
          <AxisEditor key={axisKey("entryDelayDays", preset.entryDelayDays)} label="Entry delay (days)" value={preset.entryDelayDays} onChange={(v) => setPreset({ ...preset, entryDelayDays: v as number[] })} />
          <AxisEditor key={axisKey("entryBar", preset.entryBar)} label="Entry bar" value={preset.entryBar} onChange={(v) => setPreset({ ...preset, entryBar: v as BarTime[] })} allowedStrings={BAR_TIMES} />
          <AxisEditor key={axisKey("hardStopPct", preset.hardStopPct)} label="Hard stop % (use negatives)" value={preset.hardStopPct} onChange={(v) => setPreset({ ...preset, hardStopPct: v as (number | null)[] })} allowNull />
          <AxisEditor key={axisKey("takeProfitPct", preset.takeProfitPct)} label="Take profit %" value={preset.takeProfitPct} onChange={(v) => setPreset({ ...preset, takeProfitPct: v as (number | null)[] })} allowNull />
          <AxisEditor key={axisKey("trailingStopPct", preset.trailingStopPct)} label="Trailing %" value={preset.trailingStopPct} onChange={(v) => setPreset({ ...preset, trailingStopPct: v as (number | null)[] })} allowNull />
          <AxisEditor key={axisKey("breakevenAtPct", preset.breakevenAtPct)} label="Breakeven at %" value={preset.breakevenAtPct} onChange={(v) => setPreset({ ...preset, breakevenAtPct: v as (number | null)[] })} allowNull />
        </div>
      </details>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={run}
          disabled={loading || combos > 10000}
          className="rounded-lg bg-violet-600 text-white px-5 py-2 text-sm font-semibold hover:bg-violet-700 disabled:opacity-50"
        >
          {loading ? "Running…" : `Run sweep (${combos} configs)`}
        </button>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          className="rounded-lg border border-zinc-200 px-3 py-2 text-sm"
        >
          <option value="totalPnl">Sort by Total PnL</option>
          <option value="winRate">Sort by Win Rate</option>
          <option value="sharpe">Sort by Sharpe</option>
          <option value="profitFactor">Sort by Profit Factor</option>
        </select>
        {combos > 10000 && <span className="text-xs text-rose-600">Too many combinations — narrow ranges.</span>}
      </div>

      {error && (
        <div className="rounded-lg bg-rose-50 text-rose-700 text-sm p-3 border border-rose-200">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-500">
            Tested {result.evaluated} / {result.totalCombinations} configs on {result.sampleSize} entries matching filters.
            Showing top {result.rows.length}.
          </div>
          <div className="overflow-x-auto rounded-lg border border-zinc-200">
            <table className="w-full text-xs">
              <thead className="bg-zinc-800 text-zinc-200">
                <tr>
                  <th className="px-3 py-2 text-left">#</th>
                  <th className="px-2 py-2 text-right">Hold</th>
                  <th className="px-2 py-2 text-center">Exit bar</th>
                  <th className="px-2 py-2 text-right">Entry delay</th>
                  <th className="px-2 py-2 text-center">Entry bar</th>
                  <th className="px-2 py-2 text-right">SL</th>
                  <th className="px-2 py-2 text-right">TP</th>
                  <th className="px-2 py-2 text-right">Trail</th>
                  <th className="px-2 py-2 text-right">BE</th>
                  <th className="px-2 py-2 text-right border-l border-zinc-600">n</th>
                  <th className="px-2 py-2 text-right">WR%</th>
                  <th className="px-2 py-2 text-right">Total $</th>
                  <th className="px-2 py-2 text-right">Avg %</th>
                  <th className="px-2 py-2 text-right">Best %</th>
                  <th className="px-2 py-2 text-right">Worst %</th>
                  <th className="px-2 py-2 text-right">PF</th>
                  <th className="px-2 py-2 text-right">Sharpe</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <tr key={i} className={`border-b border-zinc-100 hover:bg-violet-50/30 ${i === 0 ? "bg-emerald-50/30" : ""}`}>
                    <td className="px-3 py-1.5 font-mono text-zinc-500">{i + 1}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{r.holdDays}d</td>
                    <td className="px-2 py-1.5 text-center text-zinc-600">{BAR_LABELS[r.exitBar]}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{r.entryDelayDays}d</td>
                    <td className="px-2 py-1.5 text-center text-zinc-600">{r.entryDelayDays > 0 ? BAR_LABELS[r.entryBar] : "—"}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-500">{fmtNum(r.hardStopPct)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-500">{fmtNum(r.takeProfitPct)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-500">{fmtNum(r.trailingStopPct)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-zinc-500">{fmtNum(r.breakevenAtPct)}</td>
                    <td className="px-2 py-1.5 text-right font-mono border-l border-zinc-100">{r.n}</td>
                    <td className="px-2 py-1.5 text-right font-mono font-semibold">{r.winRate.toFixed(0)}%</td>
                    <td className={`px-2 py-1.5 text-right font-mono font-bold ${r.totalPnlUsd >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                      {r.totalPnlUsd >= 0 ? "+" : ""}${r.totalPnlUsd.toFixed(0)}
                    </td>
                    <td className={`px-2 py-1.5 text-right font-mono ${r.avgPnlPct >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                      {r.avgPnlPct >= 0 ? "+" : ""}{r.avgPnlPct.toFixed(1)}%
                    </td>
                    <td className={`px-2 py-1.5 text-right font-mono ${r.bestPct >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                      {r.bestPct >= 0 ? "+" : ""}{r.bestPct.toFixed(0)}%
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-rose-600">{r.worstPct.toFixed(0)}%</td>
                    <td className="px-2 py-1.5 text-right font-mono">{isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞"}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{r.sharpeRatio.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function AxisEditor<T extends number | string | null>({
  label, value, onChange, allowNull = false, allowedStrings,
}: {
  label: string;
  value: T[];
  onChange: (v: T[]) => void;
  allowNull?: boolean;
  allowedStrings?: readonly string[];
}) {
  const [text, setText] = useState(value.map((v) => v == null ? "null" : String(v)).join(", "));

  const commit = (raw: string) => {
    const parsed = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0).map((s) => {
      if (s === "null") return allowNull ? null : undefined;
      if (allowedStrings) return allowedStrings.includes(s) ? (s as unknown) : undefined;
      const n = Number(s);
      return isNaN(n) ? undefined : n;
    }).filter((v) => v !== undefined) as T[];
    if (parsed.length) onChange(parsed);
  };
  return (
    <div>
      <label className="block text-[10px] uppercase font-bold text-zinc-500 mb-1">{label}</label>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(text)}
        className="w-full rounded border border-zinc-200 px-2 py-1 text-xs font-mono"
        placeholder="comma-separated"
      />
    </div>
  );
}

function countCombos(preset: Preset): number {
  let count = 0;
  for (const holdDays of preset.holdDays) {
    for (const _exitBar of preset.exitBar) {
      for (const entryDelayDays of preset.entryDelayDays) {
        if (entryDelayDays >= holdDays) continue;
        const entryBars = entryDelayDays > 0 ? preset.entryBar : ["close"];
        for (const _entryBar of entryBars) {
          for (const _hardStopPct of preset.hardStopPct) {
            for (const _takeProfitPct of preset.takeProfitPct) {
              for (const _trailingStopPct of preset.trailingStopPct) {
                for (const _breakevenAtPct of preset.breakevenAtPct) {
                  void _exitBar;
                  void _entryBar;
                  void _hardStopPct;
                  void _takeProfitPct;
                  void _trailingStopPct;
                  void _breakevenAtPct;
                  count++;
                }
              }
            }
          }
        }
      }
    }
  }
  return count;
}

function axisKey(label: string, value: Array<number | string | null>): string {
  return `${label}:${value.map((v) => v == null ? "null" : String(v)).join("|")}`;
}
