"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

export default function VoicePage() {
  const router = useRouter();
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [voiceText, setVoiceText] = useState("");
  const [specJson, setSpecJson] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const getErrorMessage = (err: unknown) =>
    err instanceof Error ? err.message : "Unexpected error.";

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
      const response = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spec: specJson,
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
            <div className="rounded-lg bg-zinc-950/5 p-3 text-xs text-zinc-700">
              <div className="mb-2 text-xs font-semibold text-zinc-600">Parsed StrategySpec</div>
              <pre className="whitespace-pre-wrap">{JSON.stringify(specJson, null, 2)}</pre>
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
