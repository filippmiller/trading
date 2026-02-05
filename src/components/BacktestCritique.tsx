"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Props = {
  runId: string;
};

export function BacktestCritique({ runId }: Props) {
  const [critique, setCritique] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateCritique = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/runs/${runId}/critique`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Failed to generate critique");
      }
      const payload = await response.json();
      setCritique(payload.critique);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>AI Analysis</CardTitle>
        <Button
          variant={critique ? "secondary" : "default"}
          onClick={generateCritique}
          disabled={loading}
        >
          {loading ? "Analyzing..." : critique ? "Regenerate" : "Generate AI Critique"}
        </Button>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </div>
        )}
        {!critique && !loading && !error && (
          <div className="text-sm text-zinc-500">
            Click the button above to generate an AI analysis of this backtest's performance,
            including insights on win rate, drawdown patterns, and potential improvements.
          </div>
        )}
        {loading && (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600" />
            Analyzing trades and metrics...
          </div>
        )}
        {critique && (
          <div className="prose prose-sm max-w-none">
            <div className="whitespace-pre-wrap rounded-lg bg-zinc-50 p-4 text-sm text-zinc-700">
              {critique}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
