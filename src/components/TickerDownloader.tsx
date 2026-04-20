"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Three pages ("Add one on the Dashboard first") used to tell the user to go
// seed data somewhere else. There is no such Dashboard. This component lets the
// user download a symbol inline so the surrounding page becomes usable
// immediately after, without leaving the current context.
export function TickerDownloader({
  onDownloaded,
  hint,
}: {
  onDownloaded?: (symbol: string) => void;
  hint?: string;
}) {
  const [value, setValue] = useState("SPY");
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const download = async () => {
    const symbol = value.trim().toUpperCase();
    if (!symbol) return;
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch(`/api/data/refresh?symbol=${encodeURIComponent(symbol)}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const rows = body?.rowsUpserted ?? body?.count ?? body?.items?.length;
      setStatus("ok");
      setMessage(rows != null ? `Downloaded ${symbol} (${rows} rows).` : `Downloaded ${symbol}.`);
      onDownloaded?.(symbol);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") download(); }}
        placeholder="e.g. SPY"
        className="w-32"
        disabled={status === "loading"}
      />
      <Button onClick={download} disabled={status === "loading" || !value.trim()}>
        {status === "loading" ? "Downloading…" : "Download"}
      </Button>
      {hint && status === "idle" && <span className="text-xs text-zinc-500">{hint}</span>}
      {status === "ok" && <span className="text-xs text-emerald-600">{message}</span>}
      {status === "error" && <span className="text-xs text-rose-600">{message}</span>}
    </div>
  );
}
