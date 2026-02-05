"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type Props = {
  currentSpec: Record<string, unknown>;
  onSpecUpdate: (spec: Record<string, unknown>) => void;
};

export function StrategyChat({ currentSpec, onSpecUpdate }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    setInput("");
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setLoading(true);

    try {
      const response = await fetch("/api/voice/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spec: currentSpec,
          message: userMessage,
          history: messages,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Failed to refine strategy");
      }

      const payload = await response.json();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: payload.explanation },
      ]);
      onSpecUpdate(payload.spec);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-zinc-700">Refine with AI</div>
      <div className="text-xs text-zinc-500">
        Ask to modify the strategy: "increase stop loss to 1%", "add trailing stop",
        "use 3-day streak instead of 2"
      </div>

      {messages.length > 0 && (
        <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg bg-zinc-50 p-3">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`rounded-lg px-3 py-2 text-sm ${
                msg.role === "user"
                  ? "ml-8 bg-blue-100 text-blue-900"
                  : "mr-8 bg-white text-zinc-700 shadow-sm"
              }`}
            >
              {msg.content}
            </div>
          ))}
          {loading && (
            <div className="mr-8 flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm text-zinc-500 shadow-sm">
              <div className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600" />
              Thinking...
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <Textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="e.g., 'increase stop loss to 1%' or 'add a 200-day MA filter'"
          disabled={loading}
          className="flex-1 resize-none"
        />
        <Button onClick={sendMessage} disabled={loading || !input.trim()}>
          Send
        </Button>
      </div>
    </div>
  );
}
