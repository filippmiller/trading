"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type RunRow = {
  id: string;
  created_at: string;
  status: string;
  preset_name: string | null;
  total_pnl_usd: number | null;
  total_return_pct: number | null;
  trades_count: number | null;
};

export default function RunsPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);

  useEffect(() => {
    const load = async () => {
      const response = await fetch("/api/runs");
      const payload = await response.json();
      setRuns(payload.items || []);
    };
    load();
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Runs</CardTitle>
        <CardDescription>Latest strategy runs and PnL.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-zinc-500">
                <th className="py-2">Date</th>
                <th>Preset</th>
                <th>Status</th>
                <th>PnL</th>
                <th>Return</th>
                <th>Trades</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b last:border-0">
                  <td className="py-2">{new Date(run.created_at).toISOString().slice(0, 10)}</td>
                  <td>{run.preset_name ?? "—"}</td>
                  <td>
                    <Badge>{run.status}</Badge>
                  </td>
                  <td>{run.total_pnl_usd !== null ? run.total_pnl_usd.toFixed(2) : "—"}</td>
                  <td>
                    {run.total_return_pct !== null
                      ? `${(run.total_return_pct * 100).toFixed(2)}%`
                      : "—"}
                  </td>
                  <td>{run.trades_count ?? "—"}</td>
                  <td>
                    <Link className="text-zinc-900 underline" href={`/runs/${run.id}`}>
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}