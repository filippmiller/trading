"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { StrategyChat } from "@/components/StrategyChat";

const SYMBOL_STORAGE_KEY = "symbols:last";

export default function VoicePage() {
  const router = useRouter();
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [voiceText, setVoiceText] = useState("");
  const [specJson, setSpecJson] = useState<Record<string, unknown> | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [symbol, setSymbol] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const getErrorMessage = (err: unknown) =>
    err instanceof Error ? err.message : "Unexpected error.";

  useEffect(() => {
    const loadSymbols = async () => {
      try {
        const response = await fetch("/api/symbols");
        const payload = await response.json();
        const items = Array.isArray(payload.items) ? payload.items : [];
        setSymbols(items);
        if (typeof window === "undefined") return;
        const saved = window.localStorage.getItem(SYMBOL_STORAGE_KEY);
        if (saved && items.includes(saved)) {
          setSymbol(saved);
        } else if (items.length) {
          setSymbol(items[0]);
        }
      } catch {
        setSymbols([]);
      }
    };
    loadSymbols();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (symbol) {
      window.localStorage.setItem(SYMBOL_STORAGE_KEY, symbol);
    }
  }, [symbol]);

  const handleTranscribe = async () => {
    if (!audioFile) {
      setError("Upload an audio file first.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const formData = new FormData();
      formData.append("file", audioFile);
      const response = await fetch("/api/voice/transcribe", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) throw new Error("Transcription failed.");
      const payload = await response.json();
      setVoiceText(payload.text || "");
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleParse = async () => {
    if (!voiceText.trim()) {
      setError("Provide text to parse.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/voice/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: voiceText }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Parse failed.");
      }
      const payload = await response.json();
      setSpecJson(payload.spec);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRun = async () => {
    if (!specJson) {
      setError("Parse a StrategySpec first.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const spec = symbol ? { ...specJson, symbol } : specJson;
      const response = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spec,
          voice_text: voiceText,
          llm_provider: "openai",
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Backtest failed.");
      }
      const payload = await response.json();
      router.push(`/runs/${payload.id}`);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Voice to Strategy</CardTitle>
          <CardDescription>Upload audio or paste text to generate StrategySpec.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm text-zinc-600">Ticker</label>
            <select
              className="h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
              disabled={!symbols.length}
            >
              {!symbols.length && <option value="">No tickers</option>}
              {symbols.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <div className="text-xs text-zinc-500">
              Selected ticker overrides the parsed StrategySpec on run.
            </div>
            {!symbols.length && (
              <div className="text-xs text-zinc-500">
                No tickers downloaded yet. Add one on the Dashboard first.
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm text-zinc-600">Audio file (m4a/wav/mp3)</label>
            <Input
              type="file"
              accept="audio/*"
              onChange={(event) => setAudioFile(event.target.files?.[0] ?? null)}
            />
            <Button onClick={handleTranscribe} disabled={busy}>
              Transcribe
            </Button>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-zinc-600">Prompt text</label>
            <Textarea
              rows={5}
              value={voiceText}
              onChange={(event) => setVoiceText(event.target.value)}
              placeholder="Describe your strategy..."
            />
            <Button onClick={handleParse} disabled={busy} variant="secondary">
              Parse StrategySpec
            </Button>
          </div>

          {specJson && (
            <div className="space-y-4">
              <div className="rounded-lg bg-zinc-950/5 p-3 text-xs text-zinc-700">
                <div className="mb-2 text-xs font-semibold text-zinc-600">Parsed StrategySpec</div>
                <pre className="whitespace-pre-wrap">{JSON.stringify(specJson, null, 2)}</pre>
              </div>

              <div className="border-t border-zinc-200 pt-4">
                <StrategyChat
                  currentSpec={specJson}
                  onSpecUpdate={(newSpec) => setSpecJson(newSpec)}
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={handleRun} disabled={busy}>
              Run
            </Button>
          </div>

          {error && <div className="text-sm text-red-600">{error}</div>}
        </CardContent>
      </Card>
    </div>
  );
}
