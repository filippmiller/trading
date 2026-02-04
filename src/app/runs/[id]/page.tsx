"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type RunDetails = {
  run: {
    id: string;
    created_at: string;
    status: string;
    preset_name: string | null;
    spec_json: string;
    lookback_days: number;
  };
  metrics: Record<string, number | string | null> | null;
  trades: Array<Record<string, number | string | null>>;
};

function toCsv(rows: Array<Record<string, unknown>>) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((key) => JSON.stringify(row[key] ?? "")).join(","));
  }
  return lines.join("\n");
}

export default function RunDetailPage() {
  const params = useParams();
  const runId = String(params.id);
  const [details, setDetails] = useState<RunDetails | null>(null);

  useEffect(() => {
    const load = async () => {
      const response = await fetch(`/api/runs/${runId}`);
      const payload = await response.json();
      setDetails(payload);
    };
    if (runId) load();
  }, [runId]);

  const metricsRows = useMemo(() => (details?.metrics ? [details.metrics] : []), [details]);

  const download = (filename: string, data: Array<Record<string, unknown>>) => {
    const csv = toCsv(data);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!details) {
    return <div>Loading...</div>;
  }

  const metrics = details.metrics || {};

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Run Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div>
            <div className="text-xs uppercase text-zinc-500">Preset</div>
            <div className="text-sm font-medium">{details.run.preset_name ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-zinc-500">Total PnL</div>
            <div className="text-sm font-medium">{metrics.total_pnl_usd?.toFixed?.(2) ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-zinc-500">Return</div>
            <div className="text-sm font-medium">
              {metrics.total_return_pct !== undefined
                ? `${(metrics.total_return_pct * 100).toFixed(2)}%`
                : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-zinc-500">Win rate</div>
            <div className="text-sm font-medium">
              {metrics.win_rate !== undefined ? `${(metrics.win_rate * 100).toFixed(1)}%` : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-zinc-500">Trades</div>
            <div className="text-sm font-medium">{metrics.trades_count ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-zinc-500">Max drawdown</div>
            <div className="text-sm font-medium">
              {metrics.max_drawdown_pct !== undefined
                ? `${(metrics.max_drawdown_pct * 100).toFixed(2)}%`
                : "—"}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => download(`trades-${runId}.csv`, details.trades)}>
          Download trades CSV
        </Button>
        <Button
          variant="secondary"
          onClick={() => download(`metrics-${runId}.csv`, metricsRows)}
        >
          Download metrics CSV
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Trades</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-zinc-500">
                  <th className="py-2">Entry</th>
                  <th>Side</th>
                  <th>Entry Px</th>
                  <th>Exit</th>
                  <th>Exit Px</th>
                  <th>Reason</th>
                  <th>PnL</th>
                </tr>
              </thead>
              <tbody>
                {details.trades.map((trade) => (
                  <tr key={`${trade.entry_date}-${trade.entry_price}`} className="border-b last:border-0">
                    <td className="py-2">{trade.entry_date}</td>
                    <td>{trade.side}</td>
                    <td>{Number(trade.entry_price).toFixed(4)}</td>
                    <td>{trade.exit_date}</td>
                    <td>{Number(trade.exit_price).toFixed(4)}</td>
                    <td>{trade.exit_reason}</td>
                    <td>{Number(trade.pnl_usd).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
